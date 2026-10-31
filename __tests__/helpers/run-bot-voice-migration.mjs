// Builds a throwaway Postgres (PGlite) from every migration before Bot voice (#740), saves bots the way Orbit has them today,
// runs that migration, and prints what they look like and which values the new tables accept. It runs as its own process because
// PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261030232000_bot_voice';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now()), ('bot2', 'room1', 'Atlas', now());
`);
const before = (await db.query('SELECT id, name, enabled FROM bots ORDER BY id')).rows;

await run(TARGET);
const once = (await db.query('SELECT id, name, enabled, voice_enabled, voice_revision FROM bots ORDER BY id')).rows;

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const checks = {
  draft: await accepted(`INSERT INTO bot_voice_drafts (bot_id, updated_at) VALUES ('bot1', now())`),
  secondDraftForABot: await accepted(`INSERT INTO bot_voice_drafts (bot_id, updated_at) VALUES ('bot1', now())`),
  draftForNoBot: await accepted(`INSERT INTO bot_voice_drafts (bot_id, updated_at) VALUES ('nobody', now())`),
  revision: await accepted(`INSERT INTO bot_voice_revisions (id, bot_id, number, profile) VALUES ('r1', 'bot1', 1, '{}')`),
  sameNumberTwice: await accepted(`INSERT INTO bot_voice_revisions (id, bot_id, number, profile) VALUES ('r2', 'bot1', 1, '{}')`),
  sameNumberOnAnotherBot: await accepted(`INSERT INTO bot_voice_revisions (id, bot_id, number, profile) VALUES ('r3', 'bot2', 1, '{}')`),
  revisionForNoBot: await accepted(`INSERT INTO bot_voice_revisions (id, bot_id, number, profile) VALUES ('r4', 'nobody', 1, '{}')`),
};
const draftDefault = (await db.query(`SELECT profile FROM bot_voice_drafts WHERE bot_id = 'bot1'`)).rows[0];
await db.exec(`DELETE FROM bots WHERE id = 'bot1'`);
const left = (await db.query(`SELECT (SELECT count(*) FROM bot_voice_drafts)::int AS drafts, (SELECT count(*) FROM bot_voice_revisions)::int AS revisions`)).rows[0];

console.log(JSON.stringify({ before, once, checks, draftDefault, left }));
