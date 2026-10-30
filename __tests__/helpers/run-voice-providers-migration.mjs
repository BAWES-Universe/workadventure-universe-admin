// Builds a throwaway Postgres (PGlite) from every migration, adds voice providers (#740) and prints which values the new
// table accepts, most of all that only one provider can be the default for listening and one for speaking. It runs as its
// own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
for (const name of names) await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const add = (id, columns = '') =>
  `INSERT INTO voice_providers (id, adapter, name, updated_at${columns ? ', ' + columns.split('=')[0] : ''}) VALUES ('${id}', 'x', 'X', now()${columns ? ', ' + columns.split('=')[1] : ''})`;

const first = (await db.query(`INSERT INTO voice_providers (id, adapter, name, updated_at) VALUES ('p0', 'elevenlabs', 'ElevenLabs', now()) RETURNING recognition, speech, enabled, models, default_recognition, default_speech`)).rows[0];
const checks = {
  firstDefaultRecognition: await accepted(add('p1', 'default_recognition=true')),
  secondDefaultRecognition: await accepted(add('p2', 'default_recognition=true')),
  firstDefaultSpeech: await accepted(add('p3', 'default_speech=true')),
  secondDefaultSpeech: await accepted(add('p4', 'default_speech=true')),
  manyNotDefault: await accepted(add('p5')) && (await accepted(add('p6'))),
};
// Taking the default away lets another provider have it
await db.exec(`UPDATE voice_providers SET default_speech = false WHERE id = 'p3'`);
checks.speechDefaultAfterRelease = await accepted(add('p8', 'default_speech=true'));
const counts = (await db.query(`SELECT count(*) FILTER (WHERE default_recognition)::int AS recognition, count(*) FILTER (WHERE default_speech)::int AS speech FROM voice_providers`)).rows[0];

console.log(JSON.stringify({ first, checks, counts }));
