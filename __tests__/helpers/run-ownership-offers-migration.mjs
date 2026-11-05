// Builds a throwaway Postgres (PGlite) from every migration before the ownership offers (#820), runs that migration over
// universes that already exist, and prints what it left behind and what the new table accepts and cascades.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261105120000_universe_ownership_offers';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('lab', 'uuid-lab', now()), ('other', 'uuid-other', now()), ('former', 'uuid-former', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now()), ('u2', 'beta', 'Beta', 'owner', now());
`);
const before = (await db.query('SELECT id, name, owner_id FROM universes ORDER BY id')).rows;
await run(TARGET);
const after = (await db.query('SELECT id, name, owner_id, owner_since, previous_owner_id FROM universes ORDER BY id')).rows;

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const checks = {
  firstOffer: await accepted(`INSERT INTO ownership_offers (id, universe_id, to_user_id, offered_by_id) VALUES ('o1', 'u1', 'lab', 'owner')`),
  secondOfferSameUniverse: await accepted(`INSERT INTO ownership_offers (id, universe_id, to_user_id, offered_by_id) VALUES ('o2', 'u1', 'other', 'owner')`),
  offerInOtherUniverse: await accepted(`INSERT INTO ownership_offers (id, universe_id, to_user_id, offered_by_id) VALUES ('o3', 'u2', 'lab', 'owner')`),
  unknownUniverse: await accepted(`INSERT INTO ownership_offers (id, universe_id, to_user_id, offered_by_id) VALUES ('o4', 'nope', 'lab', 'owner')`),
  unknownPerson: await accepted(`INSERT INTO ownership_offers (id, universe_id, to_user_id, offered_by_id) VALUES ('o5', 'u1', 'nobody', 'owner')`),
  passedOn: await accepted(`UPDATE universes SET owner_id = 'lab', owner_since = now(), previous_owner_id = 'former' WHERE id = 'u1'`),
};
const offersBefore = (await db.query('SELECT id FROM ownership_offers ORDER BY id')).rows.map((row) => row.id);
// An account that gave a universe away can go: the universe stays with its new owner, and only the name of who it came from clears
await db.exec(`DELETE FROM users WHERE id = 'former'`);
const passed = (await db.query(`SELECT owner_id, previous_owner_id FROM universes WHERE id = 'u1'`)).rows[0];
await db.exec(`DELETE FROM universes WHERE id = 'u2'`);
const offersAfterUniverseGone = (await db.query('SELECT id FROM ownership_offers ORDER BY id')).rows.map((row) => row.id);

console.log(JSON.stringify({ before, after, checks, offersBefore, passed, offersAfterUniverseGone }));
