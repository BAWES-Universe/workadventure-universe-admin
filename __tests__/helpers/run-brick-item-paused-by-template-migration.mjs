// Builds a throwaway Postgres (PGlite) from every migration before "paused by a template" (game #2008), saves goals and
// tasks the way Orbit has them today, runs that migration, and prints what it left alone and what the table accepts from then on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261114190000_brick_item_paused_by_template';

const db = new PGlite();
const names = fs.readdirSync(MIGRATIONS).filter((name) => /^\d/.test(name)).sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('sara', 'uuid-sara', now());
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Brick', now());
  INSERT INTO brick_items (id, owner_id, bot_id, kind, words, cadence, time_zone, state, paused_by, updated_at) VALUES
    ('i1', 'sara', 'brick1', 'reminder', 'one', '{"type":"none"}', 'UTC', 'on', NULL, now()),
    ('i2', 'sara', 'brick1', 'reminder', 'two', '{"type":"none"}', 'UTC', 'paused', 'owner', now()),
    ('i3', 'sara', 'brick1', 'reminder', 'three', '{"type":"none"}', 'UTC', 'paused', 'brick_deleted', now()),
    ('i4', 'sara', 'brick1', 'reminder', 'four', '{"type":"none"}', 'UTC', 'paused', 'goal', now());
`);
const rows = async () => (await db.query('SELECT * FROM brick_items ORDER BY id')).rows;
const before = await rows();
await run(TARGET);
const after = await rows();
const accepted = async (sql) => { try { await db.exec(sql); return true; } catch { return false; } };
const insert = (id, state, pausedBy, due = 'NULL') =>
  `INSERT INTO brick_items (id, owner_id, bot_id, kind, words, cadence, time_zone, state, paused_by, next_due_at, updated_at) VALUES ('${id}', 'sara', 'brick1', 'schedule', 'x', '{"type":"none"}', 'UTC', '${state}', ${pausedBy}, ${due}, now())`;
const checks = {
  pausedByTemplate: await accepted(insert('t1', 'paused', `'template'`)),
  pausedByOwner: await accepted(insert('t2', 'paused', `'owner'`)),
  pausedByNothing: await accepted(insert('t3', 'paused', 'NULL')),
  pausedByAnythingElse: await accepted(insert('t4', 'paused', `'maker'`)),
  templateRoutineWithATimeDue: await accepted(insert('t5', 'paused', `'template'`, 'now()')),
};
console.log(JSON.stringify({ before, after, checks }));
await db.close();
