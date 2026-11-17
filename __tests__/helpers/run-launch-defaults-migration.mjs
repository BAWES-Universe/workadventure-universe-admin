// Builds a throwaway Postgres (PGlite) from every migration before the launch defaults, then runs that migration on three starts
// (a fresh deploy; a deploy where people already set their own values; a deploy where someone ended a default and set a monthly
// allowance for later) and prints what is saved after, and after running it a second time.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261116220000_launch_defaults';

const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const target = names.indexOf(TARGET);
if (target < 0) throw new Error('The launch defaults migration is missing');
const targetSql = fs.readFileSync(path.join(MIGRATIONS, TARGET, 'migration.sql'), 'utf8');

const start = async (setup) => {
  const db = new PGlite();
  for (const name of names.slice(0, target)) await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
  if (setup) await db.exec(setup);
  return db;
};

const state = async (db) => ({
  settings: Object.fromEntries((await db.query(`SELECT key, value FROM app_settings WHERE key IN ('meter', 'instant-limits') ORDER BY key`)).rows.map((row) => [row.key, row.value])),
  programs: (await db.query(`SELECT id, category_id, kind, label, status, created_by_id FROM grant_programs ORDER BY id`)).rows,
  rules: (await db.query(`SELECT program_id, version, state, funding_account_id, covers, benefit_kind, amount::text AS amount, schedule, share, recipient_type, settlement FROM grant_rules ORDER BY program_id, version`)).rows,
});

const scenario = async (setup) => {
  const db = await start(setup);
  const before = await state(db);
  await db.exec(targetSql);
  const once = await state(db);
  await db.exec(targetSql);
  const twice = await state(db);
  return { before, once, twice };
};

const fresh = await scenario(null);

const own = await scenario(`
  INSERT INTO app_settings (key, value, updated_at) VALUES
    ('meter', '{"memberAllowanceMicros":777000,"poolCeilingMicros":4000000,"atOnceMember":2,"rolloutBudgetMicros":0,"appUseMicros":1500}', now()),
    ('instant-limits', '{"maxRunMicros":99000,"goodwillBudgetMicros":5000,"sentWaitMinutes":9}', now());
  INSERT INTO grant_programs (id, category_id, kind, label, created_by_id) VALUES ('own-instant', 'instant_apps', 'default', 'Mine', 'someone');
  INSERT INTO grant_rules (id, program_id, version, funding_account_id, covers, benefit_kind, amount, schedule, share, recipient_type, claim_starts_at, created_by_id)
    VALUES ('own-instant-r1', 'own-instant', 1, 'funding-platform', ARRAY['instant_apps']::text[], 'replace', 0, 'none', 'each', 'all', '2026-11-10', 'someone');
`);

const ended = await scenario(`
  INSERT INTO app_settings (key, value, updated_at) VALUES ('meter', '{"memberAllowanceLater":{"micros":900000,"from":"2026-12-01T00:00:00.000Z"}}', now());
  INSERT INTO grant_programs (id, category_id, kind, label, created_by_id, status, ended_at) VALUES ('old-computers', 'computers', 'default', 'Old', 'someone', 'ended', now());
`);

console.log(JSON.stringify({ fresh, own, ended }));
