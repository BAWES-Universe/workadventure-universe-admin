import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { POST as add } from '@/app/api/bot-files/route';
import { POST as get } from '@/app/api/bot-files/get/route';
import { POST as keepText } from '@/app/api/bot-files/text/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy, takeForgets } from '@/lib/bot-privacy';
import { TEXT_PART_CHARS, addFile, forgetFilesWhere, getFile, pruneGoneFiles, resetFilePruneClock, splitText } from '@/lib/bot-files';
import { addUser, db, fakePrisma } from '../../helpers/bot-files-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/bot-files-db').fakePrisma }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn(), takeForgets: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const BUBBLE = { kind: 'nearby', ref: 'room#7#1730000000' };
const LATER_BUBBLE = { kind: 'nearby', ref: 'room#9#1730009999' };
const DM = { kind: 'dm', ref: '!owner-dm:chat.example' };
const FILE_ID = '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.mp3';
const STORE = { bucket: 'bot-gens', fileId: FILE_ID };

const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, identifier: 'guest-uuid-1', name: 'Visitor' };

async function call(handler: unknown, body: unknown, options: { token?: string | null; cookie?: string } = {}) {
  const token = options.token === undefined ? BOT_TOKEN : options.token;
  const request = new NextRequest('http://localhost:3333/api/bot-files', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await (handler as (request: NextRequest) => Promise<Response>)(request);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const song = (who: object = person('owner'), chat: object = BUBBLE, extra: object = {}) => ({
  botId: 'bot1',
  person: who,
  chat,
  source: 'bot',
  kind: 'audio',
  name: 'yazoghal.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 2_400_000,
  store: STORE,
  line: 'Song "yazoghal", made with the music tool',
  ...extra,
});

async function addSong(who: object = person('owner'), chat: object = BUBBLE, extra: object = {}) {
  const res = await call(add, song(who, chat, extra));
  expect(res.status).toBe(200);
  return res.body.file.ref as string;
}

/** The Forgets the bot server has not yet reported it dropped (lib/bot-privacy.ts takeForgets). */
function forgetting(options: { everyone?: boolean; uuids?: string[]; afterCalls?: number } = {}) {
  const answer = { everyone: options.everyone ?? false, userUuids: new Set(options.uuids ?? []), rows: [] };
  const none = { everyone: false, userUuids: new Set<string>(), rows: [] };
  let calls = 0;
  (takeForgets as jest.Mock).mockReset().mockImplementation(async () => (calls++ >= (options.afterCalls ?? 0) ? answer : none));
}

const open = (ref: string, who: object, chat: object, botId = 'bot1') => call(get, { botId, person: who, chat, ref });

describe('files in bot chats (game #1508)', () => {
  const env = { bot: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN };
  beforeAll(() => {
    process.env.BOT_SERVICE_TOKEN = BOT_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  });
  afterAll(() => {
    process.env.BOT_SERVICE_TOKEN = env.bot;
    process.env.ADMIN_API_TOKEN = env.admin;
  });
  beforeEach(() => {
    db.reset();
    resetFilePruneClock();
    addUser('owner');
    addUser('friend');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ hidden: false });
    forgetting();
    (Sentry.captureException as jest.Mock).mockReset();
  });

  describe('who can reach the routes', () => {
    it('only the bot server: no token, a wrong one, or a manager\'s session cookie gets 401', async () => {
      expect((await call(add, song(), { token: null })).status).toBe(401);
      expect((await call(get, { botId: 'bot1', person: person('owner'), chat: BUBBLE, ref: 'f1' }, { token: 'nope' })).status).toBe(401);
      expect((await call(add, song(), { token: null, cookie: 'orbit_session=manager-session' })).status).toBe(401);
      expect(db.files).toHaveLength(0);
    });

    it('the admin token also works, as for artifacts', async () => {
      expect((await call(add, song(), { token: ADMIN_TOKEN })).status).toBe(200);
    });

    it('turns down a person the bot does not let in, and a bot that is not there', async () => {
      (checkBotAccess as jest.Mock).mockResolvedValueOnce({ allowed: false, reason: 'Guests cannot use this bot.' });
      expect((await call(add, song(guest))).status).toBe(403);
      (checkBotAccess as jest.Mock).mockResolvedValueOnce(null);
      expect((await call(add, song())).status).toBe(404);
      expect(db.files).toHaveLength(0);
    });

    it('asks the access check for a direct message in a direct message and for chat in a bubble', async () => {
      await addSong(person('owner'), DM);
      expect((checkBotAccess as jest.Mock).mock.calls[0][0]).toMatchObject({ botId: 'bot1', action: 'dm' });
      await addSong(person('owner'), BUBBLE);
      expect((checkBotAccess as jest.Mock).mock.calls[1][0]).toMatchObject({ action: 'chat' });
    });
  });

  describe('adding a file', () => {
    it('gives short ids from one count per bot, so two people in a bubble never share one', async () => {
      expect(await addSong(person('owner'))).toBe('f1');
      expect(await addSong(person('friend'))).toBe('f2');
      expect(await addSong(person('owner'), DM)).toBe('f3');
      // Another bot starts its own count
      const other = await call(add, { ...song(), botId: 'bot2' });
      expect(other.body.file.ref).toBe('f1');
    });

    it('never gives the same id twice when files are added at the same moment', async () => {
      const refs = await Promise.all(Array.from({ length: 20 }, (_, i) => addSong(person(i % 2 ? 'owner' : 'friend'), i % 3 ? BUBBLE : DM)));
      expect(new Set(refs).size).toBe(20);
    });

    it('keeps the bucket and the uploader id, the owner\'s account, and says what the bot needs', async () => {
      const res = await call(add, song());
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).toEqual({
        hidden: false,
        file: {
          ref: 'f1',
          name: 'yazoghal.mp3',
          kind: 'audio',
          source: 'bot',
          mimeType: 'audio/mpeg',
          sizeBytes: 2_400_000,
          line: 'Song "yazoghal", made with the music tool',
          made: null,
          lengthSeconds: null,
          pages: null,
          store: STORE,
          mine: true,
          inThisChat: true,
          text: { state: 'none', chars: 0 },
          createdAt: expect.any(String),
        },
      });
      expect(db.files[0]).toMatchObject({ ownerId: 'owner', personRef: 'uuid-owner', bucket: 'bot-gens', fileId: FILE_ID, url: null, expiresAt: null });
    });

    it('keeps a link that lasts, like the uploader\'s own /upload-file link when no bucket was used', async () => {
      const url = `https://uploader.example/upload-file/${FILE_ID}`;
      const res = await call(add, song(person('owner'), BUBBLE, { store: { url } }));
      expect(res.status).toBe(200);
      expect(res.body.file.store).toEqual({ url });
    });

    it('turns down a signed link, which would expire, and anything that is not an uploader file', async () => {
      const signed = `https://s3.example/user-refs/${FILE_ID}?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc`;
      const res = await call(add, song(person('owner'), BUBBLE, { store: { url: signed } }));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('signed_link');
      for (const store of [{ bucket: 'bot-gens', fileId: '../secret.txt' }, { bucket: '../x', fileId: FILE_ID }, { url: 'javascript:alert(1)' }, { url: 'https://user:pw@x.example/f' }]) {
        expect((await call(add, song(person('owner'), BUBBLE, { store }))).status).toBe(422);
      }
      expect((await call(add, song(person('owner'), BUBBLE, { store: { bucket: 'b', fileId: FILE_ID, url: 'https://x' } }))).status).toBe(400);
      expect(db.files).toHaveLength(0);
    });

    it('opens an uploader id with any extension the uploader keeps, up to 16 characters', async () => {
      const ok = await call(add, song(person('owner'), BUBBLE, { store: { bucket: 'user-refs', fileId: FILE_ID.replace('.mp3', '.webmanifest') } }));
      expect(ok.status).toBe(200);
      const tooLong = await call(add, song(person('owner'), BUBBLE, { store: { bucket: 'user-refs', fileId: FILE_ID.replace('.mp3', '.abcdefghijklmnopq') } }));
      expect(tooLong.status).toBe(422);
    });

    it('keeps how a made file was made, and its length or pages, so the bot can make one like it again', async () => {
      const res = await call(add, song(person('owner'), BUBBLE, { madeWith: 'generate_music', madePrompt: 'A slow oud song about the gate,\nin Kuwaiti dialect', lengthSeconds: 150 }));
      expect(res.body.file).toMatchObject({ made: { with: 'generate_music', prompt: 'A slow oud song about the gate,\nin Kuwaiti dialect' }, lengthSeconds: 150, pages: null });
      const pdf = await call(add, song(person('owner'), BUBBLE, { source: 'person', kind: 'document', name: 'plan.pdf', pages: 41, madeWith: 'not mine' }));
      // Only what the bot sent was made by a tool
      expect(pdf.body.file).toMatchObject({ made: null, pages: 41 });
      // A long prompt is kept whole, up to "Text kept from a file", like a document's text
      const long = await call(add, song(person('owner'), BUBBLE, { madeWith: 'generate_music', madePrompt: 'x'.repeat(50_000) }));
      expect(long.body.file.made.prompt).toHaveLength(50_000);
      expect((await call(add, song(person('owner'), BUBBLE, { lengthSeconds: -1 }))).status).toBe(400);
    });

    it('cleans the name and the line to one short line, and needs a name', async () => {
      const res = await call(add, song(person('owner'), BUBBLE, { name: '  song\n\tone.mp3 ', line: 'x'.repeat(900) }));
      expect(res.body.file.name).toBe('song one.mp3');
      expect(res.body.file.line).toHaveLength(300);
      expect((await call(add, song(person('owner'), BUBBLE, { name: ' \n ' }))).status).toBe(422);
    });

    it('carries the bot\'s hidden flag in every answer, so the bot server keeps names and text out of telemetry', async () => {
      (loadBotPrivacy as jest.Mock).mockResolvedValue({ hidden: true });
      const ref = await addSong();
      expect((await open(ref, person('owner'), BUBBLE)).body.hidden).toBe(true);
      expect((await call(keepText, { botId: 'bot1', person: person('owner'), chat: BUBBLE, ref, text: 'words' })).body.hidden).toBe(true);
    });
  });

  describe('who may use a file', () => {
    it('the owner, from any chat with this bot: a later bubble, or their direct messages', async () => {
      const ref = await addSong(person('owner'), BUBBLE);
      expect((await open(ref, person('owner'), LATER_BUBBLE)).status).toBe(200);
      const fromDm = await open(ref, person('owner'), DM);
      expect(fromDm.status).toBe(200);
      expect(fromDm.body.file).toMatchObject({ mine: true, inThisChat: false });
    });

    it('a friend only while in the bubble it came in, and then never again', async () => {
      const ref = await addSong(person('owner'), BUBBLE);
      const during = await open(ref, person('friend'), BUBBLE);
      expect(during.status).toBe(200);
      expect(during.body.file).toMatchObject({ mine: false, inThisChat: true });
      const after = await open(ref, person('friend'), LATER_BUBBLE);
      expect(after.status).toBe(404);
      expect(after.body.error).toBe('not_found');
    });

    it('nobody else ever reaches a file from the owner\'s direct messages', async () => {
      const ref = await addSong(person('owner'), DM);
      expect((await open(ref, person('friend'), BUBBLE)).status).toBe(404);
      expect((await open(ref, person('friend'), { kind: 'dm', ref: '!friend-dm:chat.example' })).status).toBe(404);
      expect((await open(ref, guest, BUBBLE)).status).toBe(404);
    });

    it('bot B can not open a file sent to bot A', async () => {
      const ref = await addSong(person('owner'), DM);
      expect((await open(ref, person('owner'), DM, 'bot2')).status).toBe(404);
    });

    it('an id that is not a short id, or one that was never given, looks the same as one you may not use', async () => {
      await addSong();
      for (const ref of ['f2', 'f0', 'x1', 'f1; drop table', 'f99999999999']) {
        const res = await open(ref, person('owner'), BUBBLE);
        expect([400, 404]).toContain(res.status);
      }
    });
  });

  describe('guests', () => {
    it('a guest\'s file has no owner, works only in its chat, and goes after a day', async () => {
      const now = new Date('2026-10-28T10:00:00Z');
      const made = await addFile(song(guest) as Parameters<typeof addFile>[0], { now });
      expect(db.files[0]).toMatchObject({ ownerId: null, personRef: 'guest-uuid-1' });
      expect(db.files[0].expiresAt.toISOString()).toBe('2026-10-29T10:00:00.000Z');
      const call = { botId: 'bot1', person: guest, chat: BUBBLE as never, ref: made.file.ref };
      await expect(getFile(call, { now: new Date('2026-10-29T09:59:00Z') })).resolves.toBeTruthy();
      await expect(getFile({ ...call, chat: LATER_BUBBLE as never }, { now })).rejects.toMatchObject({ status: 404 });
      await expect(getFile(call, { now: new Date('2026-10-29T10:00:01Z') })).rejects.toMatchObject({ status: 404 });
    });

    it('a guest account in Orbit counts as a guest', async () => {
      addUser('visitor', { uuid: 'guest-uuid-1', isGuest: true });
      await addSong({ ...guest, signedIn: true });
      expect(db.files[0].ownerId).toBeNull();
    });

    it('the tidy-up removes guests\' files past their day, with their text', async () => {
      const now = new Date('2026-10-28T10:00:00Z');
      await addFile(song(guest) as Parameters<typeof addFile>[0], { now });
      await addFile(song(person('owner')) as Parameters<typeof addFile>[0], { now });
      db.parts.push({ botFileId: db.files[0].id, number: 1, start: 0, text: 'x' });
      expect(await pruneGoneFiles({ now: new Date('2026-10-29T10:00:01Z') })).toBe(1);
      expect(db.files.map((file) => file.ownerId)).toEqual(['owner']);
      expect(db.parts).toHaveLength(0);
    });
  });

  describe('how long files can be found', () => {
    it('always by default, until the person asks the bot to forget them', async () => {
      const made = await addFile(song() as Parameters<typeof addFile>[0], { now: new Date('2020-01-01T00:00:00Z') });
      const ref = { botId: 'bot1', person: person('owner'), chat: DM as never, ref: made.file.ref };
      await expect(getFile(ref, { now: new Date('2026-10-28T00:00:00Z') })).resolves.toBeTruthy();
      expect(await pruneGoneFiles({ now: new Date('2026-10-28T00:00:00Z') })).toBe(0);
    });

    it('for the days the super admin sets, and older ones are removed', async () => {
      const limits = { text: 2_000_000, findable: 30 };
      const made = await addFile(song() as Parameters<typeof addFile>[0], { now: new Date('2026-09-01T00:00:00Z'), limits });
      const ref = { botId: 'bot1', person: person('owner'), chat: DM as never, ref: made.file.ref };
      await expect(getFile(ref, { now: new Date('2026-09-30T00:00:00Z'), limits })).resolves.toBeTruthy();
      await expect(getFile(ref, { now: new Date('2026-10-02T00:00:00Z'), limits })).rejects.toMatchObject({ status: 404 });
      expect(await pruneGoneFiles({ now: new Date('2026-10-02T00:00:00Z'), limits })).toBe(1);
    });
  });

  describe('keeping a file\'s text', () => {
    const keep = (ref: string, body: object, who: object = person('owner'), chat: object = BUBBLE) =>
      call(keepText, { botId: 'bot1', person: who, chat, ref, ...body });

    it('keeps the whole text in parts, in order, and says how much', async () => {
      const ref = await addSong(person('owner'), BUBBLE, { kind: 'document', name: 'plan.pdf' });
      const text = 'a'.repeat(TEXT_PART_CHARS * 2 + 5);
      const res = await keep(ref, { text });
      expect(res.status).toBe(200);
      expect(res.body.file.text).toEqual({ state: 'kept', chars: text.length });
      expect(db.parts.map((part) => [part.number, part.start, part.text.length])).toEqual([
        [1, 0, TEXT_PART_CHARS],
        [2, TEXT_PART_CHARS, TEXT_PART_CHARS],
        [3, TEXT_PART_CHARS * 2, 5],
      ]);
    });

    it('replaces what was kept before, and can say it could not be read', async () => {
      const ref = await addSong(person('owner'), BUBBLE, { kind: 'document' });
      await keep(ref, { text: 'first '.repeat(5000) });
      await keep(ref, { text: 'second' });
      expect(db.parts.map((part) => part.text)).toEqual(['second']);
      const failed = await keep(ref, { failed: true });
      expect(failed.body.file.text).toEqual({ state: 'failed', chars: 0 });
      expect(db.parts).toHaveLength(0);
      expect((await keep(ref, { text: 'x', failed: true })).status).toBe(422);
      expect((await keep(ref, {})).status).toBe(422);
    });

    it('keeps no more than the super admin\'s limit, and never the null character', async () => {
      const made = await addFile(song() as Parameters<typeof addFile>[0], { now: new Date() });
      const { keepFileText } = await import('@/lib/bot-files');
      const kept = await keepFileText(
        { botId: 'bot1', person: person('owner'), chat: BUBBLE as never, ref: made.file.ref, text: 'ab\u0000c'.repeat(100) },
        { now: new Date(), limits: { text: 50, findable: 0 } },
      );
      expect(kept.file.text.chars).toBe(50);
      expect(db.parts.map((part) => part.text).join('')).not.toContain('\u0000');
    });

    it('only for a file this person may use', async () => {
      const ref = await addSong(person('owner'), DM);
      expect((await keep(ref, { text: 'not mine' }, person('friend'), BUBBLE)).status).toBe(404);
      expect(db.parts).toHaveLength(0);
    });
  });

  it('splits text without breaking an emoji in two', () => {
    const text = 'a'.repeat(9) + '😀' + 'b';
    const parts = splitText(text, 10);
    expect(parts.map((part) => part.text)).toEqual(['a'.repeat(9), '😀b']);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts[1].start).toBe(9);
  });

  describe('forget', () => {
    it('keeps nothing for a person while a Forget for them is still going, and still adds for anyone else', async () => {
      forgetting({ uuids: ['uuid-owner'] });
      const res = await call(add, song(person('owner')));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('forgotten');
      expect(db.files).toHaveLength(0);
      expect((await call(add, song(person('friend')))).status).toBe(200);
      forgetting({ everyone: true });
      expect((await call(add, song(person('friend')))).status).toBe(409);
      expect((await call(add, song(guest))).status).toBe(409);
      expect(db.files).toHaveLength(1);
    });

    it('takes a file out again when Forget was pressed while it was being written', async () => {
      // The first check passes; the Forget lands before the second
      forgetting({ uuids: ['uuid-owner'], afterCalls: 1 });
      const res = await call(add, song(person('owner')));
      expect(res.status).toBe(409);
      expect(db.files).toHaveLength(0);
    });

    it('keeps no text for a person being forgotten', async () => {
      const ref = await addSong(person('owner'), DM);
      forgetting({ uuids: ['uuid-owner'] });
      const res = await call(keepText, { botId: 'bot1', person: person('owner'), chat: DM, ref, text: 'kept words' });
      expect(res.status).toBe(409);
      expect(db.parts).toHaveLength(0);
    });

    it('answers "not found" when the file went while its text was being kept', async () => {
      const ref = await addSong(person('owner'), DM);
      const createMany = fakePrisma.botFilePart.createMany;
      fakePrisma.botFilePart.createMany = async () => {
        db.files.length = 0;
        throw new Error('foreign key');
      };
      try {
        expect((await call(keepText, { botId: 'bot1', person: person('owner'), chat: DM, ref, text: 'kept words' })).status).toBe(404);
      } finally {
        fakePrisma.botFilePart.createMany = createMany;
      }
    });

    it('one person: by the id the bot server named them by and by their account, never the whole bot', () => {
      expect(forgetFilesWhere('bot1', { userUuid: 'uuid-owner', userId: 'owner' })).toEqual({
        botId: 'bot1',
        OR: [{ personRef: 'uuid-owner' }, { ownerId: 'owner' }],
      });
      expect(forgetFilesWhere('bot1', { userUuid: null, userId: null })).toEqual({ botId: 'bot1', id: { in: [] } });
      expect(forgetFilesWhere('bot1', 'everyone')).toEqual({ botId: 'bot1' });
    });

    it('removes that person\'s files with this bot and their text, and nobody else\'s', async () => {
      const mine = await addSong(person('owner'), DM);
      await addSong(person('friend'), BUBBLE);
      await call(add, { ...song(person('owner'), DM), botId: 'bot2' });
      await call(keepText, { botId: 'bot1', person: person('owner'), chat: DM, ref: mine, text: 'kept words' });
      await fakePrisma.botFile.deleteMany({ where: forgetFilesWhere('bot1', { userUuid: 'uuid-owner', userId: 'owner' }) });
      expect((await open(mine, person('owner'), DM)).status).toBe(404);
      expect(db.files.map((file) => [file.botId, file.ownerId])).toEqual([
        ['bot1', 'friend'],
        ['bot2', 'owner'],
      ]);
      expect(db.parts).toHaveLength(0);
    });
  });

  it('logs no file name or text when something breaks', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const create = fakePrisma.botFile.create;
    fakePrisma.botFile.create = async () => {
      throw new Error('database is down');
    };
    try {
      const res = await call(add, song(person('owner'), BUBBLE, { name: 'secret-plan.pdf', line: 'the secret plan', madeWith: 'generate_music', madePrompt: 'a secret song' }));
      expect(res.status).toBe(500);
      const logged = JSON.stringify([spy.mock.calls, (Sentry.captureException as jest.Mock).mock.calls]);
      expect(logged).not.toContain('secret');
      expect((Sentry.captureException as jest.Mock).mock.calls[0][1]).toEqual({ tags: { area: 'bot-files', route: 'POST /api/bot-files' } });
    } finally {
      fakePrisma.botFile.create = create;
      spy.mockRestore();
    }
  });
});
