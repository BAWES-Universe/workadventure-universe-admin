// Builds a throwaway Postgres (PGlite) from every migration before the Call bots permission (game #2004), saves roles
// the way Orbit has them today (plus a few an owner might have changed) and a bot with a rule, runs the migration twice,
// and prints the roles before, after one run and after two, plus what a bot rule may now hold. It runs as its own process
// because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261112080000_call_bots_permission';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

// Three universes with the built-in roles as the bot permissions migration left them (Admin 524287, Everyone 114688).
await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES
    ('u1', 'acme', 'Acme', 'owner', now()), ('u2', 'other', 'Other', 'owner', now()), ('u3', 'third', 'Third', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now());
  INSERT INTO roles (id, universe_id, key, name, permissions, position, built_in, updated_at)
  SELECT 'r-' || u.id || '-' || b.key, u.id, b.key, b.name, b.permissions, b.position, true, now()
  FROM universes u CROSS JOIN (VALUES
    ('admin', 'Admin', 524287, 1000000), ('editor', 'Editor', 401632, 2), ('member', 'Member', 131072, 1), ('everyone', 'Everyone', 114688, 0)
  ) AS b(key, name, permissions, position);
  -- u2: Member also had Go live (256). u3: Editor lost Manage bots.
  UPDATE roles SET permissions = 256 | 131072 WHERE id = 'r-u2-member';
  UPDATE roles SET permissions = 401632 - 8192 WHERE id = 'r-u3-editor';
  -- Custom roles, which must not change, even one named like a built-in role, and one that already can manage bots.
  INSERT INTO roles (id, universe_id, key, name, permissions, position, built_in, updated_at) VALUES
    ('c1', 'u1', 'finance', 'Finance', 2048, 10, false, now()),
    ('c2', 'u1', 'members', 'Member look-alike', 0, 11, false, now()),
    ('c3', 'u2', 'mod', 'Mod', 524287, 12, false, now());
  INSERT INTO bot_access_rules (id, bot_id, role_id, allow, deny, updated_at) VALUES ('rule1', 'bot1', 'c1', 16384, 65536, now());
`);

const snapshot = async () =>
  (await db.query('SELECT universe_id, key, permissions::text AS permissions, built_in FROM roles ORDER BY universe_id, key')).rows;
const before = await snapshot();
await run(TARGET);
const once = await snapshot();
await run(TARGET);
const twice = await snapshot();

const attempt = async (sql) => {
  try {
    await db.exec(sql);
    return 'accepted';
  } catch (error) {
    return String(error.message);
  }
};
const insert = (allow, deny, subject) =>
  `INSERT INTO bot_access_rules (id, bot_id, role_id, allow, deny, updated_at) VALUES (gen_random_uuid()::text, 'bot1', '${subject}', ${allow}, ${deny}, now())`;
const results = {
  before,
  once,
  twice,
  ruleKept: (await db.query("SELECT allow::text, deny::text FROM bot_access_rules WHERE id = 'rule1'")).rows[0],
  call: await attempt(insert(524288, 0, 'r-u1-member')),
  everythingAtOnce: await attempt(insert(8192 + 16384 + 32768 + 65536 + 131072 + 262144, 524288, 'r-u1-editor')),
  overlap: await attempt(insert(524288, 524288, 'r-u1-everyone')),
  outsideBits: await attempt(insert(1048576, 0, 'r-u1-admin')),
  oldOutsideBit: await attempt(insert(256, 0, 'r-u2-admin')),
  negative: await attempt(insert(-1, 0, 'r-u3-admin')),
};
console.log(JSON.stringify(results));
await db.close();
