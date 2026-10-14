// Builds a throwaway Postgres (PGlite) from every migration before the user-outfits one, saves companions the way the old
// rule did (one row per person and world), runs the user-outfits migration, saves a pick made after it, then runs the
// companion repair (#365) and prints each person's companion before and after it as JSON.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const OUTFITS = '20261012100000_user_outfits';
const TARGET = '20261014100000_companion_none_after_outfits';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(OUTFITS))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES
    ('dee', 'uuid-dee', now()), ('eve', 'uuid-eve', now()), ('fay', 'uuid-fay', now()), ('gus', 'uuid-gus', now()),
    ('hal', 'uuid-hal', now()), ('ivy', 'uuid-ivy', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni1', 'acme', 'Acme', 'dee', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES
    ('w1', 'uni1', 'one', 'One', now()), ('w2', 'uni1', 'two', 'Two', now()), ('w3', 'uni1', 'three', 'Three', now());

  INSERT INTO user_avatars (id, user_id, world_id, texture_ids, updated_at, companion_texture_id) VALUES
    -- Dee: a dog in world one, then "no companion" in world two, where she never saved a Woka
    ('d1', 'dee', 'w1', ARRAY['male1'], '2026-10-01 10:00:00', 'dog1'),
    ('d2', 'dee', 'w2', ARRAY[]::text[], '2026-10-05 10:00:00', NULL),
    -- Eve: a dog in world one, then a Woka in world two with no companion: "none" or never chose one there, can't tell
    ('e1', 'eve', 'w1', ARRAY['male1'], '2026-10-01 10:00:00', 'dog1'),
    ('e2', 'eve', 'w2', ARRAY['male2'], '2026-10-05 10:00:00', NULL),
    -- Fay: "no companion" in world two, then a dog in world one later
    ('f2', 'fay', 'w2', ARRAY[]::text[], '2026-10-01 10:00:00', NULL),
    ('f1', 'fay', 'w1', ARRAY['male1'], '2026-10-05 10:00:00', 'dog1'),
    -- Gus: like Dee, and after the outfits migration he picked a cat in world three (below)
    ('g1', 'gus', 'w1', ARRAY['male1'], '2026-10-01 10:00:00', 'dog1'),
    ('g2', 'gus', 'w2', ARRAY[]::text[], '2026-10-05 10:00:00', NULL),
    -- Hal: only ever chose "no companion"
    ('h2', 'hal', 'w2', ARRAY[]::text[], '2026-10-05 10:00:00', NULL),
    -- Ivy: "no companion" and a dog saved at the same moment: not clear, left alone
    ('i1', 'ivy', 'w1', ARRAY['male1'], '2026-10-05 10:00:00', 'dog1'),
    ('i2', 'ivy', 'w2', ARRAY[]::text[], '2026-10-05 10:00:00', NULL);
  UPDATE user_avatars SET outfit_updated_at = updated_at WHERE cardinality(texture_ids) > 0;
`);

await run(OUTFITS);
const companions = () => db.query('SELECT id, companion_texture_id FROM users ORDER BY id').then((result) => result.rows);
const afterOutfits = await companions();

// Gus picks a cat in world three after the outfits migration: the account and that world's row, as the save does now
await db.exec(`
  UPDATE users SET companion_texture_id = 'cat1' WHERE id = 'gus';
  INSERT INTO user_avatars (id, user_id, world_id, texture_ids, updated_at, companion_texture_id)
    VALUES ('g3', 'gus', 'w3', ARRAY[]::text[], '2026-10-14 12:00:00', 'cat1');
`);

await run(TARGET);
const rows = await db.query('SELECT count(*)::int AS n FROM user_avatars');
console.log(JSON.stringify({ afterOutfits, afterRepair: await companions(), userAvatars: rows.rows[0].n }));
await db.close();
