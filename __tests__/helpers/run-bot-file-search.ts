// Runs the search over files in bot chats (game #1508) on a real Postgres (PGlite) built from every migration: who sees
// what, the filters, words (a made-up name, Arabic, the start of a word), pages, and 10,000 files for one person. It runs
// as its own process (with tsx) because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { fileHitsSql, fileSearchSql, searchWords, wordQuery, type SearchFilters, type SearchScope } from '../../lib/bot-file-search-sql';

const MIGRATIONS = path.join(__dirname, '../../prisma/migrations');

async function main() {
  const db = new PGlite();
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => /^\d/.test(n)).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
  }
  await db.exec(`
    INSERT INTO users (id, uuid, name, updated_at) VALUES ('owner', 'uuid-owner', 'Owner', now()), ('friend', 'uuid-friend', 'Friend', now()), ('bulk', 'uuid-bulk', 'Bulk', now());
    INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'u1', 'U', 'friend', now());
    INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'w1', 'W', now());
    INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('r1', 'w1', 'r1', 'R', now());
    INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'r1', 'Scout', now()), ('bot2', 'r1', 'Echo', now());
  `);
  const STORE = `'user-refs', '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf'`;
  const add = (id: string, bot: string, n: number, owner: string | null, source: string, kind: string, name: string, line: string | null, chat: [string, string], created: string, expires: string | null = null) =>
    `INSERT INTO bot_files (id, bot_id, number, owner_id, source, kind, name, line, chat_kind, chat_ref, bucket, file_id, created_at, expires_at)
     VALUES ('${id}', '${bot}', ${n}, ${owner ? `'${owner}'` : 'NULL'}, '${source}', '${kind}', '${name}', ${line ? `'${line}'` : 'NULL'}, '${chat[0]}', '${chat[1]}', ${STORE}, '${created}', ${expires ? `'${expires}'` : 'NULL'});`;
  const DM: [string, string] = ['dm', '!owner-dm'];
  const BUBBLE: [string, string] = ['nearby', 'room#1#100'];
  const LATER: [string, string] = ['nearby', 'room#2#200'];
  await db.exec(`
    ${add('dm-song', 'bot1', 1, 'owner', 'bot', 'audio', 'yazoghal.mp3', 'Song "yazoghal", slow version', DM, '2026-10-20T10:00:00Z')}
    ${add('dm-plan', 'bot1', 2, 'owner', 'person', 'document', 'plan.pdf', null, DM, '2026-10-21T10:00:00Z')}
    ${add('bubble-pic', 'bot1', 3, 'owner', 'person', 'image', 'gate.png', 'Photo of the north gate', BUBBLE, '2026-10-22T10:00:00Z')}
    ${add('friend-notes', 'bot1', 4, 'friend', 'person', 'document', 'notes.txt', 'Friend notes', BUBBLE, '2026-10-23T10:00:00Z')}
    ${add('friend-old', 'bot1', 5, 'friend', 'person', 'document', 'secret.txt', 'Friend secret, older bubble', LATER, '2026-10-19T10:00:00Z')}
    ${add('guest-pic', 'bot1', 6, null, 'person', 'image', 'guest.png', 'A guest picture', BUBBLE, '2026-10-24T10:00:00Z', '2026-10-25T10:00:00Z')}
    ${add('guest-gone', 'bot1', 7, null, 'person', 'image', 'gone.png', 'Gone guest picture', BUBBLE, '2026-10-20T10:00:00Z', '2026-10-21T10:00:00Z')}
    ${add('other-bot', 'bot2', 1, 'owner', 'person', 'document', 'yazoghal-lyrics.txt', 'Lyrics', DM, '2026-10-24T11:00:00Z')}
    INSERT INTO bot_file_parts (bot_file_id, number, start, text) VALUES
      ('dm-plan', 1, 0, '${'Intro words. '.repeat(700)}'),
      ('dm-plan', 2, 9100, 'Launch day is Thursday. We sing yazoghal at the gate. مرحبا بالجميع في الحفلة'),
      ('friend-notes', 1, 0, 'Bring the yazoghal drums.');
  `);
  // Lyrics with Arabic short vowels (marhaban with fatha, sukun, tanween), and a name with them
  const MARKED = '\u0645\u064e\u0631\u0652\u062d\u064e\u0628\u064b\u0627';
  await db.query(`INSERT INTO bot_file_parts (bot_file_id, number, start, text) VALUES ('dm-song', 1, 0, $1)`, [`${MARKED} \u064a\u0627 \u0623\u0635\u062f\u0642\u0627\u0621`]);
  await db.query(`UPDATE bot_files SET line = $1 WHERE id = 'bubble-pic'`, [`Photo of the north gate, ${MARKED}`]);

  const scope = (over: Partial<SearchScope> = {}): SearchScope => ({
    botId: 'bot1', userId: 'owner', chatKind: 'dm', chatRef: '!owner-dm', now: new Date('2026-10-24T12:00:00Z'), findableSince: null, ...over,
  });
  const filters = (over: Partial<SearchFilters> = {}): SearchFilters => ({ query: null, kinds: null, source: null, since: null, until: null, ...over });
  const ids = async (s: SearchScope, f: SearchFilters, page = { offset: 0, limit: 50 }) => {
    const built = fileSearchSql(s, f, page);
    const total = (await db.query<{ total: number }>(built.count, built.values)).rows[0].total;
    const rows = (await db.query<{ id: string }>(built.page, built.values)).rows.map((row) => row.id);
    return { total, rows };
  };
  const q = (words: string, mode: 'all' | 'any' = 'all') => wordQuery(searchWords(words), mode);

  const result: Record<string, unknown> = {};
  result.ownerInDm = await ids(scope(), filters());
  result.ownerInBubble = await ids(scope({ chatKind: 'nearby', chatRef: 'room#1#100' }), filters());
  result.friendInBubble = await ids(scope({ userId: 'friend', chatKind: 'nearby', chatRef: 'room#1#100' }), filters());
  result.friendLater = await ids(scope({ userId: 'friend', chatKind: 'nearby', chatRef: 'room#9#900' }), filters());
  result.guestInBubble = await ids(scope({ userId: null, chatKind: 'nearby', chatRef: 'room#1#100' }), filters());
  result.guestAfterDay = await ids(scope({ userId: null, chatKind: 'nearby', chatRef: 'room#1#100', now: new Date('2026-10-26T00:00:00Z') }), filters());
  result.findableDays = await ids(scope({ findableSince: new Date('2026-10-21T00:00:00Z') }), filters());
  result.kinds = await ids(scope(), filters({ kinds: ['audio', 'image'] }));
  result.source = await ids(scope(), filters({ source: 'bot' }));
  result.dates = await ids(scope(), filters({ since: new Date('2026-10-21T00:00:00Z'), until: new Date('2026-10-22T12:00:00Z') }));
  result.wordInName = await ids(scope(), filters({ query: q('yazoghal') }));
  result.wordStart = await ids(scope(), filters({ query: q('yazo') }));
  result.wordInLine = await ids(scope(), filters({ query: q('north gate') }));
  result.arabic = await ids(scope(), filters({ query: q('بالجميع') }));
  result.markedTextUnmarkedQuery = await ids(scope(), filters({ query: q('مرحبا') }));
  result.unmarkedTextMarkedQuery = await ids(scope(), filters({ query: q('\u0628\u0650\u0627\u0644\u0652\u062c\u064e\u0645\u0650\u064a\u0639') }));
  await db.exec(`UPDATE bot_files SET made_with = 'generate_music', made_prompt = 'A slow oud ballad about the gate' WHERE id = 'dm-song'`);
  result.byPrompt = await ids(scope(), filters({ query: q('oud ballad') }));
  result.twoWordsInText = await ids(scope(), filters({ query: q('thursday launch') }));
  result.allMissing = await ids(scope(), filters({ query: q('thursday piano') }));
  result.anyWord = await ids(scope(), filters({ query: q('thursday piano', 'any') }));
  result.friendCannotFindOwnerDm = await ids(scope({ userId: 'friend', chatKind: 'nearby', chatRef: 'room#1#100' }), filters({ query: q('thursday') }));
  result.page2 = await ids(scope(), filters(), { offset: 1, limit: 1 });
  result.injection = await ids(scope(), filters({ query: q("x') OR 1=1; DROP TABLE bot_files; --") }));
  const hits = fileHitsSql(['dm-plan', 'friend-notes', 'bubble-pic'], q('yazoghal') as string);
  result.hits = (await db.query<{ bot_file_id: string; start: number }>(hits.sql, hits.values)).rows.map((row) => [row.bot_file_id, row.start]);
  result.stillThere = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM bot_files')).rows[0].n;

  // One person with 10,000 files with this bot, each with a part of text, and one with the word
  await db.exec(`
    INSERT INTO bot_files (id, bot_id, number, owner_id, source, kind, name, line, chat_kind, chat_ref, bucket, file_id, created_at)
    SELECT 'bulk-' || g, 'bot1', 1000 + g, 'bulk', 'person', CASE WHEN g % 3 = 0 THEN 'image' ELSE 'document' END, 'file-' || g || '.txt', 'Bulk file number ' || g,
      'dm', '!bulk-dm', 'user-refs', '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.txt', timestamp '2026-01-01' + g * interval '1 minute'
    FROM generate_series(1, 10000) g;
    INSERT INTO bot_file_parts (bot_file_id, number, start, text)
    SELECT 'bulk-' || g, 1, 0, 'Meeting notes for week ' || g || '. ' || repeat('Ordinary words about plans and people. ', 40) || CASE WHEN g = 4321 THEN ' The zanzibar contract.' ELSE '' END
    FROM generate_series(1, 10000) g;
    ANALYZE bot_files; ANALYZE bot_file_parts;
  `);
  const bulk = scope({ userId: 'bulk', chatRef: '!bulk-dm' });
  const timed = async (f: SearchFilters, page = { offset: 0, limit: 10 }) => {
    const started = performance.now();
    const found = await ids(bulk, f, page);
    return { ms: Math.round(performance.now() - started), total: found.total, first: found.rows[0] ?? null, count: found.rows.length };
  };
  await timed(filters()); // warm up
  result.bulk = {
    newest: await timed(filters()),
    rareWord: await timed(filters({ query: q('zanzibar') })),
    commonWord: await timed(filters({ query: q('ordinary plans') })),
    kindAndPage: await timed(filters({ kinds: ['image'] }), { offset: 50, limit: 10 }),
  };
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
