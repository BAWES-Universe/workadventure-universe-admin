// Builds a throwaway Postgres (PGlite) from every migration before the funding books, saves what Orbit has today (accounts, a universe,
// a saved setting, a meter gift), runs that migration, and prints what everything looks like after, and what the new tables accept and refuse.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261115050000_funding_books';

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
  INSERT INTO app_settings (key, value, updated_at) VALUES ('bot-limits', '{"fairUsage":{"signedIn":40}}', now());
  INSERT INTO meter_grants (id, grant_key, person_id, settlement, multiplier, no_limit, starts_at, ends_at, given_by_id) VALUES ('mg1', 'mg1', 'sara', 'gift', 2, false, '2026-11-10', '2026-11-20', 'owner');
`);

const everything = async () => ({
  users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
  universes: (await db.query('SELECT * FROM universes ORDER BY id')).rows,
  settings: (await db.query('SELECT * FROM app_settings ORDER BY key')).rows,
  meterGrants: (await db.query('SELECT * FROM meter_grants ORDER BY id')).rows,
});
const before = await everything();
await run(TARGET);
const after = await everything();

const one = async (sql) => (await db.query(sql)).rows;
const counts = {
  lots: (await one('SELECT count(*)::int AS n FROM credit_lots'))[0].n,
  holds: (await one('SELECT count(*)::int AS n FROM credit_holds'))[0].n,
  programs: (await one('SELECT count(*)::int AS n FROM grant_programs'))[0].n,
  rules: (await one('SELECT count(*)::int AS n FROM grant_rules'))[0].n,
};
const categories = await one('SELECT id, benefit, unit, pays FROM credit_categories ORDER BY id');
const accounts = await one('SELECT id, kind, owner_key, name, status FROM funding_accounts');

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? `ARRAY[${v.map((x) => `'${x}'`).join(',')}]::text[]` : `'${v}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(lit).join(', ')})`;

const program = (id, over = {}) => insert('grant_programs', { id, category_id: 'instant_apps', kind: 'gift', label: 'x', created_by_id: 'owner', ...over });
const rule = (id, over = {}) =>
  insert('grant_rules', { id, program_id: 'p1', version: 1, funding_account_id: 'funding-platform', covers: ['instant_apps'], benefit_kind: 'add_credit', amount: 5000000, schedule: 'once', share: 'each', recipient_type: 'people', claim_starts_at: '2026-11-15', created_by_id: 'owner', ...over });
const lot = (id, over = {}) =>
  insert('credit_lots', { id, slot_key: `gift:${id}`, subject_key: 'person:sara', period_key: 'gift', funding_account_id: 'funding-platform', person_id: 'sara', source: 'gift', amount_micros: 1000000, covers: ['instant_apps'], starts_at: '2026-11-15', ...over });
const hold = (id, over = {}) => insert('credit_holds', { id, hold_key: id, person_id: 'sara', category: 'instant_apps', charge_class: 'instant_run', amount_micros: 1000000, state: 'held', expires_at: '2026-11-16', ...over });

const checks = {
  programOk: await accepted(program('p1')),
  programOtherKind: await accepted(program('p2', { kind: 'present' })),
  defaultOk: await accepted(program('d1', { kind: 'default', category_id: 'computers' })),
  secondActiveDefault: await accepted(program('d2', { kind: 'default', category_id: 'computers' })),
  endedDefaultThenOk: await (async () => {
    await db.exec(`UPDATE grant_programs SET status = 'ended' WHERE id = 'd1'`);
    return accepted(program('d3', { kind: 'default', category_id: 'computers' }));
  })(),
  requestKeyOnce: await (async () => {
    await accepted(program('rk1', { request_key: 'abc' }));
    return accepted(program('rk2', { request_key: 'abc' }));
  })(),
  ruleOk: await accepted(rule('r1')),
  secondCurrentRule: await accepted(rule('r2', { version: 2 })),
  supersededThenOk: await (async () => {
    await db.exec(`UPDATE grant_rules SET state = 'superseded' WHERE id = 'r1'`);
    return accepted(rule('r3', { version: 3 }));
  })(),
  sameVersionTwice: await accepted(rule('r4', { version: 3, state: 'superseded' })),
  roleRecipient: await accepted(rule('r5', { version: 5, state: 'superseded', recipient_type: 'role' })),
  noGrantWithAmount: await accepted(rule('r6', { version: 6, state: 'superseded', schedule: 'none', amount: 5 })),
  grantWithoutAmount: await accepted(rule('r7', { version: 7, state: 'superseded', amount: 0 })),
  billedNeedsAgreement: await accepted(rule('r8', { version: 8, state: 'superseded', settlement: 'to_bill' })),
  changingNeedsCaps: await accepted(rule('r9', { version: 9, state: 'superseded', recipient_type: 'universe', recipient_universe_id: 'u1', recipient_mode: 'changing' })),
  claimEndsBeforeStart: await accepted(rule('r10', { version: 10, state: 'superseded', claim_ends_at: '2026-11-01' })),
  lotOk: await accepted(lot('l1')),
  sameLotTwice: await accepted(lot('l1b', { slot_key: 'gift:l1' })),
  zeroLot: await accepted(lot('l2', { amount_micros: 0 })),
  negativeLot: await accepted(lot('l3', { amount_micros: -5 })),
  lotWithoutPerson: await accepted(lot('l4', { person_id: null })),
  poolWithPerson: await accepted(lot('l5', { subject_key: 'pool:p1' })),
  lotOtherSource: await accepted(lot('l6', { source: 'loan' })),
  lotNoCovers: await accepted(lot('l7', { covers: [] })),
  lotEndsBeforeStart: await accepted(lot('l8', { expires_at: '2026-11-01' })),
  billedFreeLot: await accepted(lot('l9', { billed_at: '2026-11-16' })),
  holdOk: await accepted(hold('h1')),
  holdKeyTwice: await accepted(hold('h1b', { hold_key: 'h1' })),
  holdForReplies: await accepted(hold('h2', { category: 'universe_ai' })),
  holdOfNothing: await accepted(hold('h3', { amount_micros: 0 })),
  chargedMoreThanHeld: await accepted(hold('h4', { state: 'settled', customer_micros: 2000000 })),
  settledWithoutCharge: await accepted(hold('h5', { state: 'settled' })),
  refundedMoreThanCharged: await accepted(hold('h6', { state: 'settled', customer_micros: 100, refunded_micros: 200 })),
  effectKeyOnce: await (async () => {
    await accepted(hold('h7', { effect_key: 'e1' }));
    return accepted(hold('h8', { effect_key: 'e1' }));
  })(),
  effectKeyAfterRelease: await (async () => {
    await accepted(hold('h9', { effect_key: 'e2', state: 'released' }));
    return accepted(hold('h10', { effect_key: 'e2' }));
  })(),
  effectKeyReleasedTwice: await (async () => {
    await accepted(hold('h11', { effect_key: 'e3', state: 'released' }));
    return accepted(hold('h12', { effect_key: 'e3', state: 'released' }));
  })(),
  accountOwnerForPlatform: await accepted(insert('funding_accounts', { id: 'fa1', kind: 'platform', owner_key: 'someone', name: 'x' })),
  personAccountOk: await accepted(insert('funding_accounts', { id: 'fa2', kind: 'person', owner_key: 'sara', name: 'Sara' })),
  accountOtherKind: await accepted(insert('funding_accounts', { id: 'fa3', kind: 'company', owner_key: 'x', name: 'x' })),
  negativeBudget: await accepted(insert('funding_accounts', { id: 'fa4', kind: 'person', owner_key: 'omar', name: 'x', budget_micros: -1 })),
  secondPlatform: await accepted(insert('funding_accounts', { id: 'fa5', kind: 'platform', owner_key: 'platform', name: 'again' })),
};

console.log(JSON.stringify({ before, after, counts, categories, accounts, checks }));
