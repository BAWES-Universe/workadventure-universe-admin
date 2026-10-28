import { NextRequest } from 'next/server';
import { POST as findRoute } from '@/app/api/bot-files/find/route';
import { POST as readRoute } from '@/app/api/bot-files/read/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy, takeForgets } from '@/lib/bot-privacy';
import { addFile, keepFileText, resetFilePruneClock } from '@/lib/bot-files';
import { findFiles, mergePage, readFileText, type FoundArtifact, type FoundFile, type SqlRunner } from '@/lib/bot-file-search';
import { hitOf, searchWords, wordQuery } from '@/lib/bot-file-search-sql';
import { addUser, db } from '../../helpers/bot-files-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/bot-files-db').fakePrisma }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn(), takeForgets: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

/**
 * The search's SQL runs on a real Postgres in __tests__/migrations/bot-file-search.test.ts. Here the SQL is answered by a
 * stand-in, to check what the service does around it: artifacts by #655's rule, the merged page, the fallback to any
 * word, where the words are, and reading by place.
 */
const BUBBLE = { kind: 'nearby' as const, ref: 'room#1#100' };
const OTHER_BUBBLE = { kind: 'nearby' as const, ref: 'room#2#200' };
const DM = { kind: 'dm' as const, ref: '!owner-dm' };
const owner = { signedIn: true, identifier: 'uuid-owner', name: 'Owner' };
const guest = { signedIn: false, identifier: 'guest-1', name: 'Visitor' };
const NOW = new Date('2026-10-28T10:00:00Z');

function fileRow(n: number, created: string, extra: Record<string, unknown> = {}) {
  return {
    id: `file-${n}`, number: n, owner_id: 'owner', source: 'person', kind: 'document', name: `doc-${n}.pdf`, mime_type: 'application/pdf',
    size_bytes: 10, line: null, made_with: null, made_prompt: null, length_seconds: null, pages: null, chat_kind: 'dm', chat_ref: '!owner-dm', text_state: 'kept', text_chars: 100, created_at: new Date(created), ...extra,
  };
}

function artifact(id: string, updated: string, extra: Record<string, unknown> = {}) {
  db.artifacts.push({
    id, title: `Board ${id}`, kind: 'app', makerName: 'Scout', latestVersion: 2, ownerId: 'owner', chatKind: 'nearby', chatRef: 'room#2#200',
    expiresAt: null, updatedAt: new Date(updated), ...extra,
  });
}

/** Answers the count, the page and the hits from a list of rows; records what it was asked. */
function fakeSql(rows: ReturnType<typeof fileRow>[], hits: { bot_file_id: string; start: number; text: string }[] = [], options: { totalFor?: (query: string | null) => number } = {}) {
  const asked: { sql: string; values: unknown[] }[] = [];
  const run = (async (sql: string, values: unknown[]) => {
    asked.push({ sql, values });
    const query = values[7] as string | null;
    if (sql.includes('DISTINCT ON')) return hits.filter((hit) => (values[0] as string[]).includes(hit.bot_file_id));
    const total = options.totalFor ? options.totalFor(query) : rows.length;
    if (sql.includes('count(*)')) return [{ total }];
    return total === 0 ? [] : rows.slice(0, Number(/LIMIT (\d+)/.exec(sql)?.[1]));
  }) as SqlRunner;
  return { run, asked };
}

describe('finding files in bot chats (game #1508)', () => {
  beforeEach(() => {
    db.reset();
    resetFilePruneClock();
    addUser('owner');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ hidden: false });
    (takeForgets as jest.Mock).mockReset().mockResolvedValue({ everyone: false, userUuids: new Set(), rows: [] });
  });

  describe('the words of a search', () => {
    it('keeps letters and digits of any language, lowercased, each as the start of a word, so nothing else reaches the query', () => {
      expect(searchWords('The YAZOGHAL song, 2nd!')).toEqual(['the', 'yazoghal', 'song', '2nd']);
      expect(searchWords("x') OR 1=1; DROP TABLE --")).toEqual(['x', 'or', '1', 'drop', 'table']);
      expect(searchWords('مرحبا بالجميع')).toEqual(['مرحبا', 'بالجميع']);
      // Arabic short vowels and tatweel never split a word and are left out, so marked and unmarked words meet
      expect(searchWords('\u0645\u064e\u0631\u0652\u062d\u064e\u0628\u064b\u0627 \u0628\u0640\u0640\u0627\u0644')).toEqual(['مرحبا', 'بال']);
      expect(searchWords('\u064e \u0652')).toEqual([]);
      // An accent typed apart joins its letter
      expect(searchWords('cafe\u0301')).toEqual(['café']);
      expect(searchWords('a b c d e f g h i j')).toHaveLength(8);
      expect(wordQuery(['yazo', 'song'], 'all')).toBe('yazo:* & song:*');
      expect(wordQuery(['yazo', 'song'], 'any')).toBe('yazo:* | song:*');
      expect(wordQuery([], 'all')).toBeNull();
    });

    it('points at the first word inside a part, with the text around it', () => {
      const text = `${'Intro words. '.repeat(20)}Launch day is Thursday. We sing yazoghal at the gate.`;
      const hit = hitOf(9100, text, ['yazoghal', 'thursday']);
      expect(hit.at).toBe(9100 + text.indexOf('Thursday') - 60);
      expect(hit.snippet).toContain('Thursday');
      expect(hit.snippet.startsWith('…')).toBe(true);
      // In text with Arabic short vowels, an unmarked word is still found where it is
      const marked = 'Intro. \u0645\u064e\u0631\u0652\u062d\u064e\u0628\u064b\u0627 friends';
      expect(hitOf(0, marked, ['مرحبا']).snippet).toBe(marked);
      expect(hitOf(1000, `${'x '.repeat(100)}${marked}`, ['مرحبا']).at).toBe(1000 + 200 + 7 - 60);
      // A word inside another word is not a match
      expect(hitOf(0, 'notyazoghal yazoghal', ['yazoghal']).at).toBe(0);
    });
  });

  describe('one page of files and artifacts', () => {
    it('merges both lists newest first, and pages through them with the total', async () => {
      const sql = fakeSql([fileRow(3, '2026-10-27T10:00:00Z'), fileRow(2, '2026-10-25T10:00:00Z'), fileRow(1, '2026-10-20T10:00:00Z')]);
      artifact('a-new', '2026-10-26T10:00:00Z');
      artifact('a-old', '2026-10-19T10:00:00Z');
      const first = await findFiles({ botId: 'bot1', person: owner, chat: DM, limit: 2 }, { now: NOW, sql: sql.run });
      expect(first.items.map((item) => (item.type === 'file' ? item.ref : item.id))).toEqual(['f3', 'a-new']);
      expect(first).toMatchObject({ total: 5, page: 1, pages: 3, matched: null, hidden: false });
      const third = await findFiles({ botId: 'bot1', person: owner, chat: DM, limit: 2, page: 3 }, { now: NOW, sql: sql.run });
      expect(third.items.map((item) => (item.type === 'file' ? item.ref : item.id))).toEqual(['a-old']);
      // Each list is asked for its top (page × size), never everything
      expect(sql.asked.at(-1)?.sql).toMatch(/LIMIT 6$/);
    });

    it('shows how each file was made in one short line, so a page of long prompts stays small', async () => {
      const longPrompt = `${'A slow oud ballad about the north gate at night, '.repeat(200)}`.slice(0, 8000);
      const rows = Array.from({ length: 10 }, (_, i) => fileRow(10 - i, `2026-10-2${i % 8}T10:00:00Z`, { source: 'bot', kind: 'audio', made_with: 'generate_music', made_prompt: longPrompt }));
      const page = await findFiles({ botId: 'bot1', person: owner, chat: DM, kinds: ['audio'], limit: 10 }, { now: NOW, sql: fakeSql(rows).run });
      expect(page.items).toHaveLength(10);
      const made = (page.items[0] as FoundFile).made;
      expect(made).toMatchObject({ with: 'generate_music', promptChars: 8000 });
      expect(made?.prompt?.length).toBeLessThanOrEqual(200);
      expect(made?.prompt).toMatch(/ballad about\b.*…$/);
      expect(made?.prompt).not.toMatch(/\s…$/);
      // Ten whole prompts would be 80,000 characters
      expect(JSON.stringify(page).length).toBeLessThan(6000);
    });

    it('keeps a short prompt whole, on one line', async () => {
      const rows = [fileRow(1, '2026-10-27T10:00:00Z', { source: 'bot', made_with: 'generate_music', made_prompt: 'A slow\noud ballad' })];
      const page = await findFiles({ botId: 'bot1', person: owner, chat: DM, kinds: ['audio'], limit: 10 }, { now: NOW, sql: fakeSql(rows).run });
      expect((page.items[0] as FoundFile).made).toEqual({ with: 'generate_music', prompt: 'A slow oud ballad', promptChars: 17 });
    });

    it('merge keeps the order stable when dates tie', () => {
      const file = { type: 'file', ref: 'f1', createdAt: '2026-10-01T00:00:00.000Z' } as FoundFile;
      const art = { type: 'artifact', id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' } as FoundArtifact;
      expect(mergePage([file], [art], 0, 10)).toEqual([file, art]);
    });

    it('finds artifacts by the rule bots use for them: this chat\'s and the person\'s own, never someone else\'s from another chat', async () => {
      artifact('mine-elsewhere', '2026-10-26T10:00:00Z');
      artifact('in-this-bubble', '2026-10-25T10:00:00Z', { ownerId: 'friend', chatRef: 'room#1#100' });
      artifact('friend-elsewhere', '2026-10-24T10:00:00Z', { ownerId: 'friend' });
      artifact('guest-gone', '2026-10-23T10:00:00Z', { ownerId: null, chatRef: 'room#1#100', expiresAt: new Date('2026-10-27T00:00:00Z') });
      const found = await findFiles({ botId: 'bot1', person: owner, chat: BUBBLE, limit: 10 }, { now: NOW, sql: fakeSql([]).run });
      expect(found.items.map((item) => (item as FoundArtifact).id)).toEqual(['mine-elsewhere', 'in-this-bubble']);
      expect(found.items[0]).toMatchObject({ type: 'artifact', title: 'Board mine-elsewhere', version: 2, mine: true, inThisChat: false });
      expect(found.items[1]).toMatchObject({ mine: false, inThisChat: true });
      // A guest finds only the chat's
      const asGuest = await findFiles({ botId: 'bot1', person: guest, chat: BUBBLE, limit: 10 }, { now: NOW, sql: fakeSql([]).run });
      expect(asGuest.items.map((item) => (item as FoundArtifact).id)).toEqual(['in-this-bubble']);
    });

    it('searches artifact titles with the same words, and only artifacts when asked for them', async () => {
      artifact('quests', '2026-10-26T10:00:00Z', { title: 'Quests board' });
      artifact('menu', '2026-10-25T10:00:00Z', { title: 'Lunch menu' });
      const sql = fakeSql([fileRow(1, '2026-10-20T10:00:00Z')]);
      const found = await findFiles({ botId: 'bot1', person: owner, chat: OTHER_BUBBLE, words: 'quests', kinds: ['artifact'], limit: 10 }, { now: NOW, sql: sql.run });
      expect(found.items.map((item) => (item as FoundArtifact).id)).toEqual(['quests']);
      expect(sql.asked).toHaveLength(0);
    });

    it('leaves artifacts out for files the person sent, or for a kind of file', async () => {
      artifact('quests', '2026-10-26T10:00:00Z');
      const sql = fakeSql([fileRow(1, '2026-10-20T10:00:00Z')]);
      const sent = await findFiles({ botId: 'bot1', person: owner, chat: DM, source: 'person', limit: 10 }, { now: NOW, sql: sql.run });
      expect(sent.items.every((item) => item.type === 'file')).toBe(true);
      const audio = await findFiles({ botId: 'bot1', person: owner, chat: DM, kinds: ['audio'], limit: 10 }, { now: NOW, sql: sql.run });
      expect(audio.items.every((item) => item.type === 'file')).toBe(true);
      expect(sql.asked.at(-1)?.values[6]).toEqual(['audio']);
    });

    it('passes the scope, the filters and the super admin\'s days to the SQL', async () => {
      const sql = fakeSql([]);
      await findFiles(
        { botId: 'bot1', person: owner, chat: DM, source: 'bot', since: '2026-10-01T00:00:00Z', until: 'not a date', limit: 10 },
        { now: NOW, sql: sql.run, limits: { text: 2_000_000, findable: 30 } },
      );
      const values = sql.asked[0].values;
      expect(values.slice(0, 5)).toEqual(['bot1', 'owner', 'dm', '!owner-dm', NOW.toISOString()]);
      expect(values[5]).toBe('2026-09-28T10:00:00.000Z');
      expect(values[8]).toBe('bot');
      expect(values[9]).toBe('2026-10-01T00:00:00.000Z');
      expect(values[10]).toBeNull();
    });

    it('says when nothing had every word and shows what has any of them', async () => {
      const sql = fakeSql([fileRow(1, '2026-10-20T10:00:00Z')], [], { totalFor: (query) => (query?.includes('&') ? 0 : 1) });
      const found = await findFiles({ botId: 'bot1', person: owner, chat: DM, words: 'thursday piano', limit: 10 }, { now: NOW, sql: sql.run });
      expect(found.matched).toBe('any');
      expect(found.total).toBe(1);
      expect(sql.asked.map((ask) => ask.values[7])).toContain('thursday:* | piano:*');
    });

    it('says where the words are, for the files on the page only', async () => {
      const text = 'Launch day is Thursday. We sing yazoghal at the gate.';
      const sql = fakeSql([fileRow(2, '2026-10-25T10:00:00Z'), fileRow(1, '2026-10-20T10:00:00Z')], [
        { bot_file_id: 'file-2', start: 9100, text },
        { bot_file_id: 'file-1', start: 0, text },
      ]);
      const found = await findFiles({ botId: 'bot1', person: owner, chat: DM, words: 'yazoghal', limit: 1 }, { now: NOW, sql: sql.run });
      expect(found.items).toHaveLength(1);
      expect((found.items[0] as FoundFile).hit).toEqual({ at: 9100, snippet: text });
      expect(sql.asked.at(-1)?.values[0]).toEqual(['file-2']);
    });

    it('carries the hidden flag, and is turned down for a person the bot does not let in', async () => {
      (loadBotPrivacy as jest.Mock).mockResolvedValue({ hidden: true });
      expect((await findFiles({ botId: 'bot1', person: owner, chat: DM, limit: 10 }, { now: NOW, sql: fakeSql([]).run })).hidden).toBe(true);
      (checkBotAccess as jest.Mock).mockResolvedValue({ allowed: false });
      await expect(findFiles({ botId: 'bot1', person: owner, chat: DM, limit: 10 }, { now: NOW, sql: fakeSql([]).run })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('reading a kept file by place', () => {
    async function keptFile(text: string) {
      const made = await addFile(
        { botId: 'bot1', person: owner, chat: DM, source: 'person', kind: 'document', name: 'plan.pdf', store: { bucket: 'user-refs', fileId: '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf' } },
        { now: NOW },
      );
      await keepFileText({ botId: 'bot1', person: owner, chat: DM, ref: made.file.ref, text }, { now: NOW });
      return made.file.ref;
    }

    it('reads from a place across parts, and says where the next read starts', async () => {
      const text = Array.from({ length: 25_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
      const ref = await keptFile(text);
      const first = await readFileText({ botId: 'bot1', person: owner, chat: DM, ref, chars: 8_000 }, { now: NOW });
      expect(first).toMatchObject({ text: text.slice(0, 8_000), at: 0, end: 8_000, next: 8_000 });
      const across = await readFileText({ botId: 'bot1', person: owner, chat: DM, ref, at: 9_500, chars: 8_000 }, { now: NOW });
      expect(across.text).toBe(text.slice(9_500, 17_500));
      const last = await readFileText({ botId: 'bot1', person: owner, chat: DM, ref, at: 20_000, chars: 8_000 }, { now: NOW });
      expect(last).toMatchObject({ text: text.slice(20_000), end: 25_000, next: null });
      const past = await readFileText({ botId: 'bot1', person: owner, chat: DM, ref, at: 99_999, chars: 8_000 }, { now: NOW });
      expect(past).toMatchObject({ text: '', at: 25_000, next: null });
    });

    it('only for a file the person may use here', async () => {
      const ref = await keptFile('private words');
      await expect(readFileText({ botId: 'bot1', person: guest, chat: BUBBLE, ref, chars: 8_000 }, { now: NOW })).rejects.toMatchObject({ status: 404 });
      await expect(readFileText({ botId: 'bot2', person: owner, chat: DM, ref, chars: 8_000 }, { now: NOW })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the routes', () => {
    const post = async (handler: unknown, body: unknown, token: string | null = 'bot-token') => {
      const request = new NextRequest('http://localhost:3333/api/bot-files/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const response = await (handler as (request: NextRequest) => Promise<Response>)(request);
      return { status: response.status, body: await response.json() };
    };
    const env = process.env.BOT_SERVICE_TOKEN;
    beforeAll(() => {
      process.env.BOT_SERVICE_TOKEN = 'bot-token';
    });
    afterAll(() => {
      process.env.BOT_SERVICE_TOKEN = env;
    });

    it('only the bot server reaches them', async () => {
      expect((await post(findRoute, { botId: 'bot1', person: owner, chat: DM, limit: 10 }, null)).status).toBe(401);
      expect((await post(readRoute, { botId: 'bot1', person: owner, chat: DM, ref: 'f1', chars: 8000 }, 'wrong')).status).toBe(401);
    });

    it('turn down a page size or a read outside the settings\' ranges', async () => {
      expect((await post(findRoute, { botId: 'bot1', person: owner, chat: DM, limit: 101 })).status).toBe(400);
      expect((await post(findRoute, { botId: 'bot1', person: owner, chat: DM, limit: 0 })).status).toBe(400);
      expect((await post(findRoute, { botId: 'bot1', person: owner, chat: DM, limit: 10, kinds: ['spreadsheet'] })).status).toBe(400);
      expect((await post(readRoute, { botId: 'bot1', person: owner, chat: DM, ref: 'f1', chars: 5_000_001 })).status).toBe(400);
    });

    it('reads through the route', async () => {
      const made = await addFile(
        { botId: 'bot1', person: owner, chat: DM, source: 'person', kind: 'document', name: 'plan.pdf', store: { bucket: 'user-refs', fileId: '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf' } },
        { now: new Date() },
      );
      await keepFileText({ botId: 'bot1', person: owner, chat: DM, ref: made.file.ref, text: 'hello there' }, { now: new Date() });
      const res = await post(readRoute, { botId: 'bot1', person: owner, chat: DM, ref: made.file.ref, at: 6, chars: 8000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ text: 'there', at: 6, end: 11, next: null, hidden: false });
    });
  });
});
