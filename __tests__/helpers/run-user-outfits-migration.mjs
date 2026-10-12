// Builds a throwaway Postgres (PGlite) from every migration before the user-outfits one, saves outfits for a few people
// the way the old rule did (one row per person and world), runs the user-outfits migration and prints what it made as JSON.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261012100000_user_outfits';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
for (const name of names.slice(0, names.indexOf(TARGET))) {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
}

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('ann', 'uuid-ann', now()), ('bob', 'uuid-bob', now()), ('cy', 'uuid-cy', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni1', 'acme', 'Acme', 'ann', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES
    ('w1', 'uni1', 'one', 'One', now()), ('w2', 'uni1', 'two', 'Two', now()), ('w3', 'uni1', 'three', 'Three', now());

  -- Ann: the same outfit in two worlds (picked at different times), a different one later, and an empty row
  INSERT INTO user_avatars (id, user_id, world_id, texture_ids, outfit_updated_at, updated_at, companion_texture_id) VALUES
    ('a1', 'ann', 'w1', ARRAY['male1','hat1'], '2026-10-01 10:00:00', '2026-10-01 10:00:00', 'dog1'),
    ('a2', 'ann', 'w2', ARRAY['male1','hat1'], '2026-10-03 10:00:00', '2026-10-09 10:00:00', 'cat1'),
    ('a3', 'ann', 'w3', ARRAY['male2'],       '2026-10-05 10:00:00', '2026-10-05 10:00:00', NULL);
  -- Bob: one outfit, no outfit time recorded (older rows), no companion
  INSERT INTO user_avatars (id, user_id, world_id, texture_ids, outfit_updated_at, updated_at) VALUES
    ('b1', 'bob', 'w1', ARRAY['male3'], NULL, '2026-09-20 08:00:00'),
    ('b2', 'bob', 'w2', ARRAY[]::text[], NULL, '2026-10-10 08:00:00');
  -- Cy: only a companion, never picked an outfit
  INSERT INTO user_avatars (id, user_id, world_id, texture_ids, updated_at, companion_texture_id) VALUES
    ('c1', 'cy', 'w1', ARRAY[]::text[], '2026-10-02 08:00:00', 'dog2');
`);

await db.exec(fs.readFileSync(path.join(MIGRATIONS, TARGET, 'migration.sql'), 'utf8'));

const outfits = await db.query(
  `SELECT user_id, texture_ids, outfit_key, to_char(first_worn_at, 'YYYY-MM-DD HH24:MI:SS') AS first_worn_at, to_char(last_worn_at, 'YYYY-MM-DD HH24:MI:SS') AS last_worn_at
   FROM user_outfits ORDER BY user_id, last_worn_at DESC`,
);
const companions = await db.query('SELECT id, companion_texture_id FROM users ORDER BY id');
const untouched = await db.query('SELECT count(*)::int AS n FROM user_avatars');
console.log(JSON.stringify({ outfits: outfits.rows, companions: companions.rows, userAvatars: untouched.rows[0].n }));
await db.close();
