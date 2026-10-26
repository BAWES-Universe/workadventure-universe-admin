import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as mine } from '@/app/api/artifacts/mine/route';
import { POST as inChat } from '@/app/api/artifacts/in-chat/route';
import { POST as change } from '@/app/api/artifacts/[id]/change/route';
import { POST as read } from '@/app/api/artifacts/[id]/read/route';
import { POST as open } from '@/app/api/artifacts/[id]/open/route';
import { POST as versions } from '@/app/api/artifacts/[id]/versions/route';
import { POST as code } from '@/app/api/artifacts/[id]/versions/[number]/route';
import { PUT as share } from '@/app/api/artifacts/[id]/share/route';
import { POST as restore } from '@/app/api/artifacts/[id]/restore/route';
import { POST as copy } from '@/app/api/artifacts/[id]/copy/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { MAX_ARTIFACT_BYTES, MAX_VERSIONS } from '@/lib/artifacts';
import { pruneExpired, resetPruneClock } from '@/lib/artifact-service';
import { addBot, addUser, db, fakeFiles, fakePrisma } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const DM = { kind: 'dm', ref: '!room:chat.example' };
const APP = '<html><body><h1>Quests</h1><button class="big">Done</button></body></html>';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, body: unknown, options: { id?: string; number?: string; token?: string | null; method?: string } = {}) {
  const token = options.token === undefined ? BOT_TOKEN : options.token;
  const request = new NextRequest('http://localhost:3333/api/artifacts', {
    method: options.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '', number: options.number ?? '' }) });
  return { status: response.status, body: await response.json() };
}

const asGame = { token: ADMIN_TOKEN };
const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, name: 'Visitor' };
type Who = ReturnType<typeof person> | typeof guest;
/** The game's word about a person: in a chat or not, and which chat (none by default is the bubble the artifacts are made in). */
const viewer = (who: Who, inChat = true, chat: object | null = NEARBY) => ({ person: who, inChat, ...(chat ? { chat } : {}) });

async function makeApp(who: ReturnType<typeof person> | typeof guest = person('owner'), chat: object = NEARBY, extra: object = {}) {
  const res = await call(make, { botId: 'bot1', person: who, chat, title: 'Quests board', kind: 'app', content: APP, ...extra });
  expect(res.status).toBe(200);
  return res.body;
}

const bucketKeys = () => [...db.files.keys()];

describe('artifacts', () => {
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
    resetPruneClock();
    addUser('owner');
    addUser('friend');
    addUser('stranger');
    addBot('bot1', 'Scout');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe('who may call', () => {
    it('refuses a call without a token, or with a wrong one', async () => {
      expect((await call(make, {}, { token: null })).status).toBe(401);
      expect((await call(make, {}, { token: 'nope' })).status).toBe(401);
      expect((await call(open, {}, { token: null, id: 'x' })).status).toBe(401);
    });

    it('keeps the game routes for the admin token, and lets the bot server use either of its own', async () => {
      const made = await makeApp();
      const body = { viewer: viewer(person('owner')) };
      expect((await call(open, body, { id: made.artifact.id, token: BOT_TOKEN })).status).toBe(401);
      expect((await call(open, body, { id: made.artifact.id, ...asGame })).status).toBe(200);
      expect((await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: 'T', kind: 'page', content: '<p>x</p>' }, { token: ADMIN_TOKEN })).status).toBe(200);
    });

    it('answers 400 for a body that is not what the route takes', async () => {
      expect((await call(make, 'not json')).status).toBe(400);
      expect((await call(make, { botId: 'bot1' })).status).toBe(400);
      expect((await call(make, { botId: 'bot1', person: { signedIn: true }, chat: NEARBY, title: 'T', kind: 'app', content: 'x' })).status).toBe(400);
      expect((await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: 'T', kind: 'exe', content: 'x' })).status).toBe(400);
    });
  });

  describe('make', () => {
    it('keeps the artifact under the person who asked, with the bot as its maker and version 1 in the bucket', async () => {
      const made = await makeApp();
      expect(made.artifact).toMatchObject({ title: 'Quests board', kind: 'app', makerBotId: 'bot1', makerName: 'Scout', owner: { name: 'Owner' }, version: 1, openScope: 'chat', changeScope: 'owner', chatKind: 'nearby', expiresAt: null });
      expect(made.version).toMatchObject({ number: 1, summary: 'First version', askedByName: 'owner', sizeBytes: Buffer.byteLength(APP) });
      expect(made.hidden).toBe(false);
      expect(db.files.get(bucketKeys()[0])).toBe(APP);
      expect(made.version.url).toBe(`https://files.example.test/${bucketKeys()[0]}`);
      expect(db.artifacts[0].ownerId).toBe('owner');
    });

    it('lists it under the person who asked, and not under anyone else', async () => {
      await makeApp();
      const own = await call(mine, { person: person('owner') }, asGame);
      expect(own.body.artifacts.map((a: { title: string }) => a.title)).toEqual(['Quests board']);
      expect((await call(mine, { person: person('friend') }, asGame)).body.artifacts).toEqual([]);
      expect((await call(mine, { person: guest }, asGame)).body.artifacts).toEqual([]);
    });

    it('keeps what a guest asked for for a day, with nobody as owner', async () => {
      const made = await makeApp(guest);
      expect(made.artifact.owner).toBeNull();
      expect(made.artifact.changeScope).toBe('openers');
      const left = new Date(made.artifact.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(23 * 3600 * 1000);
      expect(left).toBeLessThanOrEqual(24 * 3600 * 1000);
      expect(db.artifacts[0].ownerId).toBeNull();
    });

    it('treats a guest account as a guest even when the caller says signed in', async () => {
      addUser('visitor', { isGuest: true });
      const made = await makeApp({ signedIn: true, identifier: 'uuid-visitor', name: 'Visitor' } as never);
      expect(made.artifact.owner).toBeNull();
    });

    it('asks the same access rules as the bot access route: nearby chat for a nearby chat, direct message for a direct one', async () => {
      await makeApp(person('owner'), NEARBY);
      await makeApp(person('owner'), DM);
      expect((checkBotAccess as jest.Mock).mock.calls.map(([call]) => call.action)).toEqual(['chat', 'dm']);
    });

    it('refuses someone the bot does not allow, and stores nothing', async () => {
      (checkBotAccess as jest.Mock).mockResolvedValue({ allowed: false, code: 'not_allowed', reason: "Scout's owner limits who can chat with it." });
      const res = await call(make, { botId: 'bot1', person: person('stranger'), chat: NEARBY, title: 'T', kind: 'app', content: APP });
      expect(res).toMatchObject({ status: 403, body: { error: 'not_allowed', message: "Scout's owner limits who can chat with it." } });
      expect(db.artifacts).toHaveLength(0);
      expect(bucketKeys()).toHaveLength(0);
    });

    it('answers 404 for a bot that is not there', async () => {
      (checkBotAccess as jest.Mock).mockResolvedValue(null);
      expect((await call(make, { botId: 'gone', person: person('owner'), chat: NEARBY, title: 'T', kind: 'app', content: APP })).status).toBe(404);
    });

    it('tells the bot server when the bot hides its chats, so the text stays out of PostHog and Sentry', async () => {
      (loadBotPrivacy as jest.Mock).mockResolvedValue({ universeHides: true, choice: 'follow', hidden: true });
      const made = await makeApp();
      expect(made.hidden).toBe(true);
      const read1 = await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY }, { id: made.artifact.id });
      expect(read1.body.hidden).toBe(true);
    });

    it('refuses a blank title, a blank file and a file over the cap', async () => {
      expect((await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: '   ', kind: 'app', content: APP })).body.error).toBe('title_required');
      expect((await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: 'T', kind: 'app', content: ' ' })).body.error).toBe('empty_content');
      const big = await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: 'T', kind: 'app', content: 'a'.repeat(MAX_ARTIFACT_BYTES + 1) });
      expect(big).toMatchObject({ status: 413, body: { error: 'too_large' } });
      expect(db.artifacts).toHaveLength(0);
      expect(bucketKeys()).toHaveLength(0);
    });

    it('leaves no file behind when the database fails', async () => {
      const original = db.artifacts.push;
      db.artifacts.push = () => {
        throw new Error('database is down');
      };
      const res = await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title: 'T', kind: 'app', content: APP });
      db.artifacts.push = original;
      expect(res.status).toBe(500);
      expect(bucketKeys()).toHaveLength(0);
    });
  });

  describe('change', () => {
    it('applies small edits as a new version and keeps the old one', async () => {
      const made = await makeApp();
      const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, baseVersion: 1, edits: [{ old: 'class="big"', new: 'class="huge"' }], summary: 'Bigger buttons' }, { id: made.artifact.id });
      expect(res.status).toBe(200);
      expect(res.body.artifact.version).toBe(2);
      expect(res.body.version).toMatchObject({ number: 2, summary: 'Bigger buttons', askedByName: 'owner' });
      const list = await call(versions, { viewer: viewer(person('owner')) }, { id: made.artifact.id, ...asGame });
      expect(list.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
      const v1 = await call(code, { viewer: viewer(person('owner')) }, { id: made.artifact.id, number: '1', ...asGame });
      const v2 = await call(code, { viewer: viewer(person('owner')) }, { id: made.artifact.id, number: '2', ...asGame });
      expect(v1.body.content).toBe(APP);
      expect(v2.body.content).toBe(APP.replace('class="big"', 'class="huge"'));
    });

    it('takes the whole new file instead of edits, and a new title', async () => {
      const made = await makeApp();
      const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>new</p>', title: 'Renamed' }, { id: made.artifact.id });
      expect(res.body.artifact).toMatchObject({ version: 2, title: 'Renamed' });
      expect(db.files.get(db.versions[1].fileKey)).toBe('<p>new</p>');
    });

    it('wants edits or the file, never both and never neither', async () => {
      const made = await makeApp();
      const both = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: 'x', edits: [{ old: 'a', new: 'b' }] }, { id: made.artifact.id });
      const neither = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY }, { id: made.artifact.id });
      expect(both.body.error).toBe('edits_or_content');
      expect(neither.body.error).toBe('edits_or_content');
    });

    it('changes nothing when an edit finds nothing or finds its text twice', async () => {
      const made = await makeApp(person('owner'), NEARBY, { content: '<b>a</b><b>a</b>' });
      const missing = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, edits: [{ old: 'zzz', new: 'y' }] }, { id: made.artifact.id });
      const twice = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, edits: [{ old: '<b>a</b>', new: 'y' }] }, { id: made.artifact.id });
      expect(missing).toMatchObject({ status: 422, body: { error: 'edit_not_found' } });
      expect(twice).toMatchObject({ status: 422, body: { error: 'edit_ambiguous' } });
      expect(db.artifacts[0].latestVersion).toBe(1);
      expect(bucketKeys()).toHaveLength(1);
    });

    it('refuses a change made on a version that is no longer the latest', async () => {
      const made = await makeApp();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id: made.artifact.id });
      const stale = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, baseVersion: 1, content: '<p>3</p>' }, { id: made.artifact.id });
      expect(stale).toMatchObject({ status: 409, body: { error: 'stale_version' } });
      expect(db.artifacts[0].latestVersion).toBe(2);
      expect(bucketKeys()).toHaveLength(2);
    });

    it('lets only one of two changes made on the same version win, and leaves no file for the other', async () => {
      const made = await makeApp();
      const body = (content: string) => ({ botId: 'bot1', person: person('owner'), chat: NEARBY, baseVersion: 1, content });
      const results = await Promise.all([
        call(change, body('<p>a</p>'), { id: made.artifact.id }),
        call(change, body('<p>b</p>'), { id: made.artifact.id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(db.artifacts[0].latestVersion).toBe(2);
      expect(bucketKeys()).toHaveLength(2);
    });

    it('keeps the owner as the only one who can ask for a change until they allow everyone who can open it', async () => {
      const made = await makeApp();
      const asFriend = { botId: 'bot1', person: person('friend'), chat: NEARBY, content: '<p>x</p>' };
      expect(await call(change, asFriend, { id: made.artifact.id })).toMatchObject({ status: 403, body: { error: 'change_not_allowed' } });
      await call(share, { viewer: viewer(person('owner')), changeScope: 'openers' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      const allowed = await call(change, asFriend, { id: made.artifact.id });
      expect(allowed.status).toBe(200);
      expect(allowed.body.version.askedByName).toBe('friend');
      expect(db.versions[1].askedById).toBe('friend');
    });

    it('does not let anyone but the owner change it from another chat, even with the link and the right', async () => {
      const made = await makeApp();
      await call(share, { viewer: viewer(person('owner')), openScope: 'link', changeScope: 'openers' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      const elsewhere = await call(change, { botId: 'bot1', person: person('friend'), chat: { kind: 'nearby', ref: 'other-bubble' }, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(elsewhere).toMatchObject({ status: 403, body: { error: 'change_not_allowed' } });
      const ownerElsewhere = await call(change, { botId: 'bot1', person: person('owner'), chat: DM, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(ownerElsewhere.status).toBe(200);
    });

    it('answers 404 to someone who may not even open it', async () => {
      const made = await makeApp();
      const res = await call(change, { botId: 'bot1', person: person('stranger'), chat: { kind: 'nearby', ref: 'other-bubble' }, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(res.status).toBe(404);
    });

    it('lets anyone in the chat change what a guest asked for, and keeps it a day from the last change', async () => {
      const made = await makeApp(guest);
      const res = await call(change, { botId: 'bot1', person: person('friend'), chat: NEARBY, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(res.status).toBe(200);
      expect(res.body.artifact.owner).toBeNull();
      expect(new Date(res.body.artifact.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(made.artifact.expiresAt).getTime());
    });

    it('stops at the version cap', async () => {
      const made = await makeApp();
      db.artifacts[0].latestVersion = MAX_VERSIONS;
      const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(res).toMatchObject({ status: 409, body: { error: 'too_many_versions' } });
    });

    it('leaves no file behind when the version cannot be saved', async () => {
      const made = await makeApp();
      db.failNextVersionCreate = true;
      const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>x</p>' }, { id: made.artifact.id });
      expect(res.status).toBe(500);
      expect(bucketKeys()).toHaveLength(1);
    });
  });

  describe('when something fails after the save', () => {
    it('keeps the file of a version that is already saved', async () => {
      const made = await makeApp();
      const readAgain = fakePrisma.artifact.findUnique;
      // The change reads the artifact once before it saves and once after; only the second read fails
      const spy = jest.spyOn(fakePrisma.artifact, 'findUnique').mockImplementationOnce(readAgain).mockRejectedValueOnce(new Error('read back failed'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id: made.artifact.id });
      spy.mockRestore();
      expect(res.status).toBe(500);
      const saved = db.versions.find((v) => v.artifactId === made.artifact.id && v.number === 2);
      expect(saved).toBeDefined();
      expect(bucketKeys()).toContain(saved!.fileKey);
    });
  });

  describe('in this chat', () => {
    it('lists what was made in the chat, the most recently changed first, for people who may open it', async () => {
      const first = await makeApp(person('owner'), NEARBY, { title: 'First' });
      const second = await makeApp(person('owner'), NEARBY, { title: 'Second' });
      await makeApp(person('owner'), DM, { title: 'Elsewhere' });
      db.artifacts.find((a) => a.id === first.artifact.id)!.updatedAt = new Date(Date.now() + 5000);
      const res = await call(inChat, { botId: 'bot1', person: person('friend'), chat: NEARBY });
      expect(res.status).toBe(200);
      expect(res.body.artifacts.map((a: { title: string }) => a.title)).toEqual(['First', 'Second']);
      expect(res.body.artifacts[1].id).toBe(second.artifact.id);
      expect(res.body.hidden).toBe(false);
    });

    it('leaves out what a guest asked for once its day is over', async () => {
      await makeApp(guest);
      db.artifacts[0].expiresAt = new Date(Date.now() - 1000);
      expect((await call(inChat, { botId: 'bot1', person: guest, chat: NEARBY })).body.artifacts).toEqual([]);
    });

    it('goes through the same bot access check as the other bot calls', async () => {
      (checkBotAccess as jest.Mock).mockResolvedValue({ allowed: false, code: 'not_allowed', reason: 'No.' });
      expect((await call(inChat, { botId: 'bot1', person: person('friend'), chat: NEARBY })).status).toBe(403);
    });
  });

  describe('read', () => {
    it('gives the bot the latest file, or the version asked for', async () => {
      const made = await makeApp();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id: made.artifact.id });
      const latest = await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY }, { id: made.artifact.id });
      const first = await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY, version: 1 }, { id: made.artifact.id });
      expect(latest.body).toMatchObject({ content: '<p>2</p>', version: { number: 2 } });
      expect(first.body).toMatchObject({ content: APP, version: { number: 1 } });
      expect((await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY, version: 9 }, { id: made.artifact.id })).body.error).toBe('version_not_found');
    });

    it('turns down a version number the database could not hold, instead of failing there', async () => {
      const made = await makeApp();
      const tooBig = await call(read, { botId: 'bot1', person: person('owner'), chat: NEARBY, version: 2147483648 }, { id: made.artifact.id });
      expect(tooBig.status).toBe(400);
      const fromAddress = await call(code, { viewer: viewer(person('owner')) }, { ...asGame, id: made.artifact.id, number: '2147483648' });
      expect(fromAddress).toMatchObject({ status: 404, body: { error: 'version_not_found' } });
    });

    it('does not read it out to a bot in a chat whose people may not open it', async () => {
      const made = await makeApp();
      const res = await call(read, { botId: 'bot1', person: person('stranger'), chat: { kind: 'nearby', ref: 'elsewhere' } }, { id: made.artifact.id });
      expect(res.status).toBe(404);
    });
  });

  describe('open', () => {
    it('opens for the owner with everything they may do', async () => {
      const made = await makeApp();
      const res = await call(open, { viewer: viewer(person('owner'), false) }, { id: made.artifact.id, ...asGame });
      expect(res.body.you).toEqual({ owner: true, change: true, manage: true, copy: true });
      expect(res.body.version.number).toBe(1);
    });

    it('opens for people in the chat, who can look but not change or share', async () => {
      const made = await makeApp();
      const res = await call(open, { viewer: viewer(person('friend')) }, { id: made.artifact.id, ...asGame });
      expect(res.status).toBe(200);
      expect(res.body.you).toEqual({ owner: false, change: false, manage: false, copy: true });
    });

    it('opens for a guest who is in the chat, who cannot make a copy', async () => {
      const made = await makeApp();
      const res = await call(open, { viewer: viewer(guest) }, { id: made.artifact.id, ...asGame });
      expect(res.body.you).toMatchObject({ owner: false, copy: false });
    });

    it('does not open for someone outside the chat, until the owner shares the link', async () => {
      const made = await makeApp();
      const closed = await call(open, { viewer: viewer(person('stranger'), false) }, { id: made.artifact.id, ...asGame });
      expect(closed.status).toBe(404);
      await call(share, { viewer: viewer(person('owner')), openScope: 'link' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      const opened = await call(open, { viewer: viewer(person('stranger'), false) }, { id: made.artifact.id, ...asGame });
      expect(opened.status).toBe(200);
      await call(share, { viewer: viewer(person('owner')), openScope: 'chat' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      expect((await call(open, { viewer: viewer(person('stranger'), false) }, { id: made.artifact.id, ...asGame })).status).toBe(404);
    });

    it('does not give the file address or the versions to someone who cannot open it', async () => {
      const made = await makeApp();
      const outside = { viewer: viewer(person('stranger'), false) };
      expect((await call(versions, outside, { id: made.artifact.id, ...asGame })).status).toBe(404);
      expect((await call(code, outside, { id: made.artifact.id, number: '1', ...asGame })).status).toBe(404);
    });

    it('opens an older version when asked, and 404s for one that is not there', async () => {
      const made = await makeApp();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id: made.artifact.id });
      const old = await call(open, { viewer: viewer(person('owner')), version: 1 }, { id: made.artifact.id, ...asGame });
      expect(old.body.version.number).toBe(1);
      expect(old.body.artifact.version).toBe(2);
      expect((await call(open, { viewer: viewer(person('owner')), version: 7 }, { id: made.artifact.id, ...asGame })).status).toBe(404);
      expect((await call(code, { viewer: viewer(person('owner')) }, { id: made.artifact.id, number: 'abc', ...asGame })).status).toBe(404);
    });

    it('answers 404 for an id that is not there, and for a guest artifact once its day is over', async () => {
      expect((await call(open, { viewer: viewer(person('owner')) }, { id: 'missing', ...asGame })).status).toBe(404);
      const made = await makeApp(guest);
      db.artifacts[0].expiresAt = new Date(Date.now() - 1000);
      expect((await call(open, { viewer: viewer(guest) }, { id: made.artifact.id, ...asGame })).status).toBe(404);
    });
  });

  describe('who can reach an artifact (nothing leaks between people, chats or bots)', () => {
    const OTHER_BUBBLE = { kind: 'nearby', ref: 'bubble-2' };
    const opening = (id: string, who: Who, inChat: boolean, chat: object | null) => call(open, { viewer: viewer(who, inChat, chat) }, { id, ...asGame });
    const sharing = (id: string, body: object) => call(share, { viewer: viewer(person('owner'), false, null), ...body }, { id, method: 'PUT', ...asGame });

    it('opens for the owner from anywhere, with or without the game vouching for a chat', async () => {
      const made = await makeApp();
      expect((await opening(made.artifact.id, person('owner'), false, null)).status).toBe(200);
      expect((await opening(made.artifact.id, person('owner'), true, OTHER_BUBBLE)).status).toBe(200);
    });

    it('opens for a person who is in the chat it was made in, and for nobody who is only in another chat', async () => {
      const made = await makeApp();
      expect((await opening(made.artifact.id, person('friend'), true, NEARBY)).status).toBe(200);
      expect((await opening(made.artifact.id, person('stranger'), true, OTHER_BUBBLE)).status).toBe(404);
    });

    it('does not take "in a chat" for "in this chat": the chat the game names has to be the one it was made in', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      // Another bubble; the bubble name but another kind of chat; no chat named at all; named but not vouched for
      expect((await opening(id, person('stranger'), true, OTHER_BUBBLE)).status).toBe(404);
      expect((await opening(id, person('stranger'), true, { kind: 'dm', ref: NEARBY.ref })).status).toBe(404);
      expect((await opening(id, person('stranger'), true, null)).status).toBe(404);
      expect((await opening(id, person('stranger'), false, NEARBY)).status).toBe(404);
    });

    it('applies the same chat check to the versions, the code, copying and the rights shown', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      const wrong = { viewer: viewer(person('stranger'), true, OTHER_BUBBLE) };
      expect((await call(versions, wrong, { id, ...asGame })).status).toBe(404);
      expect((await call(code, wrong, { id, number: '1', ...asGame })).status).toBe(404);
      expect((await call(copy, wrong, { id, ...asGame })).status).toBe(404);
      expect((await opening(id, person('friend'), true, OTHER_BUBBLE)).status).toBe(404);
      const right = await opening(id, person('friend'), true, NEARBY);
      expect(right.body.you).toEqual({ owner: false, change: false, manage: false, copy: true });
    });

    it('keeps a direct message artifact to its owner, whoever else is in some chat', async () => {
      const made = await makeApp(person('owner'), DM);
      expect((await opening(made.artifact.id, person('owner'), false, null)).status).toBe(200);
      expect((await opening(made.artifact.id, person('friend'), true, NEARBY)).status).toBe(404);
      expect((await opening(made.artifact.id, person('friend'), true, DM)).status).toBe(200);
    });

    it('lets a signed-out guest open only what was made in the chat they are in, or what is shared by link', async () => {
      const made = await makeApp();
      expect((await opening(made.artifact.id, guest, true, OTHER_BUBBLE)).status).toBe(404);
      expect((await opening(made.artifact.id, guest, true, NEARBY)).status).toBe(200);
      await sharing(made.artifact.id, { openScope: 'link' });
      expect((await opening(made.artifact.id, guest, false, null)).status).toBe(200);
    });

    it('opens by link for anyone, and closes again the moment the owner takes the link back', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      await sharing(id, { openScope: 'link' });
      expect((await opening(id, person('stranger'), false, null)).status).toBe(200);
      await sharing(id, { openScope: 'chat' });
      expect((await opening(id, person('stranger'), false, null)).status).toBe(404);
    });

    it('does not let anyone but the owner share or restore, even from inside the chat', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id });
      expect((await call(share, { viewer: viewer(person('friend')), openScope: 'link' }, { id, method: 'PUT', ...asGame })).status).toBe(403);
      expect((await call(restore, { viewer: viewer(person('friend')), number: 1 }, { id, ...asGame })).status).toBe(403);
      expect((await call(share, { viewer: viewer(person('stranger'), true, OTHER_BUBBLE), openScope: 'link' }, { id, method: 'PUT', ...asGame })).status).toBe(404);
    });

    it("does not show one person's artifacts in another person's list", async () => {
      await makeApp();
      expect((await call(mine, { person: person('friend') }, asGame)).body.artifacts).toEqual([]);
      expect((await call(mine, { person: guest }, asGame)).body.artifacts).toEqual([]);
    });

    describe('between bots', () => {
      beforeEach(() => addBot('bot2', 'Pixel'));

      it('does not let another bot in the same chat read, change or list what a bot made', async () => {
        const made = await makeApp();
        const id = made.artifact.id;
        const other = { botId: 'bot2', person: person('owner'), chat: NEARBY };
        expect((await call(read, other, { id })).status).toBe(404);
        expect((await call(change, { ...other, content: '<p>x</p>' }, { id })).status).toBe(404);
        expect((await call(inChat, other)).body.artifacts).toEqual([]);
        expect(db.versions.filter((v) => v.artifactId === id)).toHaveLength(1);
        // The bot that made it still can
        expect((await call(read, { ...other, botId: 'bot1' }, { id })).status).toBe(200);
        expect((await call(inChat, { ...other, botId: 'bot1' })).body.artifacts).toHaveLength(1);
      });

      it('does not let another bot read it even when the person shared the link', async () => {
        const made = await makeApp();
        await sharing(made.artifact.id, { openScope: 'link', changeScope: 'openers' });
        const other = { botId: 'bot2', person: person('friend'), chat: NEARBY };
        expect((await call(read, other, { id: made.artifact.id })).status).toBe(404);
        expect((await call(change, { ...other, content: '<p>x</p>' }, { id: made.artifact.id })).status).toBe(404);
      });

      it("does not let a bot reach another person's artifact from a chat that is not its own", async () => {
        const made = await makeApp();
        const id = made.artifact.id;
        const elsewhere = { botId: 'bot1', person: person('stranger'), chat: OTHER_BUBBLE };
        expect((await call(read, elsewhere, { id })).status).toBe(404);
        expect((await call(change, { ...elsewhere, content: '<p>x</p>' }, { id })).status).toBe(404);
        expect((await call(inChat, elsewhere)).body.artifacts).toEqual([]);
      });

      it('lets the owner take a copy they made to any bot, and nobody else', async () => {
        const made = await makeApp();
        const copied = await call(copy, { viewer: viewer(person('friend')) }, { id: made.artifact.id, ...asGame });
        const copyId = copied.body.artifact.id;
        const asOwner = { botId: 'bot2', person: person('friend'), chat: DM };
        expect((await call(read, asOwner, { id: copyId })).status).toBe(200);
        expect((await call(change, { ...asOwner, content: '<p>mine</p>' }, { id: copyId })).status).toBe(200);
        expect((await call(read, { ...asOwner, person: person('owner') }, { id: copyId })).status).toBe(404);
      });
    });
  });

  describe('share', () => {
    it('lets only the owner share, and says which part is wrong', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      expect((await call(share, { viewer: viewer(person('friend')), openScope: 'link' }, { id, method: 'PUT', ...asGame })).status).toBe(403);
      expect((await call(share, { viewer: viewer(person('stranger'), false), openScope: 'link' }, { id, method: 'PUT', ...asGame })).status).toBe(404);
      expect((await call(share, { viewer: viewer(person('owner')), openScope: 'everyone' }, { id, method: 'PUT', ...asGame })).body.error).toBe('invalid_open_scope');
      expect((await call(share, { viewer: viewer(person('owner')), changeScope: 'nobody' }, { id, method: 'PUT', ...asGame })).body.error).toBe('invalid_change_scope');
      expect((await call(share, { viewer: viewer(person('owner')) }, { id, method: 'PUT', ...asGame })).body.error).toBe('nothing_to_change');
      const ok = await call(share, { viewer: viewer(person('owner')), openScope: 'link', changeScope: 'openers' }, { id, method: 'PUT', ...asGame });
      expect(ok.body.artifact).toMatchObject({ openScope: 'link', changeScope: 'openers' });
    });

    it('gives a guest nothing to share', async () => {
      const made = await makeApp(guest);
      const res = await call(share, { viewer: viewer(guest), openScope: 'link' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      expect(res.status).toBe(403);
    });
  });

  describe('restore', () => {
    it('makes a new version out of an older one and deletes nothing', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id });
      const res = await call(restore, { viewer: viewer(person('owner')), number: 1 }, { id, ...asGame });
      expect(res.status).toBe(200);
      expect(res.body.version).toMatchObject({ number: 3, summary: 'Restored version 1' });
      const v3 = await call(code, { viewer: viewer(person('owner')) }, { id, number: '3', ...asGame });
      expect(v3.body.content).toBe(APP);
      expect((await call(versions, { viewer: viewer(person('owner')) }, { id, ...asGame })).body.versions).toHaveLength(3);
      expect(bucketKeys()).toHaveLength(3);
    });

    it('refuses to restore the latest, a missing version, and anyone but the owner', async () => {
      const made = await makeApp();
      const id = made.artifact.id;
      expect((await call(restore, { viewer: viewer(person('owner')), number: 1 }, { id, ...asGame })).body.error).toBe('already_latest');
      expect((await call(restore, { viewer: viewer(person('owner')), number: 5 }, { id, ...asGame })).body.error).toBe('version_not_found');
      expect((await call(restore, { viewer: viewer(person('friend')), number: 1 }, { id, ...asGame })).status).toBe(403);
    });
  });

  describe('make a copy', () => {
    it('gives the person their own artifact, in no chat, that only they can open', async () => {
      const made = await makeApp();
      await call(share, { viewer: viewer(person('owner')), openScope: 'link' }, { id: made.artifact.id, method: 'PUT', ...asGame });
      const res = await call(copy, { viewer: viewer(person('stranger'), false) }, { id: made.artifact.id, ...asGame });
      expect(res.status).toBe(200);
      expect(res.body.artifact).toMatchObject({ title: 'Quests board', owner: { name: 'Stranger' }, version: 1, makerName: 'Scout', chatKind: null, copiedFromId: made.artifact.id, openScope: 'chat', changeScope: 'owner' });
      expect(res.body.you.owner).toBe(true);
      const copyId = res.body.artifact.id;
      expect(copyId).not.toBe(made.artifact.id);
      expect((await call(mine, { person: person('stranger') }, asGame)).body.artifacts.map((a: { id: string }) => a.id)).toEqual([copyId]);
      expect((await call(open, { viewer: viewer(person('friend')) }, { id: copyId, ...asGame })).status).toBe(404);
      expect((await call(open, { viewer: viewer(person('stranger'), false) }, { id: copyId, ...asGame })).status).toBe(200);
    });

    it('is the copier\'s to change with any bot they talk to, and the original is untouched', async () => {
      const made = await makeApp();
      const copied = await call(copy, { viewer: viewer(person('friend')) }, { id: made.artifact.id, ...asGame });
      const changed = await call(change, { botId: 'bot1', person: person('friend'), chat: DM, content: '<p>mine</p>' }, { id: copied.body.artifact.id });
      expect(changed.body.artifact.version).toBe(2);
      expect(db.artifacts.find((a) => a.id === made.artifact.id)?.latestVersion).toBe(1);
    });

    it('copies the file itself, so deleting the original leaves the copy whole', async () => {
      const made = await makeApp();
      const copied = await call(copy, { viewer: viewer(person('friend')) }, { id: made.artifact.id, ...asGame });
      db.artifacts = db.artifacts.filter((a) => a.id === copied.body.artifact.id) as typeof db.artifacts;
      const code1 = await call(code, { viewer: viewer(person('friend')) }, { id: copied.body.artifact.id, number: '1', ...asGame });
      expect(code1.body.content).toBe(APP);
      expect(bucketKeys()).toHaveLength(2);
    });

    it('copies an older version when asked', async () => {
      const made = await makeApp();
      await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content: '<p>2</p>' }, { id: made.artifact.id });
      const copied = await call(copy, { viewer: viewer(person('owner')), version: 1 }, { id: made.artifact.id, ...asGame });
      expect(copied.body.version.summary).toBe('Copy of version 1');
      const text = await call(code, { viewer: viewer(person('owner')) }, { id: copied.body.artifact.id, number: '1', ...asGame });
      expect(text.body.content).toBe(APP);
    });

    it('needs an account, and the right to open the original', async () => {
      const made = await makeApp();
      expect(await call(copy, { viewer: viewer(guest) }, { id: made.artifact.id, ...asGame })).toMatchObject({ status: 403, body: { error: 'sign_in_required' } });
      expect((await call(copy, { viewer: viewer(person('stranger'), false) }, { id: made.artifact.id, ...asGame })).status).toBe(404);
    });
  });

  describe('guest artifacts', () => {
    it('are cleared with their files once their day is over, whenever the next artifact is made', async () => {
      const gone = await makeApp(guest);
      await call(change, { botId: 'bot1', person: guest, chat: NEARBY, content: '<p>2</p>' }, { id: gone.artifact.id });
      const kept = await makeApp(person('owner'));
      db.artifacts.find((a) => a.id === gone.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      expect(bucketKeys()).toHaveLength(3);
      await makeApp(person('friend'));
      expect(db.artifacts.map((a) => a.id)).not.toContain(gone.artifact.id);
      expect(db.artifacts.map((a) => a.id)).toContain(kept.artifact.id);
      expect(db.versions.filter((v) => v.artifactId === gone.artifact.id)).toHaveLength(0);
      expect(bucketKeys()).toHaveLength(2);
    });

    it('are also cleared when someone opens an artifact, at most once a minute', async () => {
      const gone = await makeApp(guest);
      const kept = await makeApp(person('owner'));
      db.artifacts.find((a) => a.id === gone.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      expect((await call(open, { viewer: viewer(person('owner')) }, { id: kept.artifact.id, ...asGame })).status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.artifacts.map((a) => a.id)).not.toContain(gone.artifact.id);
      expect(bucketKeys()).toHaveLength(1);

      const second = await makeApp(guest);
      db.artifacts.find((a) => a.id === second.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      await call(open, { viewer: viewer(person('owner')) }, { id: kept.artifact.id, ...asGame });
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.artifacts.map((a) => a.id)).toContain(second.artifact.id);
    });

    it('are cleared in batches, so a long backlog does not stay', async () => {
      for (let i = 0; i < 60; i++) {
        db.artifacts.push({ id: `old-${i}`, ownerId: null, expiresAt: new Date(Date.now() - 1000), versions: [] });
      }
      expect(await pruneExpired({ files: fakeFiles, now: new Date() })).toBe(60);
      expect(db.artifacts.filter((a) => String(a.id).startsWith('old-'))).toHaveLength(0);
    });

    it('keeps one, with its files, that was changed while the clearing ran', async () => {
      const busy = await makeApp(guest);
      const gone = await makeApp(guest);
      for (const made of [busy, gone]) db.artifacts.find((a) => a.id === made.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      const findMany = fakePrisma.artifact.findMany;
      // Between finding the expired ones and deleting them, a change pushes the end of one of them further
      const spy = jest.spyOn(fakePrisma.artifact, 'findMany').mockImplementationOnce(async (args: unknown) => {
        const found = await findMany(args as never);
        db.artifacts.find((a) => a.id === busy.artifact.id)!.expiresAt = new Date(Date.now() + 60_000);
        return found;
      });
      expect(await pruneExpired({ files: fakeFiles, now: new Date() })).toBe(1);
      spy.mockRestore();
      expect(db.artifacts.map((a) => a.id)).toEqual([busy.artifact.id]);
      expect(db.versions.filter((v) => v.artifactId === busy.artifact.id).map((v) => v.fileKey).every((key) => bucketKeys().includes(key))).toBe(true);
      expect(bucketKeys()).toHaveLength(1);
    });

    it('tries again with the files the bucket would not remove', async () => {
      const gone = await makeApp(guest);
      db.artifacts.find((a) => a.id === gone.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = jest.spyOn(fakeFiles, 'remove').mockRejectedValueOnce(new Error('bucket down'));
      expect(await pruneExpired({ files: fakeFiles, now: new Date() })).toBe(1);
      expect(db.artifacts.map((a) => a.id)).not.toContain(gone.artifact.id);
      expect(bucketKeys()).toHaveLength(1);
      failing.mockRestore();
      // The next pass has nothing new to clear but still removes what was left behind
      await pruneExpired({ files: fakeFiles, now: new Date() });
      expect(bucketKeys()).toHaveLength(0);
    });

    it('keeps the files of two passes that both failed while they overlapped', async () => {
      const first = await makeApp(guest);
      db.artifacts.find((a) => a.id === first.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let failFirst: (error: Error) => void = () => undefined;
      const failing = jest
        .spyOn(fakeFiles, 'remove')
        .mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject; }))
        .mockRejectedValueOnce(new Error('bucket down'));
      // The first pass waits on the bucket while a second one clears another artifact and fails too
      const slow = pruneExpired({ files: fakeFiles, now: new Date() });
      await new Promise((resolve) => setImmediate(resolve));
      const second = await makeApp(guest);
      db.artifacts.find((a) => a.id === second.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
      await pruneExpired({ files: fakeFiles, now: new Date() });
      failFirst(new Error('bucket down'));
      await slow;
      failing.mockRestore();
      expect(bucketKeys()).toHaveLength(2);
      await pruneExpired({ files: fakeFiles, now: new Date() });
      expect(bucketKeys()).toHaveLength(0);
    });

    it('clears nothing when nothing has run out', async () => {
      await makeApp(guest);
      expect(await pruneExpired({ files: fakeFiles, now: new Date() })).toBe(0);
    });
  });
});
