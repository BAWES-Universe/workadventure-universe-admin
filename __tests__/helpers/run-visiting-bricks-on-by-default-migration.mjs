// Builds a throwaway Postgres (PGlite) from every migration before "Visiting Bricks on by default" (game #2005), saves
// universes the way dev has them after the first Visiting Bricks migration (switch off, and one a host turned on), runs
// the migration, and prints what it turned on and what it left alone. It runs as its own process because PGlite loads
// itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261114120000_visiting_bricks_on_by_default';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at, allow_visiting_bricks, allow_voice_bots, hide_bot_conversations)
    VALUES ('u1', 'acme', 'Acme', 'owner', now(), false, true, false),
           ('u2', 'makers', 'Makers', 'owner', now(), false, false, true),
           ('u3', 'turned-on', 'Turned on', 'owner', now(), true, true, false);
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Brick', now());
  INSERT INTO brick_visits (user_id, bot_id, room_id) VALUES ('sara', 'brick1', 'room1');
`);

const otherColumns = async () => ({
  universes: (await db.query('SELECT id, slug, name, owner_id, allow_voice_bots, hide_bot_conversations FROM universes ORDER BY id')).rows,
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
  visits: (await db.query('SELECT user_id, bot_id, room_id FROM brick_visits ORDER BY user_id')).rows,
});
const switchesBefore = (await db.query('SELECT id, allow_visiting_bricks FROM universes ORDER BY id')).rows;
const before = await otherColumns();
await run(TARGET);
const after = await otherColumns();
const switchesAfter = (await db.query('SELECT id, allow_visiting_bricks FROM universes ORDER BY id')).rows;

// A universe made after the migration starts with the switch on, and a host can still turn it off
await db.exec(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u4', 'fresh', 'Fresh', 'owner', now())`);
const newUniverse = (await db.query(`SELECT allow_visiting_bricks FROM universes WHERE id = 'u4'`)).rows[0];
await db.exec(`UPDATE universes SET allow_visiting_bricks = false WHERE id = 'u1'`);
const hostTurnedOff = (await db.query(`SELECT allow_visiting_bricks FROM universes WHERE id = 'u1'`)).rows[0];

console.log(JSON.stringify({ switchesBefore, switchesAfter, before, after, newUniverse, hostTurnedOff }));
await db.close();
