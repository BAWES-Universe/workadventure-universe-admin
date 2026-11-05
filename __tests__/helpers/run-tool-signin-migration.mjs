// Builds a throwaway Postgres (PGlite) from every migration before "tool sign-in expired" (game #1819), saves a tool server and
// a notice the way Orbit has them today, runs that migration, and prints what the new columns hold and how "connected by" behaves.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261105110000_tool_signin_expired';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('yousef', 'uuid-yousef', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now());
  INSERT INTO bot_mcp_servers (id, bot_id, name, server_url, updated_at) VALUES ('srv1', 'bot1', 'Tavily', 'https://mcp.tavily.example', now());
  INSERT INTO user_notices (id, user_id, kind, dedupe_key, title, body) VALUES ('n1', 'owner', 'ai-key-down', 'down:k:1', 'A key is down', 'Since 2 PM');
`);
await run(TARGET);

const server = (await db.query(`SELECT sign_in_lost_at, sign_in_lost_status, no_answer_at, reconnected_at, connected_by_id FROM bot_mcp_servers WHERE id = 'srv1'`)).rows[0];
const notice = (await db.query(`SELECT title, data FROM user_notices WHERE id = 'n1'`)).rows[0];

await db.exec(`UPDATE bot_mcp_servers SET connected_by_id = 'yousef', sign_in_lost_at = now(), sign_in_lost_status = 401 WHERE id = 'srv1'`);
const connected = (await db.query(`SELECT connected_by_id, sign_in_lost_status FROM bot_mcp_servers WHERE id = 'srv1'`)).rows[0];
let badPerson = true;
try {
  await db.exec(`UPDATE bot_mcp_servers SET connected_by_id = 'nobody' WHERE id = 'srv1'`);
} catch {
  badPerson = false;
}
await db.exec(`DELETE FROM users WHERE id = 'yousef'`);
const afterDelete = (await db.query(`SELECT connected_by_id, sign_in_lost_status FROM bot_mcp_servers WHERE id = 'srv1'`)).rows[0];

console.log(JSON.stringify({ server, notice, connected, badPerson, afterDelete }));
