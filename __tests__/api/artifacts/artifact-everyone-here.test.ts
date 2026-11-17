import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as inChat } from '@/app/api/artifacts/in-chat/route';
import { POST as change } from '@/app/api/artifacts/[id]/change/route';
import { POST as read } from '@/app/api/artifacts/[id]/read/route';
import { PUT as share } from '@/app/api/artifacts/[id]/share/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { resetPruneClock } from '@/lib/artifact-service';
import { addBot, addUser, db, fakePrisma } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

/**
 * A bot's reply that other people in the chat read too (game #1993). The bot server says so with `everyoneHere: true`, and
 * Orbit then answers as it would for someone in the chat who owns nothing: such a reply never takes in its person's
 * "Just you", nor what they have in another chat, unless they pointed at it in front of everyone and it opens by link.
 */

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const DM = { kind: 'dm', ref: '!room:chat.example' };
const PAGE = '<html><body><h1>Trip budget</h1></body></html>';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, name: 'Visitor' };
type Who = ReturnType<typeof person> | typeof guest;

async function call(handler: unknown, body: unknown, options: { id?: string; token?: string; method?: string } = {}) {
  const request = new NextRequest('http://localhost:3333/api/artifacts', {
    method: options.method ?? 'POST',
    headers: { Authorization: `Bearer ${options.token ?? BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '' }) });
  return { status: response.status, body: await response.json() };
}

async function makePage(extra: { who?: Who; chat?: object; bot?: string; title?: string } = {}): Promise<string> {
  const res = await call(make, { botId: extra.bot ?? 'bot1', person: extra.who ?? person('owner'), chat: extra.chat ?? NEARBY, title: extra.title ?? 'Trip budget', kind: 'page', content: PAGE });
  expect(res.status).toBe(200);
  return res.body.artifact.id as string;
}

async function shareIt(id: string, sharing: object, chat: object = NEARBY) {
  const res = await call(share, { viewer: { person: person('owner'), inChat: true, chat }, ...sharing }, { id, method: 'PUT', token: ADMIN_TOKEN });
  expect(res.status).toBe(200);
}

/** The owner asks the bot, in the nearby chat, with other people there or alone. */
const asks = (extra: object = {}, who: Who = person('owner')) => ({ botId: 'bot1', person: who, chat: NEARBY, ...extra });
const forEveryone = (extra: object = {}, who: Who = person('owner')) => asks({ everyoneHere: true, ...extra }, who);
const ids = (res: { body: { artifacts: { id: string }[] } }) => res.body.artifacts.map((artifact) => artifact.id);
const versionsOf = (id: string) => db.versions.filter((version) => version.artifactId === id);

describe('a reply other people in the chat read (game #1993)', () => {
  const env = { bot: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, orbit: process.env.NEXT_PUBLIC_API_URL, adminUrl: process.env.ADMIN_API_URL };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterAll(() => {
    restore('BOT_SERVICE_TOKEN', env.bot);
    restore('ADMIN_API_TOKEN', env.admin);
    restore('NEXT_PUBLIC_API_URL', env.orbit);
    restore('ADMIN_API_URL', env.adminUrl);
  });
  beforeEach(() => {
    process.env.BOT_SERVICE_TOKEN = BOT_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    // "Just you" serves its files itself, so Orbit has to know its own address
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example.test';
    delete process.env.ADMIN_API_URL;
    db.reset();
    resetPruneClock();
    jest.restoreAllMocks();
    addUser('owner');
    addUser('friend');
    addBot('bot1', 'Brick');
    addBot('bot2', 'Pixel');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe('reading', () => {
    it('reads what this chat shares, whoever asks', async () => {
      const id = await makePage();
      for (const who of [person('owner'), person('friend'), guest]) {
        const res = await call(read, forEveryone({}, who), { id });
        expect(res.status).toBe(200);
        expect(res.body.content).toBe(PAGE);
      }
    });

    it('never reads its own person’s "Just you": the answer names nothing of it, and alone it reads as before', async () => {
      const id = await makePage();
      await shareIt(id, { openScope: 'me' });
      const res = await call(read, forEveryone(), { id });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('kept_private');
      expect(JSON.stringify(res.body)).not.toContain('budget');
      // With nobody else there, the same request reads it
      expect((await call(read, asks(), { id })).body.content).toBe(PAGE);
      expect((await call(read, asks({ everyoneHere: false }), { id })).body.content).toBe(PAGE);
      expect((await call(read, asks({ everyoneHere: null }), { id })).body.content).toBe(PAGE);
    });

    it('never reads what its person has in another chat, the bot’s own work for them included', async () => {
      const fromDm = await makePage({ chat: DM });
      const res = await call(read, forEveryone(), { id: fromDm });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
      // Alone, the bot reaches what it made for them anywhere
      expect((await call(read, asks(), { id: fromDm })).status).toBe(200);
    });

    it('reads one from another chat only when its person pointed at it and it opens by link', async () => {
      const fromDm = await makePage({ chat: DM });
      const pointed = forEveryone({ referencedArtifactIds: [fromDm] });
      // Shared with that chat only: the people here could not open it, so the reply does not either
      expect((await call(read, pointed, { id: fromDm })).body.error).toBe('not_found');
      await shareIt(fromDm, { openScope: 'link' }, DM);
      const res = await call(read, pointed, { id: fromDm });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe(PAGE);
      // Not pointed at: still out of reach, whatever its sharing
      expect((await call(read, forEveryone(), { id: fromDm })).body.error).toBe('not_found');
      // "Just you" and pointed at: no
      await shareIt(fromDm, { openScope: 'me' }, DM);
      expect((await call(read, pointed, { id: fromDm })).body.error).toBe('not_found');
    });

    it('takes yes or no, and nothing else', async () => {
      const id = await makePage();
      for (const wrong of ['yes', 1, {}]) expect((await call(read, asks({ everyoneHere: wrong }), { id })).status).toBe(400);
      for (const wrong of ['yes', 1]) expect((await call(inChat, asks({ everyoneHere: wrong }))).status).toBe(400);
    });
  });

  describe('the list a bot gets', () => {
    it('lists only this chat’s, and of those only what everyone here may open', async () => {
      const shared = await makePage({ title: 'Shared' });
      const byLink = await makePage({ title: 'By link' });
      await shareIt(byLink, { openScope: 'link' });
      const kept = await makePage({ title: 'Kept' });
      await shareIt(kept, { openScope: 'me' });
      const fromDm = await makePage({ chat: DM, title: 'From direct messages' });
      const friends = await makePage({ who: person('friend'), title: 'A friend’s' });

      const listed = await call(inChat, forEveryone());
      expect(listed.status).toBe(200);
      expect(ids(listed).sort()).toEqual([shared, byLink, friends].sort());
      expect(JSON.stringify(listed.body)).not.toContain('Kept');
      expect(JSON.stringify(listed.body)).not.toContain('From direct messages');
      // Alone: their own "Just you" and what the bot made for them elsewhere are there too
      expect(ids(await call(inChat, asks())).sort()).toEqual([shared, byLink, kept, fromDm, friends].sort());
    });
  });

  describe('changing', () => {
    const changed = { content: '<p>two</p>' };

    it('changes what this chat shares, for its owner', async () => {
      const id = await makePage();
      const res = await call(change, forEveryone(changed), { id });
      expect(res.status).toBe(200);
      expect(res.body.artifact).toMatchObject({ id, version: 2 });
    });

    it('never changes a "Just you" in front of other people: nothing is saved, and alone it is changed as before', async () => {
      const id = await makePage();
      await shareIt(id, { openScope: 'me' });
      const res = await call(change, forEveryone(changed), { id });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('kept_private');
      expect(versionsOf(id)).toHaveLength(1);
      expect((await call(change, asks(changed), { id })).status).toBe(200);
    });

    it('never changes what its person has in another chat, unless they pointed at it and it opens by link', async () => {
      const fromDm = await makePage({ chat: DM });
      expect((await call(change, forEveryone(changed), { id: fromDm })).body.error).toBe('not_found');
      const pointed = forEveryone({ ...changed, referencedArtifactIds: [fromDm] });
      expect((await call(change, pointed, { id: fromDm })).body.error).toBe('not_found');
      expect(versionsOf(fromDm)).toHaveLength(1);
      await shareIt(fromDm, { openScope: 'link' }, DM);
      const res = await call(change, pointed, { id: fromDm });
      expect(res.status).toBe(200);
      expect(res.body.artifact).toMatchObject({ id: fromDm, version: 2 });
    });

    it('still asks who may change it: someone else only when its owner allowed everyone who can open it', async () => {
      const id = await makePage();
      const friend = forEveryone(changed, person('friend'));
      expect((await call(change, friend, { id })).status).toBe(403);
      await shareIt(id, { changeScope: 'openers' });
      expect((await call(change, friend, { id })).status).toBe(200);
    });

    it('does not land, from its owner either, once it became "Just you" in the same moment', async () => {
      const id = await makePage();
      const step = fakePrisma.$transaction;
      jest.spyOn(fakePrisma, '$transaction').mockImplementationOnce(async (fn: unknown, options: unknown) => {
        await shareIt(id, { openScope: 'me' });
        return step(fn as never, options as never);
      });
      const res = await call(change, forEveryone(changed), { id });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('stale_version');
      expect(versionsOf(id)).toHaveLength(1);
      // Asking again in front of everyone is refused; alone it lands
      expect((await call(change, forEveryone(changed), { id })).body.error).toBe('kept_private');
      expect((await call(change, asks(changed), { id })).status).toBe(200);
    });
  });
});
