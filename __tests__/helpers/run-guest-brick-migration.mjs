// Builds a throwaway Postgres (PGlite) from every migration before "the Brick for guests" (game #1997), saves accounts
// and a room bot the way Orbit has them today, runs that migration, and prints what it left alone and what the new
// tables accept and do from then on. It runs as its own process because PGlite loads itself with dynamic imports,
// which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111220000_guest_brick';

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
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
  usage: (await db.query('SELECT count(*)::int AS n FROM bots_ai_usage')).rows,
  windows: (await db.query('SELECT count(*)::int AS n FROM reply_windows')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const rowsAfterMigration = { replies: await count('guest_brick_replies'), handovers: await count('guest_brick_handovers') };

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};

await db.exec(`INSERT INTO guest_brick_replies (id, turn_id, universe_key, guest_key) VALUES ('r1', 'turn-1', 'u1', 'guest-a')`);
const replyDefaults = (await db.query(`SELECT failed, tokens_used, cost_micros, created_at IS NOT NULL AS has_time FROM guest_brick_replies WHERE id = 'r1'`)).rows[0];
const replyColumns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'guest_brick_replies' ORDER BY column_name`)).rows.map((row) => row.column_name);
const checks = {
  sameTurnTwice: await accepted(`INSERT INTO guest_brick_replies (id, turn_id, universe_key, guest_key) VALUES ('r2', 'turn-1', 'u1', 'guest-a')`),
  // A room in no universe is counted as "outside"; no foreign key to a universe, so a universe that goes keeps no claim on its totals
  outsideUniverse: await accepted(`INSERT INTO guest_brick_replies (id, turn_id, universe_key, guest_key) VALUES ('r3', 'turn-3', 'outside', 'guest-b')`),
  firstHandover: await accepted(`INSERT INTO guest_brick_handovers (guest_key, user_id) VALUES ('guest-a', 'sara')`),
  sameGuestToAnotherAccount: await accepted(`INSERT INTO guest_brick_handovers (guest_key, user_id) VALUES ('guest-a', 'omar')`),
  unknownAccount: await accepted(`INSERT INTO guest_brick_handovers (guest_key, user_id) VALUES ('guest-z', 'nobody')`),
};
const secondClaim = (await db.query(`INSERT INTO guest_brick_handovers (guest_key, user_id) VALUES ('guest-a', 'omar') ON CONFLICT (guest_key) DO NOTHING RETURNING guest_key`)).rows;
const handover = (await db.query(`SELECT guest_key, user_id, carried_at, claimed_at IS NOT NULL AS has_time FROM guest_brick_handovers`)).rows;

// The hand-over goes with the account; the totals stay
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const handoversAfterAccountGone = await count('guest_brick_handovers');
const repliesAfterAccountGone = await count('guest_brick_replies');

console.log(JSON.stringify({ before, after, rowsAfterMigration, replyDefaults, replyColumns, checks, secondClaim, handover, handoversAfterAccountGone, repliesAfterAccountGone }));
await db.close();
