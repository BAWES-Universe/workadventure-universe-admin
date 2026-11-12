// Builds a throwaway Postgres (PGlite) from every migration before the Brick computers (game #2000), saves what Orbit has today
// (accounts, a room bot, a Brick), runs that migration, and prints what everything looks like after, and what the new tables accept
// and refuse. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112090000_brick_computer';

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
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot1', 'room1', 'Nora', 'owner', '2026-01-02 03:04:05');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick1', 'sara', 'Scout', 'sara', '2026-02-03 04:05:06');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick2', 'sara', 'Other', 'sara', '2026-02-03 04:05:06');
  INSERT INTO bots (id, owner_id, name, created_by_id, updated_at)
    SELECT 'bm' || n, 'sara', 'Brick ' || n, 'sara', '2026-02-03 04:05:06' FROM generate_series(0, 7) AS n;
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const counts = async (botId) => {
  const where = botId ? `WHERE bot_id = '${botId}'` : '';
  return {
    computers: (await db.query(`SELECT count(*)::int AS n FROM brick_computers ${where}`)).rows[0].n,
    jobs: (await db.query(`SELECT count(*)::int AS n FROM computer_jobs ${where}`)).rows[0].n,
    effects: (await db.query(`SELECT count(*)::int AS n FROM computer_effects ${botId ? `WHERE job_id IN (SELECT id FROM computer_jobs WHERE bot_id = '${botId}')` : ''}`)).rows[0].n,
  };
};
const countsAfterMigration = await counts();

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const insert = (table, row) => {
  const keys = Object.keys(row);
  const value = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? v : `'${v}'`);
  return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => value(row[key])).join(', ')})`;
};
const computer = (id, over = {}) => insert('brick_computers', { id, bot_id: 'brick1', updated_at: '2026-11-12', ...over });
const job = (id, over = {}) => insert('computer_jobs', { id, bot_id: 'brick1', person_id: 'sara', title: 'Visa form', ...over });
const effect = (id, over = {}) => insert('computer_effects', { id, job_id: 'j1', effect_key: id, kind: 'send', ...over });

const checks = {
  firstComputer: await accepted(computer('c1')),
  secondComputerForTheSameBrick: await accepted(computer('c2')),
  computerForARoomBot: await accepted(computer('c3', { bot_id: 'bot1' })),
  computerForNobody: await accepted(computer('c4', { bot_id: 'nobody' })),
  startsNotMade: (await db.query(`SELECT machine, enabled, provider FROM brick_computers WHERE id = 'c1'`)).rows[0],
  everyMachineState: (await Promise.all(['none', 'waking', 'resting', 'working', 'cold', 'broken', 'restoring', 'stopped'].map((machine, i) => accepted(computer(`m${i}`, { bot_id: `bm${i}`, machine }))))).every(Boolean),
  anotherMachineState: await accepted(computer('x1', { bot_id: 'brick2', machine: 'sleeping' })),
  anotherProvider: await accepted(computer('x2', { bot_id: 'brick2', provider: 'cloud' })),
  negativeFiles: await accepted(computer('x3', { bot_id: 'brick2', files_bytes: -1 })),

  firstJob: await accepted(job('j1', { status: 'running' })),
  secondWriterRunning: await accepted(job('j2', { status: 'running' })),
  secondWriterWaiting: await accepted(job('j2b', { status: 'waiting', waiting_for: 'details' })),
  readOnlyAlongside: await accepted(job('j3', { status: 'running', writes: false })),
  queuedWriters: await accepted(job('j4', { status: 'queued', queued_for: 'turn' })) && (await accepted(job('j5', { status: 'queued', queued_for: 'allowance' }))),
  anotherStatus: await accepted(job('x4', { bot_id: 'brick2', status: 'sleeping' })),
  anotherQueuedFor: await accepted(job('x5', { bot_id: 'brick2', status: 'queued', queued_for: 'later' })),
  anotherEndedBy: await accepted(job('x6', { bot_id: 'brick2', status: 'stopped', ended_by: 'bored' })),
  anotherWaitingFor: await accepted(job('x7', { bot_id: 'brick2', status: 'waiting', waiting_for: 'coffee' })),
  anotherControl: await accepted(job('x8', { bot_id: 'brick2', control: 'robot' })),
  personHasTheMouseWhileRunning: await accepted(job('x9', { bot_id: 'brick2', status: 'running', control: 'person' })),
  personHasTheMouseWhileWaiting: await accepted(job('ok1', { bot_id: 'brick2', status: 'waiting', control: 'person', waiting_for: 'pay' })),
  stepsBackwards: await accepted(job('x10', { bot_id: 'brick2', status: 'queued', step_done: -1 })),
  stepsOfNothing: await accepted(job('x11', { bot_id: 'brick2', status: 'queued', step_total: 0 })),
  afterTheWriterEnds: await (async () => {
    await db.exec(`UPDATE computer_jobs SET status = 'done' WHERE id = 'j1'`);
    return accepted(job('j6', { status: 'running' }));
  })(),
  jobForNobody: await accepted(job('x12', { bot_id: 'nobody', status: 'queued' })),

  firstEffect: await accepted(effect('e1')),
  sameEffectTwice: await accepted(effect('e1b', { effect_key: 'e1' })),
  sameKeyOnAnotherJob: await accepted(insert('computer_effects', { id: 'e2', job_id: 'j3', effect_key: 'e1', kind: 'send' })),
  everyKind: (await Promise.all(['send', 'publish', 'details', 'upload', 'pay', 'submit'].map((kind) => accepted(effect(`k-${kind}`, { kind }))))).every(Boolean),
  anotherKind: await accepted(effect('x13', { kind: 'steal' })),
  everyState: (await Promise.all(['approved', 'planned', 'done', 'failed'].map((state) => accepted(effect(`s-${state}`, { state })))))
    .every(Boolean),
  anotherState: await accepted(effect('x14', { state: 'maybe' })),
};

// Deleting the Brick takes its computer, jobs and effects with it; the meter's books keep what happened (nothing here points at them)
await db.exec(`DELETE FROM bots WHERE id = 'brick1'`);
const afterBrickGone = await counts('brick1');

console.log(JSON.stringify({ before, after, countsAfterMigration, checks, afterBrickGone }));
await db.close();
