// Builds a throwaway Postgres (PGlite) from every migration before "room_since" on a visit (game #2005), saves a visit the
// way Orbit has it today, runs that migration, and prints what it left alone and what the new column accepts. It runs as its
// own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112124000_visit_room_since';

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
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Brick', now());
  INSERT INTO brick_visits (user_id, bot_id, room_id) VALUES ('sara', 'brick1', 'room1');
`);
const before = (await db.query('SELECT user_id, bot_id, room_id, started_at, seen_at FROM brick_visits')).rows;

await run(TARGET);
const after = (await db.query('SELECT user_id, bot_id, room_id, started_at, seen_at FROM brick_visits')).rows;
const rows = (await db.query('SELECT room_since FROM brick_visits')).rows;
const column = (await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'brick_visits' AND column_name = 'room_since'")).rows[0];
await db.exec(`UPDATE brick_visits SET room_since = '2026-11-12 10:00:00'`);
const written = (await db.query('SELECT room_since FROM brick_visits')).rows[0].room_since;
console.log(JSON.stringify({ before, after, since: rows[0].room_since, nullable: column?.is_nullable, written: written instanceof Date ? written.toISOString() : String(written) }));
