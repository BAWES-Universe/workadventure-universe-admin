// Builds a throwaway Postgres (PGlite) from every migration before "research on by default" (the launch defaults included, so the seeded
// values are there), then runs that migration on four starts: a deploy that still has the seeded values; one where a super admin already
// saved their own; one where the default for Instant Apps was ended; one where the ceiling was emptied. Prints what is saved after the first
// run and after a second one. Its own process, because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261126100000_research_on_by_default';

const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const target = names.indexOf(TARGET);
if (target < 0) throw new Error('The research defaults migration is missing');
const targetSql = fs.readFileSync(path.join(MIGRATIONS, TARGET, 'migration.sql'), 'utf8');

const start = async (setup) => {
  const db = new PGlite();
  // PGlite is one connection with no other sessions, so an index built CONCURRENTLY (two migrations do) is built the plain way here
  for (const name of names.slice(0, target)) await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/\bCONCURRENTLY\b/g, ''));
  if (setup) await db.exec(setup);
  return db;
};

const state = async (db) => ({
  limits: (await db.query(`SELECT value FROM app_settings WHERE key = 'instant-limits'`)).rows[0]?.value ?? null,
  rules: (await db.query(`SELECT id, program_id, version, state, funding_account_id, covers, benefit_kind, amount::text AS amount, schedule, share, recipient_type, settlement, created_by_id, (superseded_at IS NOT NULL) AS superseded, (claim_starts_at <= now()) AS started FROM grant_rules WHERE program_id IN (SELECT id FROM grant_programs WHERE category_id = 'instant_apps') ORDER BY program_id, version`)).rows,
  index: (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'instant_runs_person_id_task_key_idx'`)).rows.map((row) => row.indexdef),
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

const seeded = await scenario(null);

const own = await scenario(`
  UPDATE app_settings SET value = value || '{"exposureCeilingMicros":5000000,"maxRunsPerQuestion":3}'::jsonb WHERE key = 'instant-limits';
  UPDATE grant_rules SET state = 'superseded', superseded_at = now() WHERE id = 'seed-default-instant_apps-v1';
  INSERT INTO grant_rules (id, program_id, version, state, funding_account_id, covers, benefit_kind, amount, schedule, share, recipient_type, claim_starts_at, created_by_id)
    VALUES ('admin-v2', 'seed-default-instant_apps', 2, 'current', 'funding-platform', ARRAY['instant_apps']::text[], 'replace', 500000, 'monthly', 'each', 'all', now(), 'khalid');
`);

const ended = await scenario(`
  UPDATE grant_programs SET status = 'ended', ended_at = now() WHERE id = 'seed-default-instant_apps';
  UPDATE grant_rules SET state = 'ended', superseded_at = now() WHERE id = 'seed-default-instant_apps-v1';
`);

const emptied = await scenario(`
  UPDATE app_settings SET value = value - 'exposureCeilingMicros' WHERE key = 'instant-limits';
`);

// A database whose own time zone is not UTC (Kuwait, three hours ahead): every time written is UTC, as the columns hold, so the monthly
// credit starts now, not three hours from now
const kuwait = await (async () => {
  const db = await start(null);
  await db.exec(`SET TIME ZONE 'Asia/Kuwait'`);
  await db.exec(targetSql);
  const row = (await db.query(`SELECT to_char(claim_starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS starts, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created FROM grant_rules WHERE id = 'seed-default-instant_apps-v2'`)).rows[0];
  const v1 = (await db.query(`SELECT to_char(superseded_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS superseded FROM grant_rules WHERE id = 'seed-default-instant_apps-v1'`)).rows[0];
  return { startsAt: row?.starts ?? null, createdAt: row?.created ?? null, supersededAt: v1?.superseded ?? null, checkedAt: new Date().toISOString() };
})();

console.log(JSON.stringify({ seeded, own, ended, emptied, kuwait }));
