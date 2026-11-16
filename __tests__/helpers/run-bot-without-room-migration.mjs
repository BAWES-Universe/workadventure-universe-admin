// Builds a throwaway Postgres (PGlite) from every migration before "a bot can exist without a room" (game #1992), saves
// room bots the way Orbit has them today with what hangs from them (rules, an app, memory, a chat), runs that migration,
// and prints what they look like after and what the database accepts from then on.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261111110000_bot_without_room';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('maker', 'uuid-maker', now()), ('sara', 'uuid-sara', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now()), ('room2', 'w1', 'lab', 'Lab', now());
  INSERT INTO bots (
    id, room_id, name, description, character_texture_id, companion_texture_id, enabled, behavior_type, behavior_config,
    chat_instructions, movement_instructions, ai_provider_ref, ai_model, created_by_id, updated_by_id, tool_timeout_seconds,
    daily_reply_cap, private_bot, refusal_reply, hide_conversations, max_reply_tokens, max_steps, ask_before_making,
    ask_which_way, card_wait_minutes, voice_enabled, voice_revision, allow_more_idle_minutes, allow_more_max_minutes, updated_at
  ) VALUES (
    'bot1', 'room1', 'Nora', 'Greets visitors', 'woka-7', 'dog', false, 'patrol', '{"assignedSpace":{"center":{"x":3,"y":4},"radius":2},"showToolCalls":true}',
    'Be kind.', 'Walk the hall.', 'key-1', 'model-a', 'maker', 'owner', 45,
    20, true, 'Not for you.', true, 900, 6, 3,
    'never', 30, true, 2, 30, 240, '2026-01-02 03:04:05'
  );
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot2', 'room2', 'Atlas', 'maker', '2026-02-03 04:05:06');
  INSERT INTO bot_access_rules (id, bot_id, user_id, allow, deny, updated_at) VALUES ('rule1', 'bot1', 'sara', 16384, 65536, now());
  INSERT INTO bot_mcp_servers (id, bot_id, name, server_url, updated_at) VALUES ('app1', 'bot1', 'Notes', 'https://apps.example/mcp', now());
  INSERT INTO bots_memory (bot_id, user_uuid, memories, updated_at) VALUES ('bot1', 'uuid-sara', '{"personalInfo":{"name":"Sara"}}', now());
  INSERT INTO bots_conversations_recent (bot_id, user_uuid, messages, started_at, ended_at, message_count)
  VALUES ('bot1', 'uuid-sara', '[{"sender":"user","message":"hi"}]', now(), now(), 1);
`);

const hanging = async () => ({
  rules: (await db.query('SELECT id, bot_id, user_id, allow::text AS allow, deny::text AS deny FROM bot_access_rules ORDER BY id')).rows,
  apps: (await db.query('SELECT id, bot_id, name, server_url FROM bot_mcp_servers ORDER BY id')).rows,
  memory: (await db.query('SELECT bot_id, user_uuid, memories FROM bots_memory ORDER BY bot_id')).rows,
  chats: (await db.query('SELECT bot_id, user_uuid, message_count FROM bots_conversations_recent ORDER BY bot_id')).rows,
});
const before = { bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows, ...(await hanging()) };
await run(TARGET);
const after = { bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows, ...(await hanging()) };

const accepted = async (sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  }
};
const checks = {
  // What the database holds a bot to from now on: a room or an owner, never neither, never both
  roomBotAsToday: await accepted(`INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot3', 'room1', 'Mira', 'sara', now())`),
  brick: await accepted(`INSERT INTO bots (id, owner_id, name, created_by_id, updated_at) VALUES ('brick1', 'sara', 'Brick', 'sara', now())`),
  neitherRoomNorOwner: await accepted(`INSERT INTO bots (id, name, updated_at) VALUES ('bad1', 'Nowhere', now())`),
  roomAndOwner: await accepted(`INSERT INTO bots (id, room_id, owner_id, name, updated_at) VALUES ('bad2', 'room1', 'sara', 'Both', now())`),
  unknownOwner: await accepted(`INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('bad3', 'nobody', 'Whose', now())`),
  brickIntoRoom: await accepted(`UPDATE bots SET room_id = 'room1' WHERE id = 'brick1'`),
  roomBotOutOfItsRoom: await accepted(`UPDATE bots SET room_id = NULL WHERE id = 'bot1'`),
  roomBotGivenAnOwner: await accepted(`UPDATE bots SET owner_id = created_by_id WHERE id = 'bot1'`),
};
const ids = async () => (await db.query('SELECT id FROM bots ORDER BY id')).rows.map((row) => row.id);
const botsBeforeDeletes = await ids();

// Deleting a room deletes its room bots, as today, and what hangs from them. A Brick is in no room, so it stays.
await db.exec(`DELETE FROM rooms WHERE id = 'room1'`);
const afterRoomGone = { bots: await ids(), rules: (await hanging()).rules.length, apps: (await hanging()).apps.length };

// "Made by" is not ownership: when the maker's account goes, the room bot they typed in stays in its room
await db.exec(`DELETE FROM users WHERE id = 'maker'`);
const afterMakerGone = (await db.query(`SELECT id, room_id, created_by_id, owner_id FROM bots WHERE id = 'bot2'`)).rows;

// A Brick goes with its owner's account
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const afterOwnerGone = await ids();

console.log(JSON.stringify({ before, after, checks, botsBeforeDeletes, afterRoomGone, afterMakerGone, afterOwnerGone }));
await db.close();
