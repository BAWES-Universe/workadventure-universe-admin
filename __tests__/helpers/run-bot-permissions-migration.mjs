// Builds a throwaway Postgres (PGlite) from every migration up to and including roles (#314), saves roles the way
// Orbit has them today (plus a few an owner might have changed), runs the bot permissions migration (#426) twice, and
// prints the roles before, after one run and after two. It runs as its own process because PGlite loads itself with
// dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const ROLES = '20261017180000_roles';
const TARGET = '20261018220000_bot_permissions';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(ROLES) + 1)) await run(name);

// The roles migration made the four built-in roles in every universe that existed. Add the universes of today
// afterwards with the same roles, as ensureBuiltInRoles does, and let owners have changed some.
await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES
    ('u1', 'acme', 'Acme', 'owner', now()), ('u2', 'other', 'Other', 'owner', now()), ('u3', 'third', 'Third', 'owner', now());
  INSERT INTO roles (id, universe_id, key, name, permissions, position, built_in, updated_at)
  SELECT 'r-' || u.id || '-' || b.key, u.id, b.key, b.name, b.permissions, b.position, true, now()
  FROM universes u CROSS JOIN (VALUES
    ('admin', 'Admin', 16383, 1000000), ('editor', 'Editor', 8416, 2), ('member', 'Member', 0, 1), ('everyone', 'Everyone', 0, 0)
  ) AS b(key, name, permissions, position);
  -- u2: the owner had already given Everyone "Send messages" (512). u3: Editor lost Manage bots and Member got Go live.
  UPDATE roles SET permissions = 512 WHERE id = 'r-u2-everyone';
  UPDATE roles SET permissions = 8416 - 8192 WHERE id = 'r-u3-editor';
  UPDATE roles SET permissions = 256 WHERE id = 'r-u3-member';
  -- Custom roles, which must not change, and one named like a built-in key in another universe.
  INSERT INTO roles (id, universe_id, key, name, permissions, position, built_in, updated_at) VALUES
    ('c1', 'u1', 'finance', 'Finance', 2048, 10, false, now()),
    ('c2', 'u1', 'none', 'None', 0, 11, false, now()),
    ('c3', 'u2', 'mod', 'Mod', 16383, 12, false, now());
`);

const snapshot = async () =>
  (await db.query('SELECT universe_id, key, permissions::text AS permissions, built_in, updated_at FROM roles ORDER BY universe_id, key')).rows;
const before = await snapshot();
await run(TARGET);
const once = await snapshot();
await run(TARGET);
const twice = await snapshot();
console.log(JSON.stringify({ before, once, twice }));
await db.close();
