// Builds a throwaway Postgres (PGlite) from every migration before "bringing a Brick along" (game #2005), saves
// universes, accounts, a room bot and a Brick the way Orbit has them today, runs that migration, and prints what it left
// alone and what the new switch and table accept and do from then on. It runs as its own process because PGlite loads
// itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112110000_visiting_bricks';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now()), ('u2', 'makers', 'Makers', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot1', 'room1', 'Nora', 'owner', '2026-01-02 03:04:05');
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Brick', now()), ('brick2', 'omar', 'Brick', now());
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
  universesWithoutTheSwitch: (await db.query('SELECT id, slug, name, owner_id FROM universes ORDER BY id')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const rowsAfterMigration = { visits: await count('brick_visits') };
const switches = (await db.query('SELECT id, allow_visiting_bricks FROM universes ORDER BY id')).rows;

// A universe made after the migration starts with the switch on
await db.exec(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u3', 'fresh', 'Fresh', 'owner', now())`);
const newUniverse = (await db.query(`SELECT allow_visiting_bricks FROM universes WHERE id = 'u3'`)).rows[0];

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};

const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'brick_visits' ORDER BY column_name`)).rows.map((row) => row.column_name);
await db.exec(`INSERT INTO brick_visits (user_id, bot_id, room_id) VALUES ('sara', 'brick1', 'room1')`);
const visitDefaults = (await db.query(`SELECT started_at IS NOT NULL AS has_start, seen_at IS NOT NULL AS has_seen FROM brick_visits WHERE user_id = 'sara'`)).rows[0];
const checks = {
  // One Brick walks with a person at a time, and a Brick walks with one person
  secondBrickForTheSamePerson: await accepted(`INSERT INTO brick_visits (user_id, bot_id) VALUES ('sara', 'brick2')`),
  theSameBrickForAnotherPerson: await accepted(`INSERT INTO brick_visits (user_id, bot_id) VALUES ('omar', 'brick1')`),
  anotherPersonsOwnBrick: await accepted(`INSERT INTO brick_visits (user_id, bot_id) VALUES ('omar', 'brick2')`),
  noPerson: await accepted(`INSERT INTO brick_visits (user_id, bot_id) VALUES ('nobody', 'brick2')`),
  noBot: await accepted(`INSERT INTO brick_visits (user_id, bot_id) VALUES ('owner', 'nothing')`),
};

// The room goes: the visit stays, with no place; nothing of the Brick goes
await db.exec(`DELETE FROM bots WHERE id = 'bot1'`);
await db.exec(`DELETE FROM rooms WHERE id = 'room1'`);
const afterRoomGone = (await db.query(`SELECT user_id, bot_id, room_id FROM brick_visits ORDER BY user_id`)).rows;
const bricksAfterRoomGone = await count(`bots WHERE owner_id IS NOT NULL`);

// The Brick goes: its visit goes. The person goes: so does theirs
await db.exec(`DELETE FROM bots WHERE id = 'brick2'`);
const visitsAfterBrickGone = await count('brick_visits');
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const visitsAfterPersonGone = await count('brick_visits');

console.log(JSON.stringify({ before, after, rowsAfterMigration, switches, newUniverse, columns, visitDefaults, checks, afterRoomGone, bricksAfterRoomGone, visitsAfterBrickGone, visitsAfterPersonGone }));
await db.close();
