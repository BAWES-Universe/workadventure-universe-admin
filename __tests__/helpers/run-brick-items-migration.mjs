// Builds a throwaway Postgres (PGlite) from every migration before "goals and tasks" (game #2002), saves accounts and Bricks
// the way Orbit has them today, runs that migration, and prints what it left alone and what the new tables accept and do from
// then on. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112080000_brick_items';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick-sara', 'sara', 'Brick', '2026-01-02 03:04:05'), ('brick-omar', 'omar', 'Brick', '2026-01-02 03:04:05');
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const rowsAfterMigration = { items: await count('brick_items'), runs: await count('brick_item_runs') };

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const item = (id, over = '') =>
  `INSERT INTO brick_items (id, owner_id, bot_id, kind, words, cadence, time_zone, updated_at${over ? ', ' + over.split('|')[0] : ''}) VALUES ('${id}', 'sara', 'brick-sara', 'reminder', 'Call the dentist', '{"type":"once","at":"2026-11-12T07:00:00.000Z"}', 'Asia/Kuwait', now()${over ? ', ' + over.split('|')[1] : ''})`;

const checks = {
  firstItem: await accepted(item('i1')),
  unknownKind: await accepted(item('i2').replace("'reminder'", "'chore'")),
  unknownState: await accepted(item('i3', "state|'sleeping'")),
  dueOnlyWhenOn: await accepted(item('i4', "state, next_due_at|'paused', now()")),
  dueWhenOn: await accepted(item('i5', "next_due_at|now()")),
  unknownOwner: await accepted(item('i6').replace("'sara'", "'nobody'")),
  firstRun: await accepted(`INSERT INTO brick_item_runs (id, item_id, due_at, revision, lease_until) VALUES ('r1', 'i1', '2026-11-12 07:00:00', 1, now())`),
  sameDueTimeTwice: await accepted(`INSERT INTO brick_item_runs (id, item_id, due_at, revision, lease_until) VALUES ('r2', 'i1', '2026-11-12 07:00:00', 1, now())`),
  nextDueTime: await accepted(`INSERT INTO brick_item_runs (id, item_id, due_at, revision, lease_until) VALUES ('r3', 'i1', '2026-11-13 07:00:00', 1, now())`),
  unknownRunState: await accepted(`INSERT INTO brick_item_runs (id, item_id, due_at, revision, lease_until, state) VALUES ('r4', 'i1', '2026-11-14 07:00:00', 1, now(), 'lost')`),
};
const defaults = (await db.query(`SELECT state, set_by, revision, failures_in_row, steps FROM brick_items WHERE id = 'i1'`)).rows[0];

// Deleting a person or a Brick for good takes its items and their runs with it
await db.exec(`DELETE FROM bots WHERE id = 'brick-sara'`);
const afterBrickGone = { items: await count('brick_items'), runs: await count('brick_item_runs') };

console.log(JSON.stringify({ before, after, rowsAfterMigration, checks, defaults, afterBrickGone }));
await db.close();
