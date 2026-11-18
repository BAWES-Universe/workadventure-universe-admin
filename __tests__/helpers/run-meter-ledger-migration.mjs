// Builds a throwaway Postgres (PGlite) from every migration before the meter's books (game #1998), saves what Orbit has today
// (accounts, a room bot, a Brick, a usage row, a saved setting), runs that migration, and prints what everything looks like after,
// and what the new tables accept and refuse.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111190000_meter_ledger';

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
  INSERT INTO bots_ai_providers (provider_id, name, type, updated_at) VALUES ('p1', 'Server', 'openai', now());
  INSERT INTO bots_ai_usage (bot_id, provider_id, tokens_used) VALUES ('bot1', 'p1', 500);
  INSERT INTO app_settings (key, value, updated_at) VALUES ('bot-limits', '{"fairUsage":{"signedIn":40}}', now());
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows,
  usage: (await db.query('SELECT * FROM bots_ai_usage ORDER BY id')).rows,
  settings: (await db.query('SELECT * FROM app_settings ORDER BY key')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();
const counts = async () => ({
  events: (await db.query('SELECT count(*)::int AS n FROM meter_events')).rows[0].n,
  reservations: (await db.query('SELECT count(*)::int AS n FROM meter_reservations')).rows[0].n,
  grants: (await db.query('SELECT count(*)::int AS n FROM meter_grants')).rows[0].n,
});
const countsAfterMigration = await counts();

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const event = (id, over = {}) => {
  const row = { id, event_id: id, kind: 'app_use', pool: 'chat', occurred_at: '2026-11-11 10:00:00', person_key: 'person:sara', payer_kind: 'universe', quantity: 1, unit: 'use', basis: 'estimated', ...over };
  const keys = Object.keys(row);
  return `INSERT INTO meter_events (${keys.join(', ')}) VALUES (${keys.map((key) => (row[key] === null ? 'NULL' : typeof row[key] === 'number' ? row[key] : `'${row[key]}'`)).join(', ')})`;
};
const grant = (id, over = {}) => {
  const row = { id, grant_key: id, person_id: 'sara', settlement: 'gift', multiplier: 2, no_limit: false, starts_at: '2026-11-10', ends_at: '2026-11-20', given_by_id: 'admin', ...over };
  const keys = Object.keys(row);
  return `INSERT INTO meter_grants (${keys.join(', ')}) VALUES (${keys.map((key) => (row[key] === null ? 'NULL' : typeof row[key] === 'number' || typeof row[key] === 'boolean' ? row[key] : `'${row[key]}'`)).join(', ')})`;
};

const firstEvent = await accepted(event('e1'));
const checks = {
  firstEvent,
  sameEventIdTwice: await accepted(event('e1b', { event_id: 'e1' })),
  everyMark: (await Promise.all(['measured', 'estimated', 'paid_by_other', 'unknown'].map((basis, i) => accepted(event(`mark${i}`, { basis }))))).every(Boolean),
  anotherMark: await accepted(event('x1', { basis: 'probably' })),
  anotherKind: await accepted(event('x2', { kind: 'nap' })),
  anotherPool: await accepted(event('x3', { pool: 'both' })),
  anotherPayer: await accepted(event('x4', { payer_kind: 'nobody' })),
  negativeQuantity: await accepted(event('x5', { quantity: -1 })),
  negativeCost: await accepted(event('x6', { cost_micros: -1 })),
  nobodyInParticular: await accepted(event('x7', { person_key: 'sara' })),
  unknownPerson: await accepted(event('ok1', { person_key: 'unknown' })),
  guest: await accepted(event('ok2', { person_key: 'guest:wa-1' })),
  unknownPriceIsEmpty: await accepted(event('ok3', { cost_micros: null, basis: 'unknown' })),
  realZero: await accepted(event('ok4', { cost_micros: 0, basis: 'measured' })),
  twoReservationsOneKey: await (async () => {
    await db.exec(`INSERT INTO meter_reservations (id, reservation_key, person_key, amount_micros, state, expires_at) VALUES ('r1', 'k1', 'person:sara', 100, 'held', now())`);
    return accepted(`INSERT INTO meter_reservations (id, reservation_key, person_key, amount_micros, state, expires_at) VALUES ('r2', 'k1', 'person:sara', 100, 'held', now())`);
  })(),
  reservationOfNothing: await accepted(`INSERT INTO meter_reservations (id, reservation_key, person_key, amount_micros, state, expires_at) VALUES ('r3', 'k3', 'person:sara', 0, 'held', now())`),
  reservationInAnotherState: await accepted(`INSERT INTO meter_reservations (id, reservation_key, person_key, amount_micros, state, expires_at) VALUES ('r4', 'k4', 'person:sara', 5, 'maybe', now())`),
  giftIsAccepted: await accepted(grant('g1')),
  sameGrantKeyTwice: await accepted(grant('g1b', { grant_key: 'g1' })),
  toBillIsAccepted: await accepted(grant('g2', { settlement: 'to_bill', note: 'agreed' })),
  noLimitIsAccepted: await accepted(grant('g3', { multiplier: null, no_limit: true })),
  noLimitAndAMultiple: await accepted(grant('g4', { no_limit: true })),
  neitherMultipleNorNoLimit: await accepted(grant('g5', { multiplier: null })),
  oneTimesIsNotExtra: await accepted(grant('g6', { multiplier: 1 })),
  endsBeforeItStarts: await accepted(grant('g7', { ends_at: '2026-11-01' })),
  anotherSettlement: await accepted(grant('g8', { settlement: 'loan' })),
  giftBilled: await accepted(grant('g9', { billed_at: '2026-11-15' })),
  toBillBilled: await accepted(grant('g10', { settlement: 'to_bill', billed_at: '2026-11-15' })),
};

// The books keep what happened after a bot or a person is gone: nothing here points at them
await db.exec(event('keep1', { person_key: 'person:sara', bot_id: 'brick1' }));
await db.exec(`DELETE FROM bots WHERE id = 'brick1'`);
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const keptAfterDeletes = (await db.query(`SELECT event_id, bot_id, person_key FROM meter_events WHERE event_id = 'keep1'`)).rows;
const grantsAfterPersonGone = (await db.query(`SELECT count(*)::int AS n FROM meter_grants WHERE person_id = 'sara'`)).rows[0].n;

console.log(JSON.stringify({ before, after, countsAfterMigration, checks, keptAfterDeletes, grantsAfterPersonGone }));
await db.close();
