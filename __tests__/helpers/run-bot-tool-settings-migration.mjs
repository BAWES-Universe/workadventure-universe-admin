// Builds a throwaway Postgres (PGlite) from every migration before Bot tool settings (#738), saves bots and MCP servers
// the way Orbit has them today, runs that migration twice, and prints what they look like and which values the new
// columns accept. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261030210000_bot_tool_settings';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now()), ('bot2', 'room1', 'Atlas', now());
  INSERT INTO bot_mcp_servers (id, bot_id, name, server_url, updated_at)
  VALUES ('s1', 'bot1', 'Linear', 'https://linear.example/mcp', now()), ('s2', 'bot2', 'Notes', 'https://notes.example/mcp', now());
`);
const servers = async () =>
  (await db.query('SELECT id, name, enabled, legacy_text, look_up_setting, make_setting, change_setting, delete_send_setting, policy_revision FROM bot_mcp_servers ORDER BY id')).rows;
const bots = async () => (await db.query('SELECT id, name, enabled, ask_before_making, ask_which_way, card_wait_minutes FROM bots ORDER BY id')).rows;
const before = { servers: (await db.query('SELECT id, name, enabled FROM bot_mcp_servers ORDER BY id')).rows, bots: (await db.query('SELECT id, name, enabled FROM bots ORDER BY id')).rows };

await run(TARGET);
const once = { servers: await servers(), bots: await bots() };

// A server added after the migration waits for its tools to be confirmed
await db.exec(`INSERT INTO bot_mcp_servers (id, bot_id, name, server_url, updated_at) VALUES ('s3', 'bot1', 'New', 'https://new.example/mcp', now())`);
const created = (await db.query(`SELECT legacy_text, policy_revision FROM bot_mcp_servers WHERE id = 's3'`)).rows[0];

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const checks = {
  badServerSetting: await accepted(`UPDATE bot_mcp_servers SET make_setting = 'sometimes' WHERE id = 's1'`),
  offSetting: await accepted(`UPDATE bot_mcp_servers SET delete_send_setting = 'off' WHERE id = 's1'`),
  badAskBefore: await accepted(`UPDATE bots SET ask_before_making = 4 WHERE id = 'bot1'`),
  noLimit: await accepted(`UPDATE bots SET ask_before_making = NULL WHERE id = 'bot1'`),
  badWay: await accepted(`UPDATE bots SET ask_which_way = 'always' WHERE id = 'bot1'`),
  badWait: await accepted(`UPDATE bots SET card_wait_minutes = 7 WHERE id = 'bot1'`),
  goodWait: await accepted(`UPDATE bots SET card_wait_minutes = 30 WHERE id = 'bot1'`),
  badHeading: await accepted(
    `INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, heading, updated_at) VALUES ('t0', 's1', 'x', 'f', 'sends', now())`,
  ),
  confirmedWithoutHeading: await accepted(
    `INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, confirmed_at, updated_at) VALUES ('t0', 's1', 'x', 'f', now(), now())`,
  ),
  goodTool: await accepted(
    `INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, suggested_heading, suggestion_source, heading, confirmed_at, updated_at)
     VALUES ('t1', 's1', 'create_issue', 'f1', 'makesNew', 'server', 'makesNew', now(), now())`,
  ),
  sameNameTwice: await accepted(
    `INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, updated_at) VALUES ('t2', 's1', 'create_issue', 'f2', now())`,
  ),
  sameNameOtherServer: await accepted(
    `INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, updated_at) VALUES ('t3', 's2', 'create_issue', 'f2', now())`,
  ),
};
await db.exec(`DELETE FROM bot_mcp_servers WHERE id = 's2'`);
const toolsAfterServerDelete = (await db.query('SELECT id FROM bot_mcp_tools ORDER BY id')).rows.map((row) => row.id);

console.log(JSON.stringify({ before, once, created, checks, toolsAfterServerDelete }));
await db.close();
