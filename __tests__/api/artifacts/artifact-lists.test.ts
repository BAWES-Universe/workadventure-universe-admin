import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as chatList } from '@/app/api/artifacts/chat/route';
import { PUT as share } from '@/app/api/artifacts/[id]/share/route';
import { GET as mine } from '@/app/api/me/artifacts/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { getSessionUser } from '@/lib/auth-session';
import { ARTIFACT_PAGE_SIZE, resetPruneClock } from '@/lib/artifact-service';
import { addBot, addUser, db } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

/** The lists people see (game #1474): one chat's artifacts in the game, and all of yours on You in Orbit. */

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const DM = { kind: 'dm', ref: '!room:chat.example' };
const person = (id: string) => ({ signedIn: true, identifier: `uuid-${id}`, name: id });
const guest = { signedIn: false, name: 'Visitor' };
type Who = ReturnType<typeof person> | typeof guest;

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, body: unknown, token: string | null = ADMIN_TOKEN, id = '', method = 'POST') {
  const request = new NextRequest('http://localhost:3333/api/artifacts', {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

async function makeOne(who: Who, chat: object, title: string) {
  const res = await call(make, { botId: 'bot1', person: who, chat, title, kind: 'page', content: '<p>x</p>' }, BOT_TOKEN);
  expect(res.status).toBe(200);
  return res.body.artifact as { id: string };
}

/** The list a chat's profile shows this person, as the game asks for it. */
async function listFor(who: Who, chat: object, inChat: boolean, offset?: number) {
  return call(chatList, { viewer: { person: who, inChat, chat }, ...(offset === undefined ? {} : { offset }) });
}
const titles = (res: { body: { artifacts: { title: string }[] } }) => res.body.artifacts.map((artifact) => artifact.title);

async function mineFor(id: string | null, offset?: string) {
  (getSessionUser as jest.Mock).mockResolvedValue(id ? { id, uuid: `uuid-${id}`, email: `${id}@example.com`, name: id } : null);
  const response = await mine(new NextRequest(`http://localhost:3333/api/me/artifacts${offset === undefined ? '' : `?offset=${offset}`}`));
  return { status: response.status, body: await response.json() };
}

describe('artifact lists for people (#1474)', () => {
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
    addBot('bot1', 'Scout');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe("a chat's artifacts", () => {
    it('lists what was made in a direct message for its owner, newest first, and for nobody else', async () => {
      const older = await makeOne(person('owner'), DM, 'Older');
      await makeOne(person('owner'), DM, 'Newer');
      db.artifacts.find((a) => a.id === older.id)!.updatedAt = new Date(Date.now() - 60_000);
      const res = await listFor(person('owner'), DM, false);
      expect(res.status).toBe(200);
      expect(titles(res)).toEqual(['Newer', 'Older']);
      expect(res.body).toMatchObject({ total: 2, next: null });
      expect((await listFor(person('friend'), DM, false)).body).toEqual({ artifacts: [], total: 0, next: null });
      expect((await listFor(guest, DM, false)).body.total).toBe(0);
    });

    it("lists everything made in a nearby chat for someone the game says is in it, and only theirs and link-shared ones for anyone else", async () => {
      await makeOne(person('owner'), NEARBY, "Owner's");
      const shared = await makeOne(person('owner'), NEARBY, 'Shared');
      await makeOne(person('friend'), NEARBY, "Friend's");
      await makeOne(guest, NEARBY, "Guest's");
      expect((await call(share, { viewer: { person: person('owner'), inChat: false }, openScope: 'link' }, ADMIN_TOKEN, shared.id, 'PUT')).status).toBe(200);
      const inBubble = await listFor(person('friend'), NEARBY, true);
      expect(titles(inBubble).sort()).toEqual(["Friend's", "Guest's", "Owner's", 'Shared']);
      // Each row says whether it is theirs, so the game names the owner of the others
      const yours = inBubble.body.artifacts.filter((a: { yours: boolean }) => a.yours).map((a: { title: string }) => a.title);
      expect(yours).toEqual(["Friend's"]);
      expect(titles(await listFor(guest, NEARBY, true))).toHaveLength(4);
      // Out of the bubble: their own, and what anyone may open by link
      expect(titles(await listFor(person('friend'), NEARBY, false)).sort()).toEqual(["Friend's", 'Shared']);
      expect(titles(await listFor(guest, NEARBY, false))).toEqual(['Shared']);
      expect((await listFor(guest, NEARBY, true)).body.artifacts.some((a: { yours: boolean }) => a.yours)).toBe(false);
    });

    it('never lists an artifact from another chat, not even the asking person\'s own', async () => {
      await makeOne(person('owner'), DM, 'Direct');
      await makeOne(person('owner'), { kind: 'nearby', ref: 'bubble-2' }, 'Other bubble');
      expect(titles(await listFor(person('owner'), NEARBY, true))).toEqual([]);
    });

    it("leaves out a guest's artifact once its day is over", async () => {
      await makeOne(guest, NEARBY, 'Gone');
      db.artifacts[0].expiresAt = new Date(Date.now() - 1000);
      expect((await listFor(person('friend'), NEARBY, true)).body.total).toBe(0);
    });

    it('hands the list over a page at a time, with the total and where the next page starts', async () => {
      const count = ARTIFACT_PAGE_SIZE * 2 + 3;
      for (let i = 0; i < count; i++) await makeOne(person('owner'), DM, `A${i}`);
      const first = await listFor(person('owner'), DM, false);
      expect(first.body.artifacts).toHaveLength(ARTIFACT_PAGE_SIZE);
      expect(first.body).toMatchObject({ total: count, next: ARTIFACT_PAGE_SIZE });
      const second = await listFor(person('owner'), DM, false, first.body.next);
      expect(second.body.next).toBe(ARTIFACT_PAGE_SIZE * 2);
      const last = await listFor(person('owner'), DM, false, second.body.next);
      expect(last.body.artifacts).toHaveLength(3);
      expect(last.body.next).toBeNull();
      const ids = [first, second, last].flatMap((page) => page.body.artifacts.map((a: { id: string }) => a.id));
      expect(new Set(ids).size).toBe(count);
    });

    it('is for the game only, and wants the chat named', async () => {
      expect((await call(chatList, { viewer: { person: person('owner'), inChat: false, chat: DM } }, BOT_TOKEN)).status).toBe(401);
      expect((await call(chatList, { viewer: { person: person('owner'), inChat: false } })).status).toBe(400);
      expect((await call(chatList, { viewer: { person: person('owner'), inChat: false, chat: DM }, offset: -1 })).status).toBe(400);
    });
  });

  describe('all yours, on You', () => {
    it('lists every artifact the signed-in person owns, from every chat, and nobody else\'s', async () => {
      await makeOne(person('owner'), DM, 'Direct');
      await makeOne(person('owner'), NEARBY, 'Bubble');
      await makeOne(person('friend'), NEARBY, "Friend's");
      await makeOne(guest, NEARBY, "Guest's");
      const res = await mineFor('owner');
      expect(res.status).toBe(200);
      expect(titles(res).sort()).toEqual(['Bubble', 'Direct']);
      expect(res.body).toMatchObject({ total: 2, next: null });
    });

    it('pages like the chat list', async () => {
      for (let i = 0; i < ARTIFACT_PAGE_SIZE + 1; i++) await makeOne(person('owner'), DM, `A${i}`);
      const first = await mineFor('owner');
      expect(first.body).toMatchObject({ total: ARTIFACT_PAGE_SIZE + 1, next: ARTIFACT_PAGE_SIZE });
      const last = await mineFor('owner', String(first.body.next));
      expect(last.body.artifacts).toHaveLength(1);
      expect(last.body.next).toBeNull();
    });

    it('wants someone signed in and a sensible offset', async () => {
      expect((await mineFor(null)).status).toBe(401);
      expect((await mineFor('owner', 'abc')).status).toBe(400);
      expect((await mineFor('owner', '-5')).status).toBe(400);
    });
  });
});
