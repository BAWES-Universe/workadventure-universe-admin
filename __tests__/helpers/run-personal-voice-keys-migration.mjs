// Builds a throwaway Postgres (PGlite) from every migration before Personal voice keys (#749), saves a server voice provider the
// way Orbit has it today, runs that migration, and prints what it looks like and which values the new column and table accept.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261031000000_personal_voice_keys';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('ana', 'uuid-ana', now()), ('ben', 'uuid-ben', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'ben', now()), ('u2', 'zed', 'Zed', 'ben', now());
  INSERT INTO voice_providers (id, adapter, name, enabled, speech, default_speech, updated_at) VALUES ('server', 'elevenlabs', 'ElevenLabs', true, true, true, now());
`);
const before = (await db.query(`SELECT id, adapter, name, enabled, default_speech FROM voice_providers`)).rows;

await run(TARGET);
const server = (await db.query(`SELECT id, adapter, name, enabled, default_speech, owner_id FROM voice_providers`)).rows;

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const key = (id, owner, columns = '') =>
  `INSERT INTO voice_providers (id, adapter, name, owner_id, updated_at${columns ? ', ' + columns.split('=')[0] : ''}) VALUES ('${id}', 'deepgram', 'Mine', ${owner}, now()${columns ? ', ' + columns.split('=')[1] : ''})`;
const checks = {
  personalKey: await accepted(key('k1', `'ana'`)),
  keyForNoOne: await accepted(key('k2', `'nobody'`)),
  personalDefaultListening: await accepted(key('k3', `'ana'`, 'default_recognition=true')),
  personalDefaultSpeaking: await accepted(key('k4', `'ana'`, 'default_speech=true')),
  serverKeyStillDefault: await accepted(key('k5', 'NULL', 'default_recognition=true')),
  lend: await accepted(`INSERT INTO voice_key_lends (id, provider_id, universe_id) VALUES ('l1', 'k1', 'u1')`),
  sameLendTwice: await accepted(`INSERT INTO voice_key_lends (id, provider_id, universe_id) VALUES ('l2', 'k1', 'u1')`),
  sameKeyAnotherUniverse: await accepted(`INSERT INTO voice_key_lends (id, provider_id, universe_id, models) VALUES ('l3', 'k1', 'u2', '["speech:flash"]')`),
  lendOfNoKey: await accepted(`INSERT INTO voice_key_lends (id, provider_id, universe_id) VALUES ('l4', 'nope', 'u1')`),
  lendToNoUniverse: await accepted(`INSERT INTO voice_key_lends (id, provider_id, universe_id) VALUES ('l5', 'k1', 'nope')`),
};
const allModels = (await db.query(`SELECT models FROM voice_key_lends WHERE id = 'l1'`)).rows[0].models;

// A universe that goes takes its lends, a key that goes takes its lends, and a person who goes takes their keys and so their lends
await db.exec(`DELETE FROM universes WHERE id = 'u2'`);
const afterUniverse = (await db.query(`SELECT count(*)::int AS n FROM voice_key_lends`)).rows[0].n;
await db.exec(`INSERT INTO voice_providers (id, adapter, name, owner_id, updated_at) VALUES ('k6', 'cartesia', 'Other', 'ana', now())`);
await db.exec(`INSERT INTO voice_key_lends (id, provider_id, universe_id) VALUES ('l6', 'k6', 'u1')`);
await db.exec(`DELETE FROM voice_providers WHERE id = 'k6'`);
const afterKey = (await db.query(`SELECT count(*)::int AS n FROM voice_key_lends`)).rows[0].n;
await db.exec(`DELETE FROM users WHERE id = 'ana'`);
const left = (await db.query(`SELECT (SELECT count(*)::int FROM voice_providers WHERE owner_id = 'ana') AS keys, (SELECT count(*)::int FROM voice_key_lends) AS lends, (SELECT count(*)::int FROM voice_providers WHERE id = 'server') AS server`)).rows[0];

console.log(JSON.stringify({ before, server, checks, allModels, afterUniverse, afterKey, left }));
