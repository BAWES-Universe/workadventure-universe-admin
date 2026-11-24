// Builds a throwaway Postgres (PGlite) from every migration before "Just you" (game #1994), saves artifacts the way Orbit
// has them today (one for people in its chat, one for anyone with the link, each with versions and media), runs that
// migration, and prints what they look like after and what the two new tables accept.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111130000_artifact_just_you';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO artifacts (id, owner_id, maker_bot_id, maker_name, title, kind, chat_kind, chat_ref, open_scope, change_scope, latest_version, updated_at)
  VALUES
    ('a1', 'sara', 'bot1', 'Nora', 'Trip plan', 'page', 'nearby', 'room-1', 'chat', 'owner', 2, '2026-11-01 10:00:00'),
    ('a2', 'sara', 'bot1', 'Nora', 'Price list', 'page', 'dm', 'dm-1', 'link', 'owner', 1, '2026-11-02 10:00:00');
  INSERT INTO artifact_versions (id, artifact_id, number, summary, asked_by_id, asked_by_name, file_key, size_bytes, media)
  VALUES
    ('v1', 'a1', 1, 'First', 'sara', 'Sara', 'artifacts/a1/v1-aaaa/index.html', 100, '[]'),
    ('v2', 'a1', 2, 'With a song', 'sara', 'Sara', 'artifacts/a1/v2-bbbb/index.html', 120, '[{"name":"song.mp3","contentType":"audio/mpeg","sizeBytes":9,"key":"artifacts/a1/v2-bbbb/song.mp3"}]'),
    ('v3', 'a2', 1, 'First', 'sara', 'Sara', 'artifacts/a2/v1-cccc/index.html', 80, '[]');
`);

const stored = async () => ({
  artifacts: (await db.query('SELECT * FROM artifacts ORDER BY id')).rows,
  versions: (await db.query('SELECT * FROM artifact_versions ORDER BY id')).rows,
});
const before = await stored();
await run(TARGET);
const after = await stored();

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const HASH = 'a'.repeat(64);
const checks = {
  // The owner can now keep one to themselves, and take that back
  justYou: await accepted(`UPDATE artifacts SET open_scope = 'me' WHERE id = 'a1'`),
  // One opening by its owner; the same address is never stored twice
  pass: await accepted(`INSERT INTO artifact_passes (id, token_hash, artifact_id, user_id, expires_at) VALUES ('p1', '${HASH}', 'a1', 'sara', now() + interval '12 hours')`),
  sameAddressTwice: await accepted(`INSERT INTO artifact_passes (id, token_hash, artifact_id, user_id, expires_at) VALUES ('p2', '${HASH}', 'a1', 'sara', now() + interval '12 hours')`),
  passForNoArtifact: await accepted(`INSERT INTO artifact_passes (id, token_hash, artifact_id, user_id, expires_at) VALUES ('p3', '${'b'.repeat(64)}', 'nope', 'sara', now())`),
  passForNobody: await accepted(`INSERT INTO artifact_passes (id, token_hash, artifact_id, user_id, expires_at) VALUES ('p4', '${'c'.repeat(64)}', 'a1', 'nobody', now())`),
  secondPass: await accepted(`INSERT INTO artifact_passes (id, token_hash, artifact_id, user_id, expires_at) VALUES ('p5', '${'d'.repeat(64)}', 'a2', 'sara', now() + interval '12 hours')`),
  // A file waiting to be removed from the bucket is listed once
  retired: await accepted(`INSERT INTO artifact_retired_files (key) VALUES ('artifacts/a1/v1-aaaa/index.html')`),
  retiredTwice: await accepted(`INSERT INTO artifact_retired_files (key) VALUES ('artifacts/a1/v1-aaaa/index.html')`),
};
const passIds = async () => (await db.query('SELECT id FROM artifact_passes ORDER BY id')).rows.map((row) => row.id);
const passesBefore = await passIds();
const freshPass = (await db.query(`SELECT cookie_hash, redeemed_at, created_at IS NOT NULL AS stamped FROM artifact_passes WHERE id = 'p1'`)).rows[0];

// A pass stops with its artifact: deleting the artifact takes its passes, and leaves the list of files to remove alone
await db.exec(`DELETE FROM artifacts WHERE id = 'a1'`);
const afterArtifactGone = { passes: await passIds(), retired: (await db.query('SELECT key FROM artifact_retired_files')).rows.length };

// ... and with its person's account
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const afterOwnerGone = await passIds();

console.log(JSON.stringify({ before, after, checks, passesBefore, freshPass, afterArtifactGone, afterOwnerGone }));
await db.close();
