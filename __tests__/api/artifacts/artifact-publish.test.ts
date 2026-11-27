import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as change } from '@/app/api/artifacts/[id]/change/route';
import { POST as read } from '@/app/api/artifacts/[id]/read/route';
import { POST as open } from '@/app/api/artifacts/[id]/open/route';
import { POST as versions } from '@/app/api/artifacts/[id]/versions/route';
import { POST as code } from '@/app/api/artifacts/[id]/versions/[number]/route';
import { PUT as share } from '@/app/api/artifacts/[id]/share/route';
import { POST as publish } from '@/app/api/artifacts/[id]/publish/route';
import { POST as copy } from '@/app/api/artifacts/[id]/copy/route';
import { POST as pay } from '@/app/api/artifacts/[id]/pay/route';
import { POST as chatList } from '@/app/api/artifacts/chat/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { openByLink, resetPruneClock } from '@/lib/artifact-service';
import { addBot, addUser, db, fakePrisma } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));
// The payment side has its own tests; here only who may ask about it
jest.mock('@/lib/app-direct/pay', () => ({ ...jest.requireActual('@/lib/app-direct/pay'), pageTakesPayments: async () => false, orderForArtifact: async () => null, startCheckout: async () => ({ status: 'unavailable' }) }));

/** Publish (game #2115): people who open an artifact only by its link see what its owner published, and nothing newer. */

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const OTHER_BUBBLE = { kind: 'nearby', ref: 'bubble-2' };
const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, name: 'Visitor' };
type Who = ReturnType<typeof person> | typeof guest;
const viewer = (who: Who, inChat: boolean, chat: object = NEARBY) => ({ person: who, inChat, chat });

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, body: unknown, options: { id?: string; number?: string; token?: string | null; method?: string } = {}) {
  const token = options.token === undefined ? ADMIN_TOKEN : options.token;
  const request = new NextRequest('http://localhost:3333/api/artifacts', {
    method: options.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '', number: options.number ?? '' }) });
  return { status: response.status, body: await response.json() };
}

const PAGE_1 = '<p>Summer meetup: pixel cafe</p>';
const PAGE_2 = '<p>Summer meetup: pixel cafe. Attendees: Sara 555-0100</p>';
const PAGE_3 = '<p>Summer meetup: pixel cafe at 5 PM</p>';

async function makePage(title = 'Summer meetup') {
  const res = await call(make, { botId: 'bot1', person: person('owner'), chat: NEARBY, title, kind: 'page', content: PAGE_1 }, { token: BOT_TOKEN });
  expect(res.status).toBe(200);
  return res.body.artifact.id as string;
}

/** The bot adds a version: what the owner asks for in chat, in the owner's own words. */
async function ask(id: string, content: string, title?: string) {
  const res = await call(change, { botId: 'bot1', person: person('owner'), chat: NEARBY, content, ...(title ? { title } : {}) }, { id, token: BOT_TOKEN });
  expect(res.status).toBe(200);
  return res.body.artifact.version as number;
}

const shareAs = (id: string, openScope: string) => call(share, { viewer: viewer(person('owner'), true), openScope }, { id, method: 'PUT' });
const publishAs = (who: Who, id: string, inChat: boolean, version?: number) => call(publish, { viewer: viewer(who, inChat), ...(version ? { version } : {}) }, { id });
const openAs = (who: Who, id: string, inChat: boolean, version?: number) => call(open, { viewer: viewer(who, inChat), ...(version ? { version } : {}) }, { id });
const htmlOf = (url: string) => db.files.get(url.replace('https://files.example.test/', ''));

describe('artifact Publish', () => {
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
    addBot('bot2', 'Pixel');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe('who may publish', () => {
    it('is the owner alone: a person in its chat is told no, someone who cannot open it is told it is not there, and a bot has no route', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      expect((await publishAs(person('friend'), id, true)).status).toBe(403);
      // Public and not published is closed to someone outside: it is as if it were not there, so publish does not say otherwise
      expect((await publishAs(person('stranger'), id, false)).status).toBe(404);
      expect((await call(publish, { viewer: viewer(person('owner'), true) }, { id, token: BOT_TOKEN })).status).toBe(401);
      expect((await call(publish, { viewer: viewer(person('owner'), true) }, { id, token: null })).status).toBe(401);
      expect(db.artifacts[0].publishedVersion).toBeNull();
    });

    it('is only for an artifact shared by link or Public: "Just you" and "People in this chat" have nothing to publish to', async () => {
      const id = await makePage();
      const inChatOnly = await publishAs(person('owner'), id, true);
      expect(inChatOnly).toMatchObject({ status: 409, body: { error: 'not_shared' } });
      await shareAs(id, 'me');
      expect((await publishAs(person('owner'), id, true)).status).toBe(409);
      expect(db.artifacts[0].publishedVersion).toBeNull();
    });

    it('publishes the latest version under the title it has, and says when', async () => {
      const id = await makePage('Summer meetup');
      await shareAs(id, 'public');
      const res = await publishAs(person('owner'), id, true);
      expect(res.status).toBe(200);
      expect(res.body.artifact.published).toMatchObject({ version: 1 });
      expect(new Date(res.body.artifact.published.at).getTime()).toBeGreaterThan(Date.now() - 10_000);
      expect(db.artifacts[0]).toMatchObject({ publishedVersion: 1, publishedTitle: 'Summer meetup' });
    });

    it('publishes the version the owner was looking at, not a newer one that landed since', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await ask(id, PAGE_2);
      const res = await publishAs(person('owner'), id, true, 1);
      expect(res.body.artifact.published.version).toBe(1);
      expect((await publishAs(person('owner'), id, true, 9)).status).toBe(404);
      expect(db.artifacts[0].publishedVersion).toBe(1);
    });

    it('does not publish onto an artifact that went "Just you" after the owner pressed the button', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      const real = fakePrisma.artifactVersion.findUnique;
      // Another window makes it private while this call is between reading it and writing it
      const spy = jest.spyOn(fakePrisma.artifactVersion, 'findUnique').mockImplementationOnce(async (args: unknown) => {
        db.artifacts[0].openScope = 'me';
        return real(args);
      });
      const res = await publishAs(person('owner'), id, true);
      spy.mockRestore();
      expect(res.status).toBe(409);
      expect(db.artifacts[0].publishedVersion).toBeNull();
    });
  });

  describe('Public', () => {
    it('is not available to anyone outside until a version is published, and never shows the latest instead', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await expect(openByLink(id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
      expect((await openAs(guest, id, false)).status).toBe(404);
      expect((await openAs(person('stranger'), id, false)).status).toBe(404);
      expect((await call(versions, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(404);
      expect((await call(copy, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(404);
      // Its owner and the people in its chat open it as they always did
      expect((await openAs(person('owner'), id, true)).status).toBe(200);
      expect((await openAs(person('friend'), id, true)).status).toBe(200);
    });

    it('does not let a visitor ask about paying on a page that is not published, and lets them once it is', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      expect((await call(pay, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(404);
      // Its owner and the people in its chat are asked as before: the answer is whether payments are on
      expect((await call(pay, { viewer: viewer(person('friend'), true) }, { id })).status).toBe(200);
      await publishAs(person('owner'), id, true);
      expect((await call(pay, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(200);
    });

    it('shows the published version to people outside, under the title it had then, and the latest to its owner and its chat', async () => {
      const id = await makePage('Summer meetup');
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      // The owner asks for the attendee list, and the title changes with it
      expect(await ask(id, PAGE_2, 'Summer meetup: who is coming')).toBe(2);

      const visitor = await openAs(person('stranger'), id, false);
      expect(visitor.status).toBe(200);
      expect(visitor.body.version.number).toBe(1);
      expect(htmlOf(visitor.body.version.url)).toBe(PAGE_1);
      // Nothing tells them a newer one exists: not its number, not its title
      expect(visitor.body.artifact).toMatchObject({ version: 1, title: 'Summer meetup' });
      expect(JSON.stringify(visitor.body)).not.toContain('who is coming');

      const guestView = await openAs(guest, id, false);
      expect(guestView.body.version.number).toBe(1);

      const page = await openByLink(id);
      expect(page).toMatchObject({ version: 1, title: 'Summer meetup' });
      expect(htmlOf(page.url as string)).toBe(PAGE_1);

      const inChat = await openAs(person('friend'), id, true);
      expect(inChat.body.version.number).toBe(2);
      expect(inChat.body.artifact).toMatchObject({ version: 2, title: 'Summer meetup: who is coming' });
      const owner = await openAs(person('owner'), id, true);
      expect(owner.body.version.number).toBe(2);
      expect(owner.body.artifact.published).toMatchObject({ version: 1, available: true });
    });

    it('treats a person who is not vouched to be in its chat as outside, even in another chat of their own', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      const elsewhere = await call(open, { viewer: viewer(person('friend'), true, OTHER_BUBBLE) }, { id });
      expect(elsewhere.body.version.number).toBe(1);
    });

    it('lets nobody outside reach an unpublished version any other way', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      const stranger = viewer(person('stranger'), false);
      // Open a version by number, its code, the list of versions, a copy
      expect((await call(open, { viewer: stranger, version: 2 }, { id })).status).toBe(404);
      expect((await call(code, { viewer: stranger }, { id, number: '2' })).status).toBe(404);
      const list = await call(versions, { viewer: stranger }, { id });
      expect(list.body.versions.map((v: { number: number }) => v.number)).toEqual([1]);
      const shown = await call(code, { viewer: stranger }, { id, number: '1' });
      expect(shown.body.content).toBe(PAGE_1);
      const copied = await call(copy, { viewer: stranger }, { id });
      expect(copied.status).toBe(200);
      expect(copied.body.artifact).toMatchObject({ title: 'Summer meetup', version: 1 });
      expect(htmlOf(copied.body.version.url)).toBe(PAGE_1);
      expect((await call(copy, { viewer: stranger, version: 2 }, { id })).status).toBe(404);
      // The people in its chat keep every version
      const inChat = await call(versions, { viewer: viewer(person('friend'), true) }, { id });
      expect(inChat.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    });

    it("gives another person's bot the published version when it reads the link someone pasted", async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      const pointed = { botId: 'bot2', person: person('stranger'), chat: OTHER_BUBBLE, referencedArtifactIds: [id] };
      const res = await call(read, pointed, { id, token: BOT_TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe(PAGE_1);
      expect(res.body.version.number).toBe(1);
      expect((await call(read, { ...pointed, version: 2 }, { id, token: BOT_TOKEN })).status).toBe(404);
      // In its own chat, a bot reads the latest, as the people there see it
      const here = await call(read, { botId: 'bot1', person: person('friend'), chat: NEARBY }, { id, token: BOT_TOKEN });
      expect(here.body.content).toBe(PAGE_2);
    });

    it('moves on only when the owner publishes again', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      await ask(id, PAGE_3, 'Summer meetup 2026');
      expect((await openAs(person('stranger'), id, false)).body.version.number).toBe(1);
      const again = await publishAs(person('owner'), id, true);
      expect(again.body.artifact.published.version).toBe(3);
      const after = await openAs(person('stranger'), id, false);
      expect(after.body.version.number).toBe(3);
      expect(after.body.artifact.title).toBe('Summer meetup 2026');
      expect(htmlOf(after.body.version.url)).toBe(PAGE_3);
    });

    it('is not available, never the latest, when the published version is gone, and tells its owner so', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      db.versions = db.versions.filter((v) => !(v.artifactId === id && v.number === 1)) as typeof db.versions;
      expect((await openAs(person('stranger'), id, false)).status).toBe(404);
      await expect(openByLink(id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
      expect((await call(versions, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(404);
      // Nor can anyone start paying for it: the check that gates a checkout says no before any order is made
      expect((await call(pay, { viewer: viewer(person('stranger'), false) }, { id })).status).toBe(404);
      const owner = await openAs(person('owner'), id, true);
      expect(owner.body.artifact.published).toMatchObject({ version: 1, available: false });
      // One button fixes it: publish a version that is there
      const fixed = await publishAs(person('owner'), id, true);
      expect(fixed.body.artifact.published.version).toBe(2);
      expect((await openAs(person('stranger'), id, false)).body.version.number).toBe(2);
    });

    it("lists it for people outside the chat only once published, by the title and version that were published", async () => {
      const id = await makePage('Summer meetup');
      await shareAs(id, 'public');
      const listFor = async (who: Who, inChat: boolean) => (await call(chatList, { viewer: viewer(who, inChat) })).body.artifacts as { title: string; version: number }[];
      expect(await listFor(person('stranger'), false)).toEqual([]);
      expect((await listFor(person('friend'), true)).map((a) => a.title)).toEqual(['Summer meetup']);
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2, 'Summer meetup: who is coming');
      expect(await listFor(person('stranger'), false)).toMatchObject([{ title: 'Summer meetup', version: 1 }]);
      expect(await listFor(person('friend'), true)).toMatchObject([{ title: 'Summer meetup: who is coming', version: 2 }]);
    });
  });

  describe('a link', () => {
    it('that was never published works as it always did: the latest version, for everyone', async () => {
      const id = await makePage();
      await shareAs(id, 'link');
      await ask(id, PAGE_2);
      expect((await openAs(person('stranger'), id, false)).body.version.number).toBe(2);
      expect((await openByLink(id)).version).toBe(2);
      const list = await call(versions, { viewer: viewer(person('stranger'), false) }, { id });
      expect(list.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
      expect((await openAs(person('stranger'), id, false, 1)).status).toBe(200);
    });

    it('keeps showing what was published after Public is taken off, and publishes again the same way', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      await shareAs(id, 'link');
      expect((await openByLink(id)).version).toBe(1);
      expect((await openAs(person('stranger'), id, false)).body.version.number).toBe(1);
      const again = await publishAs(person('owner'), id, true);
      expect(again.status).toBe(200);
      expect((await openByLink(id)).version).toBe(2);
    });

    it('is not shown at all once it is only for the chat again, published or not', async () => {
      const id = await makePage();
      await shareAs(id, 'public');
      await publishAs(person('owner'), id, true);
      await shareAs(id, 'chat');
      await expect(openByLink(id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await openAs(person('stranger'), id, false)).status).toBe(404);
      expect((await openAs(person('friend'), id, true)).status).toBe(200);
    });
  });

  describe('when it changed, for someone shown what was published (GPT audit 26 Nov, O12)', () => {
    const T1 = new Date('2026-11-20T10:00:00Z');
    const T2 = new Date('2026-11-21T10:00:00Z');
    const T3 = new Date('2026-11-22T10:00:00Z');
    const rowOf = (id: string) => db.artifacts.find((row) => row.id === id) as { updatedAt: Date; publishedAt: Date | null };
    const listFor = async (who: Who, inChat: boolean) =>
      (await call(chatList, { viewer: viewer(who, inChat) })).body as { artifacts: { id: string; updatedAt: string; version: number }[]; total: number };

    it('tells a visitor of the published version when it was published, never when the draft changed; the owner and the chat still see the change time', async () => {
      const id = await makePage();
      await shareAs(id, 'link');
      await publishAs(person('owner'), id, true);
      await ask(id, PAGE_2);
      Object.assign(rowOf(id), { publishedAt: T1, updatedAt: T3 });
      const stranger = await openAs(person('stranger'), id, false);
      expect(stranger.body.artifact).toMatchObject({ version: 1, updatedAt: T1.toISOString() });
      expect((await openAs(person('friend'), id, true)).body.artifact).toMatchObject({ version: 2, updatedAt: T3.toISOString() });
      expect((await openAs(person('owner'), id, false)).body.artifact).toMatchObject({ version: 2, updatedAt: T3.toISOString() });
    });

    it('lists link-only artifacts by when what the person sees changed, so a draft never moves one up the list', async () => {
      const drafted = await makePage('Drafted');
      const other = await makePage('Other');
      const never = await makePage('Never published');
      for (const id of [drafted, other, never]) await shareAs(id, 'link');
      await publishAs(person('owner'), drafted, true);
      await publishAs(person('owner'), other, true);
      await ask(drafted, PAGE_2);
      // Drafted was published first, then changed last; Other was published after it; Never published shows its latest, changed in between
      Object.assign(rowOf(drafted), { publishedAt: T1, updatedAt: T3 });
      Object.assign(rowOf(other), { publishedAt: T2, updatedAt: T2 });
      Object.assign(rowOf(never), { publishedAt: null, updatedAt: new Date('2026-11-21T12:00:00Z') });
      const outside = await listFor(person('stranger'), false);
      expect(outside.artifacts.map((a) => a.id)).toEqual([never, other, drafted]);
      expect(outside.total).toBe(3);
      expect(outside.artifacts.find((a) => a.id === drafted)).toMatchObject({ version: 1, updatedAt: T1.toISOString() });
      // In the chat everyone sees the latest, by its change time
      const inside = await listFor(person('friend'), true);
      expect(inside.artifacts.map((a) => a.id)).toEqual([drafted, never, other]);
      expect(inside.artifacts[0].updatedAt).toBe(T3.toISOString());
    });
  });
});
