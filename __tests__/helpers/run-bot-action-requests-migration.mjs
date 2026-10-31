// Builds a throwaway Postgres (PGlite) from every migration up to and including saved bot actions (#739) and tries what the
// tables must refuse: an unknown status, a closed request with no reason, a second claimed attempt, a second request with
// the same key, a remembered approval for deleting or sending. It runs as its own process because PGlite loads itself with
// dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261030220000_bot_action_requests';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now());
`);
const tablesBefore = (await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'bot_action_%'`)).rows[0].n;
await run(TARGET);
const tablesAfter = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bot_action_%' ORDER BY 1`)).rows.map((r) => r.table_name);

const request = (id, extra = {}) => {
  const row = {
    id, bot_id: 'bot1', proposal_key: id, requester_key: 'user:sara', conversation_key: 'dm', tool_name: 't', heading: 'changesThings',
    tool_fingerprint: 'f', policy_revision: 1, arguments: 'x', arguments_digest: 'd', status: 'waiting', review_expires_at: new Date(), updated_at: new Date(), ...extra,
  };
  const keys = Object.keys(row);
  return db.query(`INSERT INTO bot_action_requests (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
};
const attempt = (id, requestId, no, state) =>
  db.query(`INSERT INTO bot_action_attempts (id, request_id, attempt_no, state, idempotency_key, lease_expires_at) VALUES ($1, $2, $3, $4, 'k', now())`, [id, requestId, no, state]);
const grant = (id, heading) =>
  db.query(
    `INSERT INTO bot_action_grants (id, bot_id, requester_key, conversation_key, tool_name, heading, tool_fingerprint, policy_revision, scope, idle_minutes, idle_expires_at, absolute_expires_at)
     VALUES ($1, 'bot1', 'user:sara', 'dm', 't', $2, 'f', 1, '{}', 60, now(), now())`,
    [id, heading],
  );
const accepted = async (fn) => {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
};
const now = new Date();

const checks = {
  waiting: await accepted(() => request('r1')),
  unknownStatus: await accepted(() => request('r2', { status: 'sent' })),
  unknownHeading: await accepted(() => request('r3', { heading: 'sends' })),
  closedWithoutReason: await accepted(() => request('r4', { status: 'closed', finished_at: now })),
  reasonWithoutClosed: await accepted(() => request('r5', { closed_reason: 'declined' })),
  closedWithReason: await accepted(() => request('r6', { status: 'closed', closed_reason: 'declined', finished_at: now })),
  unknownReason: await accepted(() => request('r7', { status: 'closed', closed_reason: 'whatever', finished_at: now })),
  doneWithoutFinishTime: await accepted(() => request('r8', { status: 'done' })),
  approvedWithoutStartBy: await accepted(() => request('r9', { status: 'approved' })),
  approvedWithStartBy: await accepted(() => request('r10', { status: 'approved', start_by: now })),
  couldntConfirm: await accepted(() => request('r11', { status: 'couldntConfirm' })),
  sameKeyTwice: await accepted(() => request('r1b', { proposal_key: 'r1' })),
  revisionZero: await accepted(() => request('r12', { revision: 0 })),
  firstClaimed: await accepted(() => attempt('a1', 'r10', 1, 'claimed')),
  secondClaimed: await accepted(() => attempt('a2', 'r10', 2, 'claimed')),
  secondAfterFinished: await accepted(async () => {
    await db.query(`UPDATE bot_action_attempts SET state = 'notSent' WHERE id = 'a1'`);
    await attempt('a3', 'r10', 3, 'claimed');
  }),
  sameAttemptNumber: await accepted(() => attempt('a4', 'r10', 3, 'notSent')),
  unknownAttemptState: await accepted(() => attempt('a5', 'r10', 9, 'maybe')),
  rememberChange: await accepted(() => grant('g1', 'changesThings')),
  rememberMake: await accepted(() => grant('g2', 'makesNew')),
  rememberDelete: await accepted(() => grant('g3', 'deletesOrSends')),
};
await db.query(`DELETE FROM bots WHERE id = 'bot1'`);
const left = {};
for (const table of ['bot_action_requests', 'bot_action_decisions', 'bot_action_attempts', 'bot_action_grants']) {
  left[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
}
console.log(JSON.stringify({ tablesBefore, tablesAfter, checks, leftAfterBotDeleted: left }));
await db.close();
