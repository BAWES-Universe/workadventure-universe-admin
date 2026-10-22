// Builds a throwaway Postgres (PGlite) from every migration before Hide bot conversations (#435), saves a universe, a
// bot, a transcript and a memory the way Orbit has them today, runs that migration, and prints what they look like
// after. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261019140000_hide_bot_conversations';

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
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now());
  INSERT INTO bots_conversations_recent (bot_id, user_uuid, messages, started_at, ended_at, message_count)
  VALUES ('bot1', 'uuid-bob', '[{"sender":"user","message":"hi"}]', now(), now(), 1);
  INSERT INTO bots_memory (bot_id, user_uuid, memories, updated_at) VALUES ('bot1', 'uuid-bob', '{"personalInfo":{"name":"Bob"}}', now());
`);
const before = {
  universes: (await db.query('SELECT id, slug, name, is_public FROM universes')).rows,
  bots: (await db.query('SELECT id, name, enabled FROM bots')).rows,
  conversations: (await db.query('SELECT bot_id, message_count FROM bots_conversations_recent')).rows,
  memory: (await db.query('SELECT bot_id, user_uuid, memories FROM bots_memory')).rows,
};
await run(TARGET);
const after = {
  universes: (await db.query('SELECT id, slug, name, is_public FROM universes')).rows,
  bots: (await db.query('SELECT id, name, enabled FROM bots')).rows,
  conversations: (await db.query('SELECT bot_id, message_count FROM bots_conversations_recent')).rows,
  memory: (await db.query('SELECT bot_id, user_uuid, memories FROM bots_memory')).rows,
};
const settings = {
  universe: (await db.query('SELECT hide_bot_conversations FROM universes')).rows,
  bot: (await db.query('SELECT hide_conversations FROM bots')).rows,
};
await db.exec(`
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u2', 'new', 'New', 'owner', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot2', 'room1', 'Atlas', now());
  INSERT INTO bot_memory_forgets (id, bot_id) VALUES ('f1', 'bot1');
`);
const fresh = {
  universe: (await db.query("SELECT hide_bot_conversations FROM universes WHERE id = 'u2'")).rows,
  bot: (await db.query("SELECT hide_conversations FROM bots WHERE id = 'bot2'")).rows,
  forget: (await db.query('SELECT bot_id, user_uuid, reported_at FROM bot_memory_forgets')).rows,
};
console.log(JSON.stringify({ before, after, settings, fresh }));
await db.close();
