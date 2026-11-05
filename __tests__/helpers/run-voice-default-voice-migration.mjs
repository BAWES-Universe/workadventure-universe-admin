// Builds a throwaway Postgres (PGlite) from every migration before the Universe AI default voice (game #1668), saves a server
// provider as Orbit has it today, runs that migration, and prints what the new columns hold.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261103210000_voice_default_voice';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO voice_providers (id, adapter, name, enabled, speech, default_speech, updated_at) VALUES ('server', 'elevenlabs', 'ElevenLabs', true, true, true, now());
`);
await run(TARGET);

const before = (await db.query(`SELECT id, default_voice_id, default_voice_name FROM voice_providers ORDER BY id`)).rows;
await db.exec(`UPDATE voice_providers SET default_voice_id = 'nora', default_voice_name = 'Nora' WHERE id = 'server'`);
const saved = (await db.query(`SELECT default_voice_id, default_voice_name FROM voice_providers WHERE id = 'server'`)).rows[0];

console.log(JSON.stringify({ before, saved }));
