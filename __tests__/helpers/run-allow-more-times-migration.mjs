// Builds a throwaway Postgres (PGlite) from every migration before the "Allow more" times (game #1659), saves bots the way
// Orbit has them today, runs that migration, and prints what the new columns hold and which values they accept.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261104170000_allow_more_times';

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
`);
const before = (await db.query('SELECT id, name, enabled FROM bots ORDER BY id')).rows;
await run(TARGET);
const after = (await db.query('SELECT id, name, enabled, allow_more_idle_minutes, allow_more_max_minutes FROM bots ORDER BY id')).rows;

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const checks = {
  badIdle: await accepted(`UPDATE bots SET allow_more_idle_minutes = 45 WHERE id = 'bot1'`),
  badMax: await accepted(`UPDATE bots SET allow_more_max_minutes = 60 WHERE id = 'bot1'`),
  idleNull: await accepted(`UPDATE bots SET allow_more_idle_minutes = NULL WHERE id = 'bot1'`),
  goodIdle: await accepted(`UPDATE bots SET allow_more_idle_minutes = 120 WHERE id = 'bot1'`),
  goodMax: await accepted(`UPDATE bots SET allow_more_max_minutes = 1440 WHERE id = 'bot1'`),
};
const saved = (await db.query(`SELECT allow_more_idle_minutes, allow_more_max_minutes FROM bots WHERE id = 'bot1'`)).rows[0];

console.log(JSON.stringify({ before, after, checks, saved }));
