// Builds a throwaway Postgres (PGlite) from every migration before "More Bricks, and deleting one with Undo" (game
// #1996), saves a room bot and Bricks the way Orbit has them today, runs that migration, and prints what they look like
// after and what the database accepts for a deleted Brick and for a suggestion from then on.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111200000_brick_delete_undo';

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
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick1', 'sara', 'Brick', 'sara', '2026-02-03 04:05:06');
  INSERT INTO bots (id, owner_id, name, enabled, created_by_id, updated_at) VALUES ('brick2', 'sara', 'Off Brick', false, 'sara', '2026-02-03 04:05:06');
`);

const OLD = 'id, room_id, owner_id, name, enabled, created_by_id, updated_at';
const before = (await db.query(`SELECT ${OLD} FROM bots ORDER BY id`)).rows;
await run(TARGET);
const after = (await db.query(`SELECT ${OLD} FROM bots ORDER BY id`)).rows;
const newColumns = (await db.query('SELECT id, deleted_at, gone_at, enabled_before_delete, hello FROM bots ORDER BY id')).rows;

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};

const DELETE = `"deleted_at" = '2026-11-12 09:00:00', "gone_at" = '2026-11-19 09:00:00', "enabled_before_delete" = "enabled", "enabled" = false`;
const checks = {
  // The way Orbit deletes a Brick: marked, given its day, and switched off in one statement
  deleteABrick: await accepted(`UPDATE bots SET ${DELETE} WHERE id = 'brick1'`),
  // A deleted Brick is always off
  switchADeletedBrickOn: await accepted(`UPDATE bots SET enabled = true WHERE id = 'brick1'`),
  // Only a Brick waits deleted, never a bot in a room
  deleteARoomBot: await accepted(`UPDATE bots SET ${DELETE} WHERE id = 'bot1'`),
  // The mark, the day and the kept switch go together
  markWithoutADay: await accepted(`UPDATE bots SET deleted_at = now(), enabled = false WHERE id = 'brick2'`),
  dayWithoutAMark: await accepted(`UPDATE bots SET gone_at = now() WHERE id = 'brick2'`),
  keptSwitchWithoutAMark: await accepted(`UPDATE bots SET enabled_before_delete = true WHERE id = 'brick2'`),
  // A hello is at most 300 characters
  helloTooLong: await accepted(`UPDATE bots SET hello = repeat('x', 301) WHERE id = 'brick2'`),
  helloThatFits: await accepted(`UPDATE bots SET hello = repeat('x', 300) WHERE id = 'brick2'`),
};
const deleted = (await db.query(`SELECT enabled, enabled_before_delete, deleted_at IS NOT NULL AS marked FROM bots WHERE id = 'brick1'`)).rows[0];
// The way Orbit gives it back
checks.undo = await accepted(
  `UPDATE bots SET enabled = COALESCE(enabled_before_delete, true), deleted_at = NULL, gone_at = NULL, enabled_before_delete = NULL WHERE id = 'brick1'`
);
const undone = (await db.query(`SELECT enabled, enabled_before_delete, deleted_at, gone_at FROM bots WHERE id = 'brick1'`)).rows[0];

// A suggestion: one row per person and topic
const claim = async (user, topic) =>
  (await db.query(`INSERT INTO brick_offers (user_id, topic) VALUES ($1, $2) ON CONFLICT (user_id, topic) DO NOTHING RETURNING topic`, [user, topic])).rows.length;
const offers = {
  first: await claim('sara', 'recipes'),
  again: await claim('sara', 'recipes'),
  otherTopic: await claim('sara', 'workouts'),
  otherPerson: await claim('omar', 'recipes'),
  unknownPerson: await accepted(`INSERT INTO brick_offers (user_id, topic) VALUES ('nobody', 'recipes')`),
  topicTooLong: await accepted(`INSERT INTO brick_offers (user_id, topic) VALUES ('sara', repeat('x', 61))`),
};
const offeredAtIsSet = (await db.query('SELECT count(*)::int AS n FROM brick_offers WHERE offered_at IS NOT NULL AND answer IS NULL')).rows[0].n;
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const offersAfterAccountGone = (await db.query('SELECT user_id, topic FROM brick_offers ORDER BY user_id, topic')).rows;

console.log(JSON.stringify({ before, after, newColumns, checks, deleted, undone, offers, offeredAtIsSet, offersAfterAccountGone }));
await db.close();
