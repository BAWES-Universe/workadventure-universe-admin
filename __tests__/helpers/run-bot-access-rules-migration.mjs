// Builds a throwaway Postgres (PGlite) from every migration before per-bot rules (#427), saves bots the way Orbit has
// them today, runs the per-bot rules migration, and prints what the bots look like after plus what the database
// refuses in a rules row. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does
// not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261019100000_bot_access_rules';
const CAPS = '20261019120000_bot_reply_caps_optional';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now()), ('bot2', 'room1', 'Atlas', now());
  INSERT INTO roles (id, universe_id, key, name, permissions, position, built_in, updated_at)
  VALUES ('r-acc', 'u1', 'accountant', 'Accountant', 0, 10, false, now());
`);
const botsBefore = (await db.query('SELECT id, name, enabled, behavior_type FROM bots ORDER BY id')).rows;
await run(TARGET);
const botsAfter = (await db.query('SELECT id, name, enabled, behavior_type, private_bot, refusal_reply, daily_reply_cap FROM bots ORDER BY id')).rows;

const attempt = async (sql) => {
  try {
    await db.exec(sql);
    return 'accepted';
  } catch (error) {
    return String(error.message);
  }
};
const insert = (cols, vals) => `INSERT INTO bot_access_rules (id, bot_id, ${cols}, updated_at) VALUES (gen_random_uuid()::text, ${vals}, now())`;

const results = {
  botsBefore,
  botsAfter,
  roleRow: await attempt(insert('role_id, allow, deny', "'bot1', 'r-acc', 16384, 65536")),
  personRow: await attempt(insert('user_id, allow', "'bot1', 'sara', 32768")),
  bothSubjects: await attempt(insert('role_id, user_id', "'bot2', 'r-acc', 'sara'")),
  noSubject: await attempt(insert('allow', "'bot2', 0")),
  overlap: await attempt(insert('role_id, allow, deny', "'bot2', 'r-acc', 16384, 16384")),
  outsideBits: await attempt(insert('role_id, allow', "'bot2', 'r-acc', 256")),
  negative: await attempt(insert('role_id, allow', "'bot2', 'r-acc', -1")),
  twoRowsSameRole: await attempt(insert('role_id', "'bot1', 'r-acc'")),
  twoRowsSamePerson: await attempt(insert('user_id', "'bot1', 'sara'")),
  capZero: await attempt("UPDATE bots SET daily_reply_cap = 0 WHERE id = 'bot1'"),
  capTooBig: await attempt("UPDATE bots SET daily_reply_cap = 10001 WHERE id = 'bot1'"),
  capOk: await attempt("UPDATE bots SET daily_reply_cap = 10000 WHERE id = 'bot1'"),
  unknownBot: await attempt(insert('role_id', "'nope', 'r-acc'")),
};

// The follow-up: reply limits start empty. A 50 nobody chose goes; a number someone set stays.
await db.exec("UPDATE bots SET daily_reply_cap = 30 WHERE id = 'bot1'");
await run(CAPS);
results.capsAfter = (await db.query('SELECT id, daily_reply_cap FROM bots ORDER BY id')).rows;
await db.exec("INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot3', 'room1', 'Fresh', now())");
results.freshBot = (await db.query("SELECT daily_reply_cap FROM bots WHERE id = 'bot3'")).rows[0];
results.capNullOk = await attempt("UPDATE bots SET daily_reply_cap = NULL WHERE id = 'bot1'");
results.capStillZero = await attempt("UPDATE bots SET daily_reply_cap = 0 WHERE id = 'bot1'");
await db.exec("DELETE FROM bots WHERE id = 'bot3'");

// Deleting a role, a person or a bot takes their rows with it
const count = async () => (await db.query('SELECT count(*)::int AS n FROM bot_access_rules')).rows[0].n;
results.rowsBeforeDeletes = await count();
await db.exec("DELETE FROM roles WHERE id = 'r-acc'");
results.afterRoleDeleted = await count();
await db.exec("DELETE FROM users WHERE id = 'sara'");
results.afterPersonDeleted = await count();
await db.exec(insert('user_id', "'bot2', 'owner'"));
results.beforeBotDeleted = await count();
await db.exec("DELETE FROM bots WHERE id = 'bot2'");
results.afterBotDeleted = await count();

console.log(JSON.stringify(results, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
await db.close();
