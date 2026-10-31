// Builds a throwaway Postgres (PGlite) from every migration before Voice settings (#740), saves universes the way Orbit has
// them today, runs that migration, and prints what they look like. It runs as its own process because PGlite loads itself
// with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261030230000_voice_settings';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, hide_bot_conversations, updated_at)
  VALUES ('u1', 'acme', 'Acme', 'owner', false, now()), ('u2', 'quiet', 'Quiet', 'owner', true, now());
`);
const universes = async () => (await db.query('SELECT id, slug, name, hide_bot_conversations, allow_voice_bots FROM universes ORDER BY id')).rows;
const before = (await db.query('SELECT id, slug, name, hide_bot_conversations FROM universes ORDER BY id')).rows;

await run(TARGET);
const once = await universes();

await db.exec(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u3', 'new', 'New', 'owner', now())`);
const created = (await db.query(`SELECT allow_voice_bots FROM universes WHERE id = 'u3'`)).rows[0];

console.log(JSON.stringify({ before, once, created }));
