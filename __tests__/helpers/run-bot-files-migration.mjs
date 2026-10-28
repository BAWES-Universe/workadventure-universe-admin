// Builds a throwaway Postgres (PGlite) from every migration before files in bot chats (game #1508), saves a person, a
// bot and its memory the way Orbit has them today, runs that migration, and prints what the new tables do. It runs as
// its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261028000000_bot_files';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, name, updated_at) VALUES ('owner', 'uuid-owner', 'Owner', now()), ('friend', 'uuid-friend', 'Friend', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'u1', 'U', 'friend', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'w1', 'W', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('r1', 'w1', 'r1', 'R', now());
  INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'r1', 'Scout', now()), ('bot2', 'r1', 'Echo', now());
  INSERT INTO bots_memory (bot_id, user_uuid, user_name, updated_at) VALUES ('bot1', 'uuid-owner', 'Owner', now());
`);
const snapshot = async () => ({
  users: (await db.query('SELECT id, uuid, name FROM users ORDER BY id')).rows,
  bots: (await db.query('SELECT id, name FROM bots ORDER BY id')).rows,
  memory: (await db.query('SELECT bot_id, user_uuid FROM bots_memory ORDER BY id')).rows,
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
const file = (id, bot, number, owner, name, line = null) =>
  `INSERT INTO bot_files (id, bot_id, number, owner_id, source, kind, name, line, chat_kind, chat_ref, bucket, file_id)
   VALUES ('${id}', '${bot}', ${number}, ${owner ? `'${owner}'` : 'NULL'}, 'person', 'document', '${name}', ${line ? `'${line}'` : 'NULL'}, 'dm', '!dm', 'user-refs', '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf')`;

await db.exec(`
  ${file('f1', 'bot1', 1, 'owner', 'plan.pdf', 'The plan for the yazoghal launch')};
  ${file('f2', 'bot1', 2, 'friend', 'notes.txt')};
  ${file('f3', 'bot2', 1, 'owner', 'song.mp3')};
  ${file('g1', 'bot1', 3, null, 'guest.png')};
  INSERT INTO bot_file_parts (bot_file_id, number, start, text) VALUES
    ('f1', 1, 0, 'Launch day is Thursday. We sing yazoghal at the gate.'),
    ('f1', 2, 54, 'مرحبا بالجميع في الحفلة'),
    ('f2', 1, 0, 'Nothing about songs here.');
`);
// Arabic with short vowels (marhaban with fatha, sukun, tanween) and without them
const WITH_MARKS = '\u0645\u064e\u0631\u0652\u062d\u064e\u0628\u064b\u0627';
const WITHOUT_MARKS = '\u0645\u0631\u062d\u0628\u0627';
await db.query(`INSERT INTO bot_file_parts (bot_file_id, number, start, text) VALUES ('f2', 2, 25, $1)`, [WITH_MARKS]);
const defaults = (await db.query(`SELECT text_state, text_chars, expires_at, created_at IS NOT NULL AS has_created FROM bot_files WHERE id = 'f2'`)).rows;

// One short id per bot: the same number on the same bot is refused, on another bot it is fine
const duplicateNumber = await attempt(file('f4', 'bot1', 1, 'friend', 'again.txt'));
const otherBotSameNumber = (await db.query(`SELECT count(*)::int AS n FROM bot_files WHERE number = 1`)).rows[0].n;
const orphanFile = await attempt(file('f5', 'nobot', 9, 'owner', 'x.txt'));
const orphanPart = await attempt(`INSERT INTO bot_file_parts (bot_file_id, number, start, text) VALUES ('nofile', 1, 0, 'x')`);

// The counter: one statement counts up, as Prisma's upsert with increment does
const count = async (bot) =>
  (await db.query(`INSERT INTO bot_file_counters (bot_id, last) VALUES ($1, 1) ON CONFLICT (bot_id) DO UPDATE SET last = bot_file_counters.last + 1 RETURNING last`, [bot])).rows[0].last;
const counted = [await count('bot1'), await count('bot1'), await count('bot2'), await count('bot1')];

// The word index: Postgres's own, in 'simple' mode, keeps a made-up name and Arabic words as they are
const search = async (words) =>
  (await db.query(`SELECT DISTINCT bot_file_id FROM bot_file_parts WHERE words @@ plainto_tsquery('simple', $1) ORDER BY bot_file_id`, [words])).rows.map((row) => row.bot_file_id);
const words = {
  marksInTextNotQuery: await search(WITHOUT_MARKS),
  name: await search('yazoghal'),
  arabic: await search('بالجميع'),
  twoWords: await search('launch thursday'),
  none: await search('nothing here at all'),
  byLine: (await db.query(`SELECT id FROM bot_files WHERE to_tsvector('simple', name || ' ' || coalesce(line, '')) @@ plainto_tsquery('simple', 'yazoghal')`)).rows.map((row) => row.id),
};
const indexes = (await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('bot_file_parts_words_idx', 'bot_files_words_idx') ORDER BY indexname`)).rows;
const wordsOfAPart = (await db.query(`SELECT words::text AS words FROM bot_file_parts WHERE bot_file_id = 'f2' AND number = 1`)).rows[0].words;
const marksKeptInText = (await db.query(`SELECT text = $1 AS kept FROM bot_file_parts WHERE bot_file_id = 'f2' AND number = 2`, [WITH_MARKS])).rows[0].kept;
const extensions = (await db.query(`SELECT extname FROM pg_extension ORDER BY extname`)).rows.map((row) => row.extname);

// A bot that goes takes its files and their text; a person who leaves takes theirs; a guest's stays until its day
await db.exec(`DELETE FROM bots WHERE id = 'bot2'`);
const afterBotDeleted = (await db.query('SELECT id FROM bot_files ORDER BY id')).rows.map((row) => row.id);
const counterAfterBotDeleted = (await db.query(`SELECT bot_id FROM bot_file_counters ORDER BY bot_id`)).rows.map((row) => row.bot_id);
await db.exec(`DELETE FROM users WHERE id = 'owner'`);
const afterOwnerLeft = {
  files: (await db.query('SELECT id FROM bot_files ORDER BY id')).rows.map((row) => row.id),
  parts: (await db.query('SELECT bot_file_id FROM bot_file_parts ORDER BY bot_file_id')).rows.map((row) => row.bot_file_id),
};

console.log(JSON.stringify({ before, after, defaults, duplicateNumber, otherBotSameNumber, orphanFile, orphanPart, counted, words, indexes, wordsOfAPart, marksKeptInText, extensions, afterBotDeleted, counterAfterBotDeleted, afterOwnerLeft }));
