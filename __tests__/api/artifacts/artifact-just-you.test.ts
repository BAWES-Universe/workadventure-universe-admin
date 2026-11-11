import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as mine } from '@/app/api/artifacts/mine/route';
import { POST as inChat } from '@/app/api/artifacts/in-chat/route';
import { POST as chatList } from '@/app/api/artifacts/chat/route';
import { POST as change } from '@/app/api/artifacts/[id]/change/route';
import { POST as read } from '@/app/api/artifacts/[id]/read/route';
import { POST as open } from '@/app/api/artifacts/[id]/open/route';
import { POST as versions } from '@/app/api/artifacts/[id]/versions/route';
import { POST as code } from '@/app/api/artifacts/[id]/versions/[number]/route';
import { PUT as share } from '@/app/api/artifacts/[id]/share/route';
import { POST as restore } from '@/app/api/artifacts/[id]/restore/route';
import { POST as copy } from '@/app/api/artifacts/[id]/copy/route';
import { DELETE as remove } from '@/app/api/artifacts/[id]/route';
import { GET as mineOne } from '@/app/api/me/artifacts/[id]/route';
import { GET as privateFile } from '@/app/af/[token]/[number]/[name]/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { getSessionUser } from '@/lib/auth-session';
import { moveStepMs, openByLink, pruneExpired, resetPruneClock } from '@/lib/artifact-service';
import { addBot, addUser, db, fakeFiles, fakePrisma } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

/**
 * "Just you" for things a bot makes (game #1994). The owner picks it in Share; nobody else can open it, in its chat or
 * by link; and the file itself is protected, with its versions and media: a second account is refused everywhere,
 * the address that account held stops working, and no answer ever names where the files now are.
 */

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const ORBIT = 'https://orbit.example.test';
const BUCKET = 'https://files.example.test/';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const DM = { kind: 'dm', ref: '!room:chat.example' };
const PAGE = '<html><body><h1>Trip budget</h1><audio src="song.mp3" controls></audio></body></html>';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Media = { name: string; type: string; bytes: Uint8Array };

const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, name: 'Visitor' };
type Who = ReturnType<typeof person> | typeof guest;
const viewer = (who: Who, inTheChat = true, chat: object | null = NEARBY) => ({ person: who, inChat: inTheChat, ...(chat ? { chat } : {}) });
const SONG: Media = { name: 'song.mp3', type: 'audio/mpeg', bytes: Uint8Array.from({ length: 1000 }, (_, index) => index % 251) };

async function call(handler: unknown, body: unknown, options: { id?: string; number?: string; token?: string; method?: string; media?: Media[] } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? ADMIN_TOKEN}` };
  let payload: BodyInit;
  if (options.media?.length) {
    const form = new FormData();
    form.append('request', JSON.stringify(body));
    for (const file of options.media) form.append('media', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
    payload = form;
  } else {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const request = new NextRequest('http://localhost:3333/api/artifacts', { method: options.method ?? 'POST', headers, body: payload });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '', number: options.number ?? '' }) });
  return { status: response.status, body: await response.json() };
}

const asBot = { token: BOT_TOKEN };

/** A page with a song, made for the owner in the nearby chat, as a bot makes one. */
async function makePage(extra: { who?: Who; chat?: object; kind?: string; content?: string; media?: Media[] } = {}): Promise<string> {
  const body = { botId: 'bot1', person: extra.who ?? person('owner'), chat: extra.chat ?? NEARBY, title: 'Trip budget', kind: extra.kind ?? 'page', content: extra.content ?? PAGE };
  const res = await call(make, body, { ...asBot, media: extra.media ?? [SONG] });
  expect(res.status).toBe(200);
  return res.body.artifact.id as string;
}

const shareAs = (who: Who, id: string, sharing: object, inTheChat = true) => call(share, { viewer: viewer(who, inTheChat), ...sharing }, { id, method: 'PUT' });
const openAs = (who: Who, id: string, inTheChat = true, version?: number) => call(open, { viewer: viewer(who, inTheChat), ...(version ? { version } : {}) }, { id });

async function justYou(id: string) {
  const res = await shareAs(person('owner'), id, { openScope: 'me' });
  expect(res.status).toBe(200);
  expect(res.body.artifact.openScope).toBe('me');
}

const bucketKeys = () => [...db.files.keys()].sort();
const versionRows = (id: string) => db.versions.filter((version) => version.artifactId === id).sort((a, b) => a.number - b.number);
const artifactRow = (id: string) => db.artifacts.find((artifact) => artifact.id === id)!;

/** One request to GET /af/:pass/:version/:name, as a browser makes it. */
async function fetchPrivate(address: string, headers: Record<string, string> = {}) {
  const url = new URL(address);
  const [, af, token, number, name] = url.pathname.split('/');
  expect(af).toBe('af');
  const response = await privateFile(new NextRequest(address, { headers }), { params: Promise.resolve({ token, number, name }) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, text: Buffer.from(bytes).toString('utf8') };
}

/** The cookie a first answer set, as a browser sends it back. */
const cookieOf = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0];

/** The first seconds after a page was first asked for are over: from now on only its cookie opens it. */
function firstSecondsOver(seconds = 11) {
  for (const pass of db.passes) if (pass.redeemedAt) pass.redeemedAt = new Date(pass.redeemedAt.getTime() - seconds * 1000);
}
const inFrame = { 'sec-fetch-dest': 'iframe' };

/** Where the owner's page opens: the answer to opening it. */
async function ownerAddress(id: string, version?: number): Promise<string> {
  const res = await openAs(person('owner'), id, true, version);
  expect(res.status).toBe(200);
  return res.body.version.url as string;
}

describe('"Just you" for things a bot makes (game #1994)', () => {
  const env = { bot: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, orbit: process.env.NEXT_PUBLIC_API_URL, adminUrl: process.env.ADMIN_API_URL, life: process.env.ARTIFACT_PASS_MINUTES, retry: process.env.ARTIFACT_PASS_RETRY_SECONDS };
  const restore_ = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterAll(() => {
    restore_('BOT_SERVICE_TOKEN', env.bot);
    restore_('ADMIN_API_TOKEN', env.admin);
    restore_('NEXT_PUBLIC_API_URL', env.orbit);
    restore_('ADMIN_API_URL', env.adminUrl);
    restore_('ARTIFACT_PASS_MINUTES', env.life);
    restore_('ARTIFACT_PASS_RETRY_SECONDS', env.retry);
  });
  beforeEach(() => {
    process.env.BOT_SERVICE_TOKEN = BOT_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.NEXT_PUBLIC_API_URL = ORBIT;
    delete process.env.ADMIN_API_URL;
    delete process.env.ARTIFACT_PASS_MINUTES;
    delete process.env.ARTIFACT_PASS_RETRY_SECONDS;
    db.reset();
    resetPruneClock();
    jest.restoreAllMocks();
    addUser('owner');
    addUser('friend');
    addUser('stranger');
    addBot('bot1', 'Brick');
    addBot('bot2', 'Pixel');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe('picking it in Share', () => {
    it('lets the owner pick "Just you", and the artifact then says so everywhere its owner reads it', async () => {
      const id = await makePage();
      const res = await shareAs(person('owner'), id, { openScope: 'me' });
      expect(res.status).toBe(200);
      expect(res.body.artifact).toMatchObject({ id, openScope: 'me', title: 'Trip budget' });
      expect((await openAs(person('owner'), id)).body.artifact.openScope).toBe('me');
      expect((await call(mine, { person: person('owner') })).body.artifacts[0]).toMatchObject({ id, openScope: 'me' });
    });

    it('is the owner’s choice only: someone else in the chat is refused, and a guest’s artifact has no owner to keep it', async () => {
      const id = await makePage();
      expect((await shareAs(person('friend'), id, { openScope: 'me' })).status).toBe(403);
      expect((await shareAs(person('stranger'), id, { openScope: 'me' }, false)).status).toBe(404);
      const guests = await makePage({ who: guest });
      expect((await shareAs(guest, guests, { openScope: 'me' })).status).toBe(403);
      expect(artifactRow(id).openScope).toBe('chat');
      expect(artifactRow(guests).openScope).toBe('chat');
    });

    it('still names the choices when the word is not one of them', async () => {
      const id = await makePage();
      const res = await shareAs(person('owner'), id, { openScope: 'everyone' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'invalid_open_scope', message: 'Who can open it is me, chat or link.' });
    });

    it('does nothing when it is "Just you" already: the files stay where they are', async () => {
      const id = await makePage();
      await justYou(id);
      const keys = bucketKeys();
      await justYou(id);
      expect(bucketKeys()).toEqual(keys);
    });
  });

  describe('a second account is refused', () => {
    it('refuses someone in its chat everything they could do a moment ago, with the one plain line', async () => {
      const id = await makePage();
      // The friend is in the chat: before, the card opens for them
      expect((await openAs(person('friend'), id)).status).toBe(200);
      expect((await call(versions, { viewer: viewer(person('friend')) }, { id })).status).toBe(200);
      await justYou(id);

      const refused = await openAs(person('friend'), id);
      expect(refused.status).toBe(404);
      expect(refused.body).toEqual({ error: 'kept_private', message: 'Its owner keeps this one private.' });
      const asFriend = { viewer: viewer(person('friend')) };
      for (const attempt of [
        call(versions, asFriend, { id }),
        call(code, asFriend, { id, number: '1' }),
        call(copy, asFriend, { id }),
        call(restore, { ...asFriend, number: 1 }, { id }),
        call(share, { ...asFriend, openScope: 'link' }, { id, method: 'PUT' }),
        call(remove, asFriend, { id, method: 'DELETE' }),
      ]) {
        const res = await attempt;
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('Trip budget');
      }
      // Nothing happened to it
      expect(artifactRow(id)).toMatchObject({ openScope: 'me', latestVersion: 1 });
    });

    it('tells someone outside its chat nothing: the same answer as for an artifact that is not there', async () => {
      const id = await makePage();
      await justYou(id);
      const outside = await openAs(person('stranger'), id, false);
      const missing = await openAs(person('stranger'), 'no-such-artifact', false);
      expect(outside.status).toBe(404);
      expect(outside.body).toEqual(missing.body);
      // In another chat, or with no chat named, the game's word counts for nothing
      expect((await call(open, { viewer: viewer(person('stranger'), true, { kind: 'nearby', ref: 'bubble-2' }) }, { id })).body.error).toBe('not_found');
      expect((await call(open, { viewer: viewer(person('stranger'), true, null) }, { id })).body.error).toBe('not_found');
      expect((await openAs(guest, id)).body.error).toBe('kept_private');
      expect((await openAs(guest, id, false)).body.error).toBe('not_found');
    });

    it('leaves it out of the chat’s list for everyone but its owner', async () => {
      const id = await makePage();
      const other = await makePage({ who: person('friend') });
      await justYou(id);
      const list = (who: Who, inTheChat = true) => call(chatList, { viewer: viewer(who, inTheChat) });
      expect((await list(person('owner'))).body.artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual([id, other].sort());
      expect((await list(person('friend'))).body).toMatchObject({ artifacts: [{ id: other }], total: 1 });
      expect((await list(guest)).body).toMatchObject({ artifacts: [{ id: other }], total: 1 });
      expect((await list(person('stranger'), false)).body).toMatchObject({ artifacts: [], total: 0 });
      // The owner sees their own from outside the chat, as before
      expect((await list(person('owner'), false)).body).toMatchObject({ artifacts: [{ id }], total: 1 });
    });

    it('never falls back to a link: the public page has nothing, whether it was shared by link before or not', async () => {
      const id = await makePage();
      expect((await shareAs(person('owner'), id, { openScope: 'link' })).status).toBe(200);
      await expect(openByLink(id)).resolves.toMatchObject({ title: 'Trip budget' });
      await justYou(id);
      await expect(openByLink(id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
      // Someone who has the link and is signed in is refused like anyone else
      expect((await openAs(person('stranger'), id, false)).status).toBe(404);
    });

    it('keeps it from a bot that someone else is talking to, in its own chat too', async () => {
      const id = await makePage();
      // Before: allowed to everyone who can open it
      expect((await shareAs(person('owner'), id, { changeScope: 'openers' })).status).toBe(200);
      await justYou(id);
      const asFriend = { botId: 'bot1', person: person('friend'), chat: NEARBY };
      const readIt = await call(read, asFriend, { id, ...asBot });
      expect(readIt.status).toBe(404);
      expect(readIt.body.error).toBe('kept_private');
      expect(JSON.stringify(readIt.body)).not.toContain('budget');
      const changed = await call(change, { ...asFriend, content: '<p>mine now</p>' }, { id, ...asBot });
      expect(changed.status).toBe(404);
      expect((await call(inChat, asFriend, asBot)).body.artifacts).toEqual([]);
      // Pointing at it by link or reply does not help either
      expect((await call(read, { ...asFriend, chat: DM, referencedArtifactIds: [id] }, { id, ...asBot })).body.error).toBe('not_found');
      // The owner's bot still works with it
      expect((await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY }, { id, ...asBot })).body.content).toBe(PAGE);
      expect(versionRows(id)).toHaveLength(1);
    });
  });

  describe('the file itself', () => {
    it('takes away the address the second account held, and puts every version and its media where nobody was told', async () => {
      const id = await makePage();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: PAGE.replace('Trip', 'Our trip') }, { id, ...asBot });
      // The friend opened both versions while it was shared with the chat, and kept their addresses
      const held = [(await openAs(person('friend'), id, true, 1)).body.version.url, (await openAs(person('friend'), id, true, 2)).body.version.url] as string[];
      const heldKeys = held.map((url) => url.replace(BUCKET, ''));
      const before = bucketKeys();
      expect(before).toHaveLength(4);
      expect(heldKeys.every((key) => db.files.has(key))).toBe(true);
      const songBefore = before.filter((key) => key.endsWith('/song.mp3'));

      await justYou(id);

      const after = bucketKeys();
      expect(after).toHaveLength(4);
      // Not one file is where it was: the page of each version, and the song beside each
      expect(after.filter((key) => before.includes(key))).toEqual([]);
      expect(heldKeys.some((key) => db.files.has(key))).toBe(false);
      expect(songBefore.some((key) => db.files.has(key))).toBe(false);
      expect(db.retired).toEqual([]);
      // The versions point at the new files, and they hold what the old ones held
      const rows = versionRows(id);
      expect(await fakeFiles.get(rows[0].fileKey)).toBe(PAGE);
      expect(await fakeFiles.get(rows[1].fileKey)).toBe(PAGE.replace('Trip', 'Our trip'));
      for (const row of rows) {
        expect(row.media).toEqual([{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 1000, key: row.fileKey.replace('index.html', 'song.mp3') }]);
        expect(db.files.get(row.media[0].key)).toEqual(SONG.bytes);
      }
      expect(after).toEqual(rows.flatMap((row) => [row.fileKey, row.media[0].key]).sort());
    });

    it('never names where the files now are, in any answer to anyone', async () => {
      const id = await makePage();
      await justYou(id);
      const secrets = versionRows(id).flatMap((row) => [row.fileKey, row.fileKey.split('/')[2]]);
      const owner = { viewer: viewer(person('owner')) };
      const asOwnersBot = { botId: 'bot1', person: person('owner'), chat: NEARBY };
      const answers = [
        await openAs(person('owner'), id),
        await call(versions, owner, { id }),
        await call(code, owner, { id, number: '1' }),
        await call(mine, { person: person('owner') }),
        await call(chatList, owner),
        await call(read, asOwnersBot, { id, ...asBot }),
        await call(inChat, asOwnersBot, asBot),
        await call(change, { ...asOwnersBot, content: '<p>two</p>' }, { id, ...asBot }),
        await call(restore, { ...owner, number: 1 }, { id }),
        await call(copy, owner, { id }),
        await shareAs(person('owner'), id, { changeScope: 'openers' }),
      ];
      const everyKey = [...secrets, ...db.versions.flatMap((row) => [row.fileKey, row.fileKey.split('/')[2]])];
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        const text = JSON.stringify(answer.body);
        expect(text).not.toContain(BUCKET);
        for (const secret of everyKey) expect(text).not.toContain(secret);
      }
      // The list of versions and the Code view carry no address at all; only opening it gives one, and it is Orbit's own
      expect((await call(versions, owner, { id })).body.versions.map((version: { url: unknown }) => version.url)).toEqual([null, null, null]);
      expect((await call(code, owner, { id, number: '1' })).body.version.url).toBeNull();
      expect(await ownerAddress(id)).toMatch(new RegExp(`^${ORBIT}/af/[A-Za-z0-9_-]{43}/3/index\\.html$`));
    });

    it('keeps a version made after that at an address nobody was told, too', async () => {
      const id = await makePage();
      await justYou(id);
      const changed = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>two</p>' }, { id, ...asBot });
      expect(changed.status).toBe(200);
      expect(changed.body.artifact).toMatchObject({ openScope: 'me', version: 2 });
      expect((await openAs(person('friend'), id)).body.error).toBe('kept_private');
      expect(await ownerAddress(id)).toContain('/2/index.html');
    });

    it('changes nothing when a file cannot be copied: it stays as it was, with its old files and no stray ones', async () => {
      const id = await makePage();
      const before = bucketKeys();
      db.failCopyOf = 'song.mp3';
      const res = await shareAs(person('owner'), id, { openScope: 'me' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('bucket');
      expect(artifactRow(id).openScope).toBe('chat');
      expect(bucketKeys()).toEqual(before);
      expect(db.retired).toEqual([]);
      expect((await openAs(person('friend'), id)).status).toBe(200);
    });

    it('changes nothing when a new version lands while the files move', async () => {
      const id = await makePage();
      const before = bucketKeys();
      const copyInBucket = fakeFiles.copy.bind(fakeFiles);
      jest.spyOn(fakeFiles, 'copy').mockImplementation(async (from, to) => {
        // A bot saved version 2 in the same moment
        artifactRow(id).latestVersion = 2;
        return copyInBucket(from, to);
      });
      const res = await shareAs(person('owner'), id, { openScope: 'me' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('stale_version');
      expect(artifactRow(id).openScope).toBe('chat');
      expect(bucketKeys()).toEqual(before);
      expect(versionRows(id)[0].fileKey).toBe(before.find((key) => key.endsWith('index.html')));
    });

    it('keeps trying to remove an old file the bucket would not let go of, and forgets it only once it is gone', async () => {
      const id = await makePage();
      const old = bucketKeys();
      db.failRemove = true;
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await justYou(id);
      // It is "Just you" already, and nothing names the old files; they are listed to go
      expect(artifactRow(id).openScope).toBe('me');
      expect(db.retired.map((row) => row.key).sort()).toEqual(old);
      expect(old.every((key) => db.files.has(key))).toBe(true);
      expect(errors).toHaveBeenCalled();
      // The next tidy-up, with the bucket back
      db.failRemove = false;
      await pruneExpired({ files: fakeFiles, now: new Date() });
      expect(db.retired).toEqual([]);
      expect(old.some((key) => db.files.has(key))).toBe(false);
      expect(bucketKeys()).toHaveLength(2);
    });

    it('gives the step that repoints the versions more time the more versions there are', async () => {
      const id = await makePage();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>two</p>' }, { id, ...asBot });
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>three</p>' }, { id, ...asBot });
      const step = jest.spyOn(fakePrisma, '$transaction');
      await justYou(id);
      // The database client's own five seconds would stop an artifact with very many versions from ever becoming private
      expect(step).toHaveBeenLastCalledWith(expect.any(Function), { timeout: moveStepMs(3) });
      expect(moveStepMs(3)).toBeGreaterThan(moveStepMs(1));
      expect(moveStepMs(1)).toBeGreaterThan(5000);
      expect(moveStepMs(2000)).toBeGreaterThanOrEqual(100_000);
    });

    it('cannot be picked on an Orbit that does not know its own address, and nothing moves', async () => {
      const id = await makePage();
      const before = bucketKeys();
      delete process.env.NEXT_PUBLIC_API_URL;
      const res = await shareAs(person('owner'), id, { openScope: 'me' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('private_files_not_configured');
      expect(artifactRow(id).openScope).toBe('chat');
      expect(bucketKeys()).toEqual(before);
    });

    it('moves a version saved before media had folders, too', async () => {
      const id = await makePage({ media: [] });
      // As versions were kept before #1510: one file, no folder
      const row = versionRows(id)[0];
      const oldKey = `artifacts/${id}/v1-aaaaaaaaaaaaaaaaaaaaaaaa.html`;
      db.files.set(oldKey, db.files.get(row.fileKey)!);
      db.files.delete(row.fileKey);
      row.fileKey = oldKey;
      await justYou(id);
      expect(db.files.has(oldKey)).toBe(false);
      expect(versionRows(id)[0].fileKey).toMatch(new RegExp(`^artifacts/${id}/v1-[0-9a-f]{24}/index\\.html$`));
      expect(await fakeFiles.get(versionRows(id)[0].fileKey)).toBe(PAGE);
    });
  });

  describe('served by Orbit, to its owner’s browser only', () => {
    it('serves the page to the first browser that asks, locked as every artifact is, and to no other', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);

      const first = await fetchPrivate(address, inFrame);
      expect(first.status).toBe(200);
      expect(first.text).toBe(PAGE);
      expect(first.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      expect(first.headers.get('x-content-type-options')).toBe('nosniff');
      const policy = first.headers.get('content-security-policy')!;
      expect(policy).toContain('sandbox allow-scripts;');
      expect(policy).not.toContain('allow-same-origin');
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("frame-ancestors 'self' http://play.workadventure.localhost");
      const setCookie = first.headers.get('set-cookie')!;
      const token = new URL(address).pathname.split('/')[2];
      // Its pictures and songs come from its own folder for this version, and from nowhere else on Orbit
      const folder = address.replace(/index\.html$/, '');
      expect(folder.endsWith(`/af/${token}/1/`)).toBe(true);
      expect(policy).toContain(`img-src ${folder} data: blob:;`);
      expect(policy).toContain(`media-src ${folder} data: blob:;`);
      expect(policy).not.toMatch(/(img|media)-src[^;]*'self'/);
      expect(setCookie).toContain(`Path=/af/${token}/`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure; SameSite=None');
      expect(setCookie).not.toContain('Partitioned');

      // The same address from another browser, once the first seconds are over: nothing, and no new cookie
      firstSecondsOver();
      const forwarded = await fetchPrivate(address, inFrame);
      expect(forwarded.status).toBe(403);
      expect(forwarded.text).toBe('This private page opens only where its owner opened it.');
      expect(forwarded.headers.get('set-cookie')).toBeNull();
      expect(forwarded.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect((await fetchPrivate(address, { ...inFrame, cookie: `${cookieOf(first.headers).split('=')[0]}=${'x'.repeat(43)}` })).status).toBe(403);
      // The browser that opened it shows it again (a reload inside the frame)
      const again = await fetchPrivate(address, { ...inFrame, cookie: `other=1; ${cookieOf(first.headers)}` });
      expect(again.status).toBe(200);
      expect(again.text).toBe(PAGE);
      expect(again.headers.get('set-cookie')).toBeNull();
      // The page itself, which a cookie opens, is never readable from another page; nor is a refusal
      for (const answer of [first, again, forwarded]) expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('keeps of a pass only what opens nothing: no address and no cookie is stored', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const first = await fetchPrivate(address, inFrame);
      const token = new URL(address).pathname.split('/')[2];
      const cookie = cookieOf(first.headers).split('=')[1];
      expect(db.passes).toHaveLength(1);
      const kept = JSON.stringify(db.passes[0]);
      expect(kept).not.toContain(token);
      expect(kept).not.toContain(cookie);
      expect(db.passes[0]).toMatchObject({ artifactId: id, userId: 'owner' });
    });

    it('lets the same address ask again for a few seconds, in case its first answer never arrived, and no longer', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const lost = await fetchPrivate(address, inFrame);
      expect(lost.status).toBe(200);
      const tiedAt = db.passes[0].redeemedAt!.getTime();

      // That answer never reached the browser, which holds no cookie: three seconds on it asks again and is given a new one
      firstSecondsOver(3);
      const again = await fetchPrivate(address, inFrame);
      expect(again.status).toBe(200);
      expect(again.text).toBe(PAGE);
      expect(cookieOf(again.headers)).toMatch(/^af_[^=]+=.{43}$/);
      expect(cookieOf(again.headers)).not.toBe(cookieOf(lost.headers));
      // Asking again buys no more time: the seconds count from the first request
      expect(db.passes[0].redeemedAt!.getTime()).toBe(tiedAt - 3_000);

      // Once they are over only the last cookie given opens it: not the one that was lost, and not the bare address
      firstSecondsOver();
      expect((await fetchPrivate(address, inFrame)).status).toBe(403);
      expect((await fetchPrivate(address, { ...inFrame, cookie: cookieOf(lost.headers) })).status).toBe(403);
      const mine_ = await fetchPrivate(address, { ...inFrame, cookie: cookieOf(again.headers) });
      expect(mine_.status).toBe(200);
      expect(mine_.headers.get('set-cookie')).toBeNull();
      expect(db.passes[0].redeemedAt!.getTime()).toBe(tiedAt - 14_000);
    });

    it('holds to the cookie from the first moment where the setting says no seconds, and for as many as it says', async () => {
      const id = await makePage();
      await justYou(id);
      process.env.ARTIFACT_PASS_RETRY_SECONDS = '0';
      const strict = await ownerAddress(id);
      const first = await fetchPrivate(strict, inFrame);
      expect(first.status).toBe(200);
      expect((await fetchPrivate(strict, inFrame)).status).toBe(403);
      expect((await fetchPrivate(strict, { ...inFrame, cookie: cookieOf(first.headers) })).status).toBe(200);

      process.env.ARTIFACT_PASS_RETRY_SECONDS = '60';
      const patient = await ownerAddress(id);
      expect((await fetchPrivate(patient, inFrame)).status).toBe(200);
      const pass = db.passes[db.passes.length - 1];
      pass.redeemedAt = new Date(pass.redeemedAt!.getTime() - 59_000);
      expect((await fetchPrivate(patient, inFrame)).status).toBe(200);
      pass.redeemedAt = new Date(pass.redeemedAt!.getTime() - 2_000);
      expect((await fetchPrivate(patient, inFrame)).status).toBe(403);

      // A setting that is no number of seconds is the usual ten
      process.env.ARTIFACT_PASS_RETRY_SECONDS = 'soon';
      const usual = await ownerAddress(id);
      expect((await fetchPrivate(usual, inFrame)).status).toBe(200);
      const last = db.passes[db.passes.length - 1];
      last.redeemedAt = new Date(last.redeemedAt!.getTime() - 9_000);
      expect((await fetchPrivate(usual, inFrame)).status).toBe(200);
      last.redeemedAt = new Date(last.redeemedAt!.getTime() - 2_000);
      expect((await fetchPrivate(usual, inFrame)).status).toBe(403);
    });

    it('serves both of two requests for the page at the same moment, as a browser that sends one twice needs', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      // The other request ties the pass between this one's reading it and taking it
      const real = fakePrisma.artifactPass.updateMany;
      const spy = jest.spyOn(fakePrisma.artifactPass, 'updateMany').mockImplementationOnce(async () => {
        // A moment later than this request's own, as it is when the other one came in after it and was quicker
        db.passes[0].redeemedAt = new Date(Date.now() + 5);
        db.passes[0].cookieHash = 'a'.repeat(64);
        return { count: 0 };
      });
      const second = await fetchPrivate(address, inFrame);
      expect(second.status).toBe(200);
      expect(second.text).toBe(PAGE);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(fakePrisma.artifactPass.updateMany).not.toBe(real);
      // The cookie it was given is the one that opens the page from then on
      firstSecondsOver();
      expect((await fetchPrivate(address, { ...inFrame, cookie: cookieOf(second.headers) })).status).toBe(200);
      expect((await fetchPrivate(address, inFrame)).status).toBe(403);
    });

    // The request that won may have looked at the clock a little after the one that lost, or on another server whose
    // clock is a little ahead: its moment can be later than the loser's own
    it.each([
      ['a moment later than its own', 5],
      ['the same moment', 0],
      ['a moment earlier', -5],
    ])('refuses the one that loses where the setting says no seconds, when the other took the pass %s', async (_when, aheadMs) => {
      process.env.ARTIFACT_PASS_RETRY_SECONDS = '0';
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const spy = jest.spyOn(fakePrisma.artifactPass, 'updateMany').mockImplementationOnce(async () => {
        db.passes[0].redeemedAt = new Date(Date.now() + aheadMs);
        db.passes[0].cookieHash = 'a'.repeat(64);
        return { count: 0 };
      });
      const loser = await fetchPrivate(address, inFrame);
      expect(loser.status).toBe(403);
      expect(loser.headers.get('set-cookie')).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['long before', -60_000],
      ["long after, by another server's clock", 60_000],
    ])('opens nothing without the cookie when the first request was %s', async (_when, awayMs) => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const first = await fetchPrivate(address, inFrame);
      expect(first.status).toBe(200);
      db.passes[0].redeemedAt = new Date(Date.now() + awayMs);
      const without = await fetchPrivate(address, inFrame);
      expect(without.status).toBe(403);
      expect(without.headers.get('set-cookie')).toBeNull();
      expect((await fetchPrivate(address, { ...inFrame, cookie: cookieOf(first.headers) })).status).toBe(200);
    });

    it('shows a page only inside a frame: opened as a page of its own it is turned away, before anything is tied to that browser', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const tab = await fetchPrivate(address, { 'sec-fetch-dest': 'document' });
      expect(tab.status).toBe(403);
      expect(tab.text).toBe('This page opens only inside Universe.');
      expect(tab.headers.get('set-cookie')).toBeNull();
      // The owner's frame is still the first
      expect((await fetchPrivate(address, inFrame)).status).toBe(200);
      // An older browser does not say what it wants the page for: the lock is the same
      const older = await fetchPrivate(await ownerAddress(id));
      expect(older.status).toBe(200);
      expect(older.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
    });

    it('serves the media beside the page once the page has been, whole or in the parts a player asks for', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const song = address.replace('index.html', 'song.mp3');
      // Not before the page: an address that was never opened serves nothing
      expect((await fetchPrivate(song)).status).toBe(404);
      await fetchPrivate(address, inFrame);

      const whole = await fetchPrivate(song);
      expect(whole.status).toBe(200);
      expect(whole.bytes).toEqual(SONG.bytes);
      expect(whole.headers.get('content-type')).toBe('audio/mpeg');
      expect(whole.headers.get('content-length')).toBe('1000');
      expect(whole.headers.get('accept-ranges')).toBe('bytes');
      expect(whole.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
      expect(whole.headers.get('cache-control')).toBe('private, max-age=3600');
      // A locked page has no origin to name, so its own song is from "elsewhere": it may read it, not only play it
      expect(whole.headers.get('access-control-allow-origin')).toBe('*');
      expect(whole.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(whole.headers.get('access-control-allow-credentials')).toBeNull();
      expect(whole.headers.get('set-cookie')).toBeNull();

      const part = await fetchPrivate(song, { range: 'bytes=100-199' });
      expect(part.status).toBe(206);
      expect(part.bytes).toEqual(SONG.bytes.slice(100, 200));
      expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
      expect(part.headers.get('content-length')).toBe('100');
      const tail = await fetchPrivate(song, { range: 'bytes=-10' });
      expect(tail.bytes).toEqual(SONG.bytes.slice(990));
      expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
      const rest = await fetchPrivate(song, { range: 'bytes=900-' });
      expect(rest.bytes).toEqual(SONG.bytes.slice(900));
      const past = await fetchPrivate(song, { range: 'bytes=5000-' });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe('bytes */1000');

      // Only what this version carries, by the name the page uses
      expect((await fetchPrivate(address.replace('index.html', 'other.mp3'))).status).toBe(404);
      expect((await fetchPrivate(address.replace('index.html', 'index.md'))).status).toBe(404);
      expect((await fetchPrivate(address.replace('/1/', '/2/'))).status).toBe(404);
    });

    it('answers the same for everything that is not there, so an address tells nothing', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const token = new URL(address).pathname.split('/')[2];
      const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      for (const other of [address.replace(token, wrong), address.replace(token, 'short'), address.replace('/1/', '/0/'), address.replace('/1/', '/abc/'), address.replace('/1/', '/7/')]) {
        const res = await fetchPrivate(other, inFrame);
        expect(res.status).toBe(404);
        expect(res.text).toBe('Not found.');
        expect(res.headers.get('set-cookie')).toBeNull();
      }
      // None of them used up the owner's first opening
      expect((await fetchPrivate(address, inFrame)).status).toBe(200);
    });

    it('checks on every request that the pass’s person still owns it: it stops with the artifact, and when its time is up', async () => {
      const id = await makePage();
      await justYou(id);
      const address = await ownerAddress(id);
      const first = await fetchPrivate(address, inFrame);
      const mine_ = { ...inFrame, cookie: cookieOf(first.headers) };
      const song = address.replace('index.html', 'song.mp3');
      expect((await fetchPrivate(address, mine_)).status).toBe(200);

      // Not the owner any more (as if the artifact were someone else's): the same pass opens nothing
      artifactRow(id).ownerId = 'friend';
      expect((await fetchPrivate(address, mine_)).status).toBe(404);
      expect((await fetchPrivate(song)).status).toBe(404);
      artifactRow(id).ownerId = 'owner';
      expect((await fetchPrivate(song)).status).toBe(200);

      // Its time is up
      db.passes[0].expiresAt = new Date(Date.now() - 1000);
      expect((await fetchPrivate(address, mine_)).status).toBe(404);
      expect((await fetchPrivate(song)).status).toBe(404);
      await pruneExpired({ files: fakeFiles, now: new Date() });
      expect(db.passes).toEqual([]);

      // A new opening works, until the owner deletes the artifact
      const second = await ownerAddress(id);
      const opened = await fetchPrivate(second, inFrame);
      expect(opened.status).toBe(200);
      expect((await call(remove, { viewer: viewer(person('owner')) }, { id, method: 'DELETE' })).status).toBe(200);
      expect((await fetchPrivate(second, { ...inFrame, cookie: cookieOf(opened.headers) })).status).toBe(404);
      expect((await fetchPrivate(second.replace('index.html', 'song.mp3'))).status).toBe(404);
      expect(db.passes).toEqual([]);
      expect(bucketKeys()).toEqual([]);
    });

    it('leaves no file behind when its owner deletes it at the moment it becomes "Just you"', async () => {
      const id = await makePage();
      const before = bucketKeys();
      expect(before).toHaveLength(2);
      // Its files move between the delete reading where they are and taking the rows
      const real = fakePrisma.artifact.deleteMany;
      const spy = jest.spyOn(fakePrisma.artifact, 'deleteMany').mockImplementationOnce(async (args) => {
        await justYou(id);
        expect(bucketKeys().some((key) => before.includes(key))).toBe(false);
        return real(args);
      });
      expect((await call(remove, { viewer: viewer(person('owner')) }, { id, method: 'DELETE' })).status).toBe(200);
      // It saw the change and read again where the files are
      expect(spy).toHaveBeenCalledTimes(2);
      expect(db.artifacts.some((artifact) => artifact.id === id)).toBe(false);
      expect(bucketKeys()).toEqual([]);
      expect(db.retired).toEqual([]);
    });

    it('lasts as long as the setting says', async () => {
      process.env.ARTIFACT_PASS_MINUTES = '5';
      const id = await makePage();
      await justYou(id);
      const at = Date.now();
      await ownerAddress(id);
      const life = db.passes[0].expiresAt.getTime() - at;
      expect(life).toBeGreaterThan(4 * 60_000);
      expect(life).toBeLessThanOrEqual(5 * 60_000 + 2000);
    });

    it('says when the address stops, so a window left open can ask for a new one in time, and says it nowhere else', async () => {
      const id = await makePage();
      // An address of the bucket's never stops
      expect((await openAs(person('owner'), id, true)).body.version).not.toHaveProperty('urlExpiresAt');
      await justYou(id);
      const opened = await openAs(person('owner'), id, true);
      expect(opened.body.version.url).toContain('/af/');
      expect(opened.body.version.urlExpiresAt).toBe(db.passes[0].expiresAt.toISOString());
      // No address, no time: the list and the code of a private one
      const owner = { viewer: viewer(person('owner')) };
      expect((await call(versions, owner, { id })).body.versions.every((version: object) => !('urlExpiresAt' in version))).toBe(true);
      expect((await call(code, owner, { id, number: '1' })).body.version).not.toHaveProperty('urlExpiresAt');
    });

    it('gives each opening its own address, and an older version its own', async () => {
      const id = await makePage();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>two</p>' }, { id, ...asBot });
      await justYou(id);
      const one = await ownerAddress(id);
      const two = await ownerAddress(id);
      expect(one).not.toBe(two);
      const older = await ownerAddress(id, 1);
      expect(older).toContain('/1/index.html');
      expect((await fetchPrivate(older, inFrame)).text).toBe(PAGE);
      expect((await fetchPrivate(one, inFrame)).text).toBe('<p>two</p>');
      // Each is tied to its own first browser
      expect((await fetchPrivate(two, { ...inFrame, cookie: 'af_x=y' })).status).toBe(200);
      firstSecondsOver();
      expect((await fetchPrivate(two, inFrame)).status).toBe(403);
    });

    it('serves a drawing so that it never runs anything, and a document from its text alone', async () => {
      const drawing = await makePage({ kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', media: [] });
      await justYou(drawing);
      const address = await ownerAddress(drawing);
      expect(address).toMatch(/\/1\/index\.svg$/);
      // The game shows it as a picture, so it is not asked for as a frame
      const shown = await fetchPrivate(address, { 'sec-fetch-dest': 'image' });
      expect(shown.status).toBe(200);
      expect(shown.headers.get('content-type')).toBe('image/svg+xml');
      expect(shown.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'");
      expect(shown.headers.get('content-security-policy')).not.toContain('allow-scripts');
      firstSecondsOver();
      expect((await fetchPrivate(address, { 'sec-fetch-dest': 'image' })).status).toBe(403);

      const document = await makePage({ kind: 'markdown', content: '# Notes\n\nJust mine.', media: [] });
      await justYou(document);
      const opened = await openAs(person('owner'), document);
      expect(opened.body.version.url).toBeNull();
      expect(db.passes.filter((pass) => pass.artifactId === document)).toEqual([]);
      expect((await call(code, { viewer: viewer(person('owner')) }, { id: document, number: '1' })).body.content).toBe('# Notes\n\nJust mine.');
      expect((await call(code, { viewer: viewer(person('friend')) }, { id: document, number: '1' })).status).toBe(404);
    });

    it('opens for its owner on You in Orbit the same way, and for nobody else there', async () => {
      const id = await makePage();
      await justYou(id);
      const openMine = async (userId: string | null) => {
        (getSessionUser as jest.Mock).mockResolvedValue(userId ? { id: userId, uuid: `uuid-${userId}`, email: `${userId}@example.com`, name: userId } : null);
        const response = await mineOne(new NextRequest(`http://localhost:3333/api/me/artifacts/${id}`), { params: Promise.resolve({ id }) });
        return { status: response.status, body: await response.json() };
      };
      const own = await openMine('owner');
      expect(own.status).toBe(200);
      expect(own.body.url).toMatch(new RegExp(`^${ORBIT}/af/[A-Za-z0-9_-]{43}/1/index\\.html$`));
      expect((await fetchPrivate(own.body.url, inFrame)).text).toBe(PAGE);
      expect((await openMine('friend')).status).toBe(404);
      expect((await openMine(null)).status).toBe(401);
    });
  });

  describe('nothing widens by itself', () => {
    it('keeps a copy another bot’s change makes "Just you", with files nobody was told about', async () => {
      const id = await makePage();
      await justYou(id);
      // The owner asks another bot, in the chat with others in it, to change what the first bot made
      const res = await call(change, { botId: 'bot2', person: person('owner'), chat: NEARBY, content: '<p>by Pixel</p>' }, { id, ...asBot });
      expect(res.status).toBe(200);
      const copyId = res.body.artifact.id as string;
      expect(copyId).not.toBe(id);
      expect(res.body.artifact).toMatchObject({ openScope: 'me', makerName: 'Pixel', copiedFromId: id });
      expect((await openAs(person('friend'), copyId)).body.error).toBe('kept_private');
      expect(await ownerAddress(copyId)).toMatch(/\/af\//);
    });

    it('keeps a copy its owner makes "Just you"', async () => {
      const id = await makePage();
      await justYou(id);
      const res = await call(copy, { viewer: viewer(person('owner')) }, { id });
      expect(res.status).toBe(200);
      expect(res.body.artifact).toMatchObject({ openScope: 'me', copiedFromId: id });
      expect(res.body.version.url).toBeNull();
    });

    it('opens for the chat again only when its owner says so, and going back moves the files again', async () => {
      const id = await makePage();
      await justYou(id);
      const kept = bucketKeys();
      expect((await shareAs(person('owner'), id, { openScope: 'chat' })).status).toBe(200);
      // From now on the address is the bucket's again, for whoever the owner let in
      const friend = await openAs(person('friend'), id);
      expect(friend.status).toBe(200);
      expect(friend.body.version.url).toBe(`${BUCKET}${versionRows(id)[0].fileKey}`);
      expect(bucketKeys()).toEqual(kept);
      // The owner changes their mind: the address the friend just got stops working
      await justYou(id);
      expect(kept.some((key) => db.files.has(key))).toBe(false);
      expect((await openAs(person('friend'), id)).body.error).toBe('kept_private');
    });

    it('leaves every other artifact exactly as it was: the bucket’s address, the chat’s rules', async () => {
      const id = await makePage();
      const before = bucketKeys();
      const res = await openAs(person('friend'), id);
      expect(res.status).toBe(200);
      expect(res.body.version.url).toBe(`${BUCKET}${versionRows(id)[0].fileKey}`);
      expect((await openAs(person('stranger'), id, false)).body.error).toBe('not_found');
      expect((await shareAs(person('owner'), id, { openScope: 'link' })).body.artifact.openScope).toBe('link');
      expect((await openAs(person('stranger'), id, false)).status).toBe(200);
      expect(bucketKeys()).toEqual(before);
      expect(db.passes).toEqual([]);
    });
  });
});
