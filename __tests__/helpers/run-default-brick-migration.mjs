// Builds a throwaway Postgres (PGlite) from every migration before "the Brick everyone gets" (game #1995), saves
// accounts, a room bot and a Brick the way Orbit has them today, runs that migration, and prints what they look like
// after and what the new table accepts and does from then on.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111170000_default_brick';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot1', 'room1', 'Nora', 'owner', '2026-01-02 03:04:05');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('made1', 'sara', 'Scout', 'sara', '2026-02-03 04:05:06');
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const rows = async () => (await db.query('SELECT user_id, bot_id FROM default_bricks ORDER BY user_id')).rows;
const rowsAfterMigration = await rows();

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};

// The way Orbit makes the Brick: the account's row first, then the bot, then the row is pointed at it.
await db.exec(`
  INSERT INTO default_bricks (user_id) VALUES ('sara');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick-sara', 'sara', 'Brick', 'sara', now());
  UPDATE default_bricks SET bot_id = 'brick-sara' WHERE user_id = 'sara';
  INSERT INTO default_bricks (user_id) VALUES ('omar');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick-omar', 'omar', 'Brick', 'omar', now());
  UPDATE default_bricks SET bot_id = 'brick-omar' WHERE user_id = 'omar';
`);
const secondClaim = (await db.query(`INSERT INTO default_bricks (user_id) VALUES ('sara') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`)).rows;
const checks = {
  // One row per account, one account per Brick, and only accounts and bots that exist
  secondRowForTheSameAccount: await accepted(`INSERT INTO default_bricks (user_id) VALUES ('sara')`),
  oneBrickForTwoAccounts: await accepted(`UPDATE default_bricks SET bot_id = 'brick-sara' WHERE user_id = 'omar'`),
  unknownAccount: await accepted(`INSERT INTO default_bricks (user_id) VALUES ('nobody')`),
  unknownBot: await accepted(`UPDATE default_bricks SET bot_id = 'no-such-bot' WHERE user_id = 'omar'`),
};
const rowsWhenMade = await rows();
const madeAtIsSet = (await db.query('SELECT count(*)::int AS n FROM default_bricks WHERE made_at IS NOT NULL')).rows[0].n;

// A Brick deleted on purpose: the account's row stays and points at nothing, which is how it is remembered
await db.exec(`DELETE FROM bots WHERE id = 'brick-sara'`);
const rowsAfterBrickDeleted = await rows();
const claimAfterDelete = (await db.query(`INSERT INTO default_bricks (user_id) VALUES ('sara') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`)).rows;

// The row goes with the account, and so does the account's Brick
await db.exec(`DELETE FROM users WHERE id = 'omar'`);
const rowsAfterAccountGone = await rows();
const botsAfterAccountGone = (await db.query('SELECT id FROM bots ORDER BY id')).rows.map((row) => row.id);

console.log(
  JSON.stringify({
    before,
    after,
    rowsAfterMigration,
    secondClaim,
    checks,
    rowsWhenMade,
    madeAtIsSet,
    rowsAfterBrickDeleted,
    claimAfterDelete,
    rowsAfterAccountGone,
    botsAfterAccountGone,
  })
);
await db.close();
