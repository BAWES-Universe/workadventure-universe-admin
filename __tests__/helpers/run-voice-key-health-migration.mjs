// Builds a throwaway Postgres (PGlite) from every migration before Voice key health (#749), saves a server provider and a
// person's key as Orbit has them today, runs that migration, and prints what the new columns hold for them.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261031010000_voice_key_health';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('ana', 'uuid-ana', now());
  INSERT INTO voice_providers (id, adapter, name, enabled, speech, updated_at) VALUES ('server', 'elevenlabs', 'ElevenLabs', true, true, now());
  INSERT INTO voice_providers (id, adapter, name, owner_id, speech, updated_at) VALUES ('mine', 'elevenlabs', 'Mine', 'ana', true, now());
`);
await run(TARGET);

const health = (await db.query(`SELECT id, down_since, down_reason, failed_calls, health_checked_at FROM voice_providers ORDER BY id`)).rows;
await db.exec(`UPDATE voice_providers SET down_since = now(), down_reason = 'credit', failed_calls = 2, health_checked_at = now() WHERE id = 'mine'`);
const down = (await db.query(`SELECT down_reason, failed_calls FROM voice_providers WHERE id = 'mine'`)).rows[0];

console.log(JSON.stringify({ health, down }));
