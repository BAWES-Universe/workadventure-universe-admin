// Builds a throwaway Postgres (PGlite) from every migration before "a Brick that lives in a room" (game #2005), saves
// a room bot and Bricks the way Orbit has them today, runs that migration, and prints what it left alone and what the
// new table accepts and does from then on. Its own process because PGlite loads itself with dynamic imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112130000_brick_homes';

const db = new PGlite();
const names = fs.readdirSync(MIGRATIONS).filter((name) => /^\d/.test(name)).sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now()), ('room2', 'w1', 'cafe', 'Cafe', now());
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot1', 'room1', 'Nora', 'owner', '2026-01-02 03:04:05');
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Brick', now()), ('brick2', 'omar', 'Brick', now());
`);
const everything = async () => ({ users: (await db.query('SELECT * FROM users ORDER BY id')).rows, bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows, rooms: (await db.query('SELECT * FROM rooms ORDER BY id')).rows });
const before = await everything();
await run(TARGET);
const after = await everything();
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const rowsAfterMigration = { homes: await count('brick_homes') };
const accepted = async (sql) => { try { await db.exec(sql); return true; } catch { return false; } };

const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'brick_homes' ORDER BY column_name`)).rows.map((row) => row.column_name);
await db.exec(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick1', 'room1', 'sara', now())`);
const defaults = (await db.query(`SELECT behavior_type, behavior_config FROM brick_homes WHERE bot_id = 'brick1'`)).rows[0];
const checks = {
  secondHomeForTheSameBrick: await accepted(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick1', 'room2', 'sara', now())`),
  twoBricksInOneRoom: await accepted(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick2', 'room1', 'omar', now())`),
  noRoom: await accepted(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('bot1', 'nothing', 'omar', now())`),
  noBot: await accepted(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('nothing', 'room2', 'omar', now())`),
  noPerson: await accepted(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick2', 'room2', 'nobody', now())`),
};
// A Brick still has no room of its own, and a home never gives it one
const bricksWithARoom = await count(`bots WHERE owner_id IS NOT NULL AND room_id IS NOT NULL`);

// Deleting the room takes the homes in it and nothing else: the other Brick's home, in another room, stays
await db.exec(`DELETE FROM brick_homes WHERE bot_id = 'brick2'`);
await db.exec(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick2', 'room2', 'omar', now())`);
await db.exec(`DELETE FROM bots WHERE id = 'bot1'`);
await db.exec(`DELETE FROM rooms WHERE id = 'room1'`);
const homesAfterRoomGone = await count('brick_homes');
const bricksAfterRoomGone = await count(`bots WHERE owner_id IS NOT NULL`);
await db.exec(`INSERT INTO brick_homes (bot_id, room_id, placed_by_id, updated_at) VALUES ('brick1', 'room2', 'sara', now())`);
await db.exec(`DELETE FROM bots WHERE id = 'brick1'`);
const homesAfterBrickGone = await count('brick_homes');
await db.exec(`DELETE FROM users WHERE id = 'omar'`);
const homesAfterPersonGone = await count('brick_homes');

console.log(JSON.stringify({ before, after, rowsAfterMigration, columns, defaults, checks, bricksWithARoom, homesAfterRoomGone, bricksAfterRoomGone, homesAfterBrickGone, homesAfterPersonGone }));
await db.close();
