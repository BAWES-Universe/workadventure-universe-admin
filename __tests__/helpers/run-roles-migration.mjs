// Builds a throwaway Postgres (PGlite) from every migration before roles (#314), saves world members and invitations
// the way Orbit does today (tags per person and world), runs the roles migration, and prints every table it touches
// as JSON. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261017180000_roles';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES
    ('owner', 'uuid-owner', now()), ('alice', 'uuid-alice', now()), ('bob', 'uuid-bob', now()),
    ('cara', 'uuid-cara', now()), ('dan', 'uuid-dan', now()), ('eve', 'uuid-eve', now()), ('fay', 'uuid-fay', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES
    ('u1', 'acme', 'Acme', 'owner', now()), ('u2', 'other', 'Other', 'owner', now()), ('u3', 'empty', 'Empty', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES
    ('wa', 'u1', 'a', 'A', now()), ('wb', 'u1', 'b', 'B', now()), ('wc', 'u1', 'c', 'C', now()),
    ('wd', 'u2', 'd', 'D', now());
  INSERT INTO world_members (id, user_id, world_id, tags, joined_at) VALUES
    -- Alice: admin in A, member in B
    ('m1', 'alice', 'wa', ARRAY['admin'], '2026-01-05'),
    ('m2', 'alice', 'wb', ARRAY['member'], '2026-01-01'),
    -- Bob: editor in A
    ('m3', 'bob', 'wa', ARRAY['editor'], '2026-02-01'),
    -- Cara: member with a typed tag in A
    ('m4', 'cara', 'wa', ARRAY['member', 'finance'], '2026-03-01'),
    -- Dan: admin and editor in A, and a member of another universe
    ('m5', 'dan', 'wa', ARRAY['admin', 'editor'], '2026-04-01'),
    ('m6', 'dan', 'wd', ARRAY['member'], '2026-04-02'),
    -- Eve: a row with no tags
    ('m7', 'eve', 'wa', ARRAY[]::text[], '2026-05-01'),
    -- The owner, admin in C
    ('m8', 'owner', 'wc', ARRAY['admin'], '2026-01-01');
  INSERT INTO membership_invitations (id, world_id, invited_user_id, invited_by_user_id, status, tags) VALUES
    ('i1', 'wb', 'fay', 'alice', 'pending', ARRAY['editor', 'member']),
    ('i2', 'wa', 'fay', 'alice', 'pending', ARRAY['vip']),
    ('i3', 'wa', 'eve', 'alice', 'accepted', ARRAY['member']);
`);

const before = (await db.query('SELECT id, user_id, world_id, tags, joined_at FROM world_members ORDER BY id')).rows;
await run(TARGET);
const q = async (sql) => (await db.query(sql)).rows;
console.log(
  JSON.stringify({
    before,
    roles: await q('SELECT universe_id, key, name, permissions::text AS permissions, position, built_in FROM roles ORDER BY universe_id, position DESC, key'),
    members: await q('SELECT universe_id, user_id, all_worlds, world_ids, joined_at FROM universe_members ORDER BY universe_id, user_id'),
    given: await q(`SELECT um.universe_id, um.user_id, r.key, a.all_worlds, a.world_ids
      FROM universe_member_roles a JOIN universe_members um ON um.id = a.member_id JOIN roles r ON r.id = a.role_id
      ORDER BY um.universe_id, um.user_id, r.key`),
    after: await q('SELECT id, user_id, world_id, tags, joined_at FROM world_members ORDER BY id'),
    invitations: await q(`SELECT i.id, i.universe_id, i.all_worlds, i.world_ids,
      ARRAY(SELECT r.key FROM unnest(i.role_ids) AS x(id) JOIN roles r ON r.id = x.id) AS role_keys
      FROM membership_invitations i ORDER BY i.id`),
  }),
);
await db.close();
