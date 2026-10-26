// Builds a throwaway Postgres (PGlite) from every migration before Live artifacts (game #1422, Orbit #622), saves a
// user, a universe and a bot-less chat the way Orbit has them today, runs that migration, and prints what the new tables
// do. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261026100000_artifacts';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, name, updated_at) VALUES ('owner', 'uuid-owner', 'Owner', now()), ('asker', 'uuid-asker', 'Asker', now());
`);
const snapshot = async () => ({
  users: (await db.query('SELECT id, uuid, name FROM users ORDER BY id')).rows,
});
const before = await snapshot();
await run(TARGET);
const after = await snapshot();

const attempt = async (sql) => {
  try {
    await db.exec(sql);
    return 'ok';
  } catch (error) {
    return String(error.message);
  }
};

await db.exec(`
  INSERT INTO artifacts (id, owner_id, maker_bot_id, maker_name, title, kind, updated_at)
  VALUES ('a1', 'owner', 'bot1', 'Scout', 'Quests board', 'app', now());
  INSERT INTO artifact_versions (id, artifact_id, number, asked_by_id, asked_by_name, file_key, size_bytes)
  VALUES ('v1', 'a1', 1, 'owner', 'Owner', 'artifacts/a1/v1-x.html', 10),
         ('v2', 'a1', 2, 'asker', 'Asker', 'artifacts/a1/v2-x.html', 12);
`);
const defaults = (await db.query('SELECT open_scope, change_scope, latest_version, chat_kind, chat_ref, copied_from_id, expires_at FROM artifacts')).rows;

const duplicateVersion = await attempt(`INSERT INTO artifact_versions (id, artifact_id, number, file_key, size_bytes) VALUES ('v3', 'a1', 2, 'k', 1)`);
const orphanVersion = await attempt(`INSERT INTO artifact_versions (id, artifact_id, number, file_key, size_bytes) VALUES ('v4', 'nope', 1, 'k', 1)`);
const guestArtifact = await attempt(`INSERT INTO artifacts (id, maker_bot_id, maker_name, title, kind, expires_at, updated_at) VALUES ('g1', 'bot1', 'Scout', 'Guest', 'page', now(), now())`);

await db.exec(`DELETE FROM users WHERE id = 'asker'`);
const afterAskerLeft = (await db.query('SELECT number, asked_by_id, asked_by_name FROM artifact_versions ORDER BY number')).rows;

await db.exec(`DELETE FROM users WHERE id = 'owner'`);
const afterOwnerLeft = {
  artifacts: (await db.query('SELECT id FROM artifacts ORDER BY id')).rows,
  versions: (await db.query('SELECT id FROM artifact_versions')).rows,
};

console.log(JSON.stringify({ before, after, defaults, duplicateVersion, orphanVersion, guestArtifact, afterAskerLeft, afterOwnerLeft }));
