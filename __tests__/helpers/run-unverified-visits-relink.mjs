// Builds a throwaway Postgres (PGlite) from every migration, saves visits the way Orbit's room access saves them (the
// unverified ids made with the same sha256 as app/api/room/access/route.ts), then runs the three #531 scripts as written:
// the read-only check, the relink (twice) and the undo (twice), and prints what the visits look like at each step.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');
const script = (name) => fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
// The same id the room access route saves for an account it could not verify.
const unverified = (claimed) => `unverified-${createHash('sha256').update(claimed).digest('hex').slice(0, 32)}`;

const db = new PGlite();
for (const name of fs.readdirSync(MIGRATIONS).filter((name) => /^\d/.test(name)).sort()) {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
}

await db.exec(`
  INSERT INTO users (id, uuid, email, name, is_guest, updated_at) VALUES
    ('mona', 'sub-mona', 'mona@example.test', 'Mona', false, now()),
    ('noemail', 'sub-noemail', NULL, 'Nemo', false, now()),
    ('twin1', 'sub-twin1', 'twin@example.test', 'Twin One', false, now()),
    ('twin2', 'twin@example.test', 'twin2@example.test', 'Twin Two', false, now()),
    ('oldguest', 'guest-uuid-1', NULL, NULL, true, now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('un1', 'uni', 'Uni', 'mona', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'un1', 'world', 'World', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('r1', 'w1', 'hq', 'HQ', now()), ('r2', 'w1', 'lobby', 'Lobby', now());
`);
const visit = (id, room, userUuid, userId, name, email, isGuest, isAuthenticated) =>
  db.query(
    `INSERT INTO room_accesses (id, user_uuid, user_id, ip_address, user_name, user_email, is_guest, is_authenticated,
       has_membership, membership_tags, universe_id, world_id, room_id, universe_slug, world_slug, room_slug, play_uri, accessed_at)
     VALUES ($1, $2, $3, '10.0.0.1', $4, $5, $6, $7, false, '{}', 'un1', 'w1', $8, 'uni', 'world', $9, 'https://play.test', now())`,
    [id, userUuid, userId, name, email, isGuest, isAuthenticated, room, room === 'r1' ? 'hq' : 'lobby'],
  );
// Mona signed in, then twice with a sign-in that had run out (the game sends her email), in two rooms.
await visit('mona-signed-in', 'r1', 'sub-mona', 'mona', 'Mona', 'mona@example.test', false, true);
await visit('mona-unverified-1', 'r1', unverified('mona@example.test'), null, null, null, true, false);
await visit('mona-unverified-2', 'r2', unverified('mona@example.test'), null, 'Typed', null, true, false);
// Saved before #421: already under her account, not signed in. Left as it is.
await visit('mona-before-421', 'r1', 'mona@example.test', 'mona', 'Mona', 'mona@example.test', false, false);
// An account with no email: the game sends its uuid.
await visit('noemail-unverified', 'r1', unverified('sub-noemail'), null, null, null, true, false);
// An id that is one account's email and another account's uuid: whose visit it is can't be told.
await visit('twin-unverified', 'r1', unverified('twin@example.test'), null, null, null, true, false);
// An id no account makes (deleted account).
await visit('gone-unverified', 'r1', unverified('gone@example.test'), null, null, null, true, false);
// An id only an account still marked as a guest makes.
await visit('oldguest-unverified', 'r1', unverified('guest-uuid-1'), null, null, null, true, false);
// Real guests, with and without a typed name.
await visit('guest-nova', 'r1', '9b1d0c3e-guest-browser', null, 'Nova', null, true, false);
await visit('guest-nameless', 'r2', '4f2a77aa-guest-browser', null, null, null, true, false);
// Looks like the format but isn't one.
await visit('odd-format', 'r1', 'unverified-not-a-hash', null, null, null, true, false);
// An unverified id that already has an account on it: not touched.
await visit('already-linked', 'r1', unverified('mona@example.test'), 'twin1', 'Twin One', null, false, false);

const json = async (sql) => {
  const results = await db.exec(sql);
  const last = results.filter((result) => result.rows.length).pop();
  return Object.values(last.rows[0])[0];
};
const visits = async () =>
  (await db.query('SELECT id, user_uuid, user_id, user_name, user_email, is_guest, is_authenticated, room_id FROM room_accesses ORDER BY id')).rows;
const people = async () =>
  (await db.query(`SELECT room_id, count(DISTINCT COALESCE('u:' || user_id, 'g:' || user_uuid, 'a:' || id))::int AS people, count(*)::int AS visits
     FROM room_accesses GROUP BY room_id ORDER BY room_id`)).rows;

const out = {};
out.check = await json(script('unverified-visits-check.sql'));
out.before = await visits();
out.peopleBefore = await people();
out.relink = await json(script('unverified-visits-relink.sql'));
out.after = await visits();
out.peopleAfter = await people();
out.log = (await db.query('SELECT room_access_id, user_id, old_user_uuid, old_user_id, old_user_name, old_is_guest, undone_at FROM room_access_relinks ORDER BY room_access_id')).rows;
out.relinkAgain = await json(script('unverified-visits-relink.sql'));
out.checkAfter = await json(script('unverified-visits-check.sql'));
out.undo = await json(script('unverified-visits-undo.sql'));
out.afterUndo = await visits();
out.undoAgain = await json(script('unverified-visits-undo.sql'));
out.ids = { mona: unverified('mona@example.test') };
console.log(JSON.stringify(out));
await db.close();
