/**
 * A Brick that lives in a room (game #2005) against a real database: "Add one of your Bricks", the Brick's page, "Take
 * it out of this room", the room manager's list of Bricks placed by others, and what a home never does. A home is a row
 * beside the Brick, never the Brick's own room; taking it out, deleting the room, losing access or deleting the Brick
 * removes only that row; today's room bots and their lists are untouched. Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-home-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick } from '@/lib/brick-delete';
import { checkBotAccess } from '@/lib/bot-access';
import { startVisit, whereIsBrick } from '@/lib/brick-visit';
import { dropHomesWithoutAccess } from '@/lib/brick-home';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { GET as getHome, PUT as putHome, DELETE as deleteHome } from '@/app/api/bricks/[id]/home/route';
import { GET as listRoom } from '@/app/api/brick-homes/route';
import { PATCH as moveHome, DELETE as takeOut } from '@/app/api/brick-homes/[id]/route';
import { POST as homeFeed } from '@/app/api/brick-homes/room/route';
import { POST as sweep } from '@/app/api/bricks/sweep/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/route';
import { GET as listRoomBots } from '@/app/api/bots/route';
import { GET as aiCredentials } from '@/app/api/bots/[id]/ai-credentials/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const BASE = 'http://play.workadventure.localhost';
const session = getSessionUser as jest.Mock;
const keyId = `key-${tag}`;

type Person = { id: string; uuid: string; email: string };
let sara: Person, omar: Person, host: Person;
let own = { universeId: '', roomId: '', roomUrl: '', otherRoomUrl: '' }; // Sara owns this universe
let hosted = { universeId: '', roomId: '', roomUrl: '' }; // Host owns it; Sara manages bots in it through a tag
let closed = { universeId: '', roomId: '', roomUrl: '' }; // Host owns it; Sara has nothing there
let brickId = '';
let secondBrickId = '';
let roomBotId = '';
let serverProviderId = '';
const tokensBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN };

const as = (user: Person | null) => session.mockResolvedValue(user ? { id: user.id, email: user.email, name: 'x', isSuperAdmin: false } : null);
const ids = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const service = { Authorization: `Bearer ${SERVICE_TOKEN}` };
const chat = (botId: string, user: Person, action: 'chat' | 'dm' | 'summon' | 'change' | 'deleteOrSend', roomUrl?: string) =>
  checkBotAccess({ botId, action, roomUrl: roomUrl ?? null, person: { signedIn: true, identifier: user.email } });
const put = (id: string, roomUrl: string, extra: Record<string, unknown> = {}) => putHome(call('PUT', `/api/bricks/${id}/home`, { roomUrl, ...extra }), ids(id));
const home = (id: string) => prisma.brickHome.findUnique({ where: { botId: id } });
const SPOT = { assignedSpace: { center: { x: 5, y: 7 }, radius: 3 } };

run('a Brick that lives in a room, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    const person = async (name: string): Promise<Person> => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
      return { id: user.id, uuid: user.uuid, email: user.email! };
    };
    sara = await person('sara');
    omar = await person('omar');
    host = await person('host');
    const make = async (slug: string, ownerId: string, visits = false) => {
      const universe = await prisma.universe.create({ data: { slug: `${slug}-${tag}`, name: `${slug} place`, ownerId, allowVisitingBricks: visits } });
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      await prisma.room.create({ data: { worldId: world.id, slug: 'cafe', name: 'Cafe' } });
      const base = `${BASE}/@/${universe.slug}/hq`;
      return { universeId: universe.id, worldId: world.id, roomId: room.id, roomUrl: `${base}/lobby`, otherRoomUrl: `${base}/cafe` };
    };
    own = await make('own', sara.id);
    const h = await make('hosted', host.id);
    hosted = h;
    await prisma.worldMember.create({ data: { userId: sara.id, worldId: h.worldId, tags: ['admin'] } });
    closed = await make('closed', host.id);
    serverProviderId = `srv-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId: serverProviderId, name: `Server ${tag}`, type: 'openai', enabled: true, isDefault: true, model: 'server-model' } });
    await prisma.botsAiProvider.create({ data: { providerId: keyId, name: 'Sara key', type: 'openai', enabled: true, ownerId: sara.id, model: 'key-model' } });
    brickId = (await createBrick({ ownerId: sara.id, name: 'Brick' })).id;
    secondBrickId = (await createBrick({ ownerId: sara.id, name: 'Recipe Brick' })).id;
    roomBotId = (await prisma.bot.create({ data: { roomId: hosted.roomId, name: 'Nora', createdById: host.id, behaviorConfig: {} } })).id;
  });

  afterAll(async () => {
    await prisma.botsAiProvider.deleteMany({ where: { providerId: { in: [serverProviderId, keyId] } } });
    await prisma.universe.deleteMany({ where: { id: { in: [own.universeId, hosted.universeId, closed.universeId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id, host.id] } } });
    if (tokensBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = tokensBefore.service;
    if (tokensBefore.admin === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = tokensBefore.admin;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brickHome.deleteMany({ where: { botId: { in: [brickId, secondBrickId] } } });
    await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
    await prisma.bot.updateMany({ where: { id: { in: [brickId, secondBrickId] } }, data: { aiProviderRef: UNIVERSE_AI_REF, aiModel: null, enabled: true } });
    await prisma.aiKeyLend.deleteMany({ where: { providerId: keyId } });
    await prisma.worldMember.upsert({ where: { userId_worldId: { userId: sara.id, worldId: (await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } })).id } }, update: { tags: ['admin'] }, create: { userId: sara.id, worldId: (await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } })).id, tags: ['admin'] } });
    as(sara);
  });

  describe('giving a Brick a home', () => {
    it('places it with its spot, says where it lives on its page, and moves it when placed again: one home at most', async () => {
      const first = await put(brickId, own.roomUrl, { behaviorType: 'idle', behaviorConfig: SPOT });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ home: { roomUrl: own.roomUrl, roomName: 'Lobby', universeName: 'own place' }, keyNote: null });
      expect(await home(brickId)).toMatchObject({ roomId: own.roomId, placedById: sara.id, behaviorType: 'idle', behaviorConfig: SPOT });
      expect(await (await getHome(call('GET', `/api/bricks/${brickId}/home`), ids(brickId))).json()).toEqual({ home: { roomUrl: own.roomUrl, roomName: 'Lobby', universeName: 'own place' } });

      expect((await put(brickId, hosted.roomUrl)).status).toBe(200);
      expect(await prisma.brickHome.count({ where: { botId: brickId } })).toBe(1);
      expect((await home(brickId))?.roomId).toBe(hosted.roomId);
    });

    it('is still the same Brick: no room of its own, no copy, still its owner’s', async () => {
      await put(brickId, own.roomUrl);
      expect(await prisma.bot.findUniqueOrThrow({ where: { id: brickId }, select: { roomId: true, ownerId: true, enabled: true } })).toEqual({ roomId: null, ownerId: sara.id, enabled: true });
      expect(await prisma.bot.count({ where: { ownerId: sara.id } })).toBe(2);
    });

    it('says before it is placed that others cannot talk to a Brick on its owner’s key until that key is lent here', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });
      expect(await (await put(brickId, own.roomUrl)).json()).toMatchObject({ keyNote: 'not_lent' });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: own.universeId } });
      expect(await (await put(brickId, own.roomUrl)).json()).toMatchObject({ keyNote: null });
    });

    it('needs a room its owner can manage bots in, a Brick that is theirs, and a well-formed body', async () => {
      expect((await put(brickId, closed.roomUrl)).status).toBe(403);
      expect(await home(brickId)).toBeNull();
      expect((await put(brickId, `${BASE}/@/nothing/here/at-all`)).status).toBe(404);
      expect((await putHome(call('PUT', `/api/bricks/${brickId}/home`, { nope: 1 }), ids(brickId))).status).toBe(400);
      as(omar);
      expect((await put(brickId, own.roomUrl)).status).toBe(404);
      expect((await getHome(call('GET', `/api/bricks/${brickId}/home`), ids(brickId))).status).toBe(404);
      as(sara);
      expect((await put(roomBotId, own.roomUrl)).status).toBe(404);
      as(null);
      expect((await put(brickId, own.roomUrl)).status).toBe(401);
    });
  });

  describe('the map editor’s list and taking it out', () => {
    const list = async (user: Person, roomUrl: string) => {
      as(user);
      return listRoom(call('GET', `/api/brick-homes?roomUrl=${encodeURIComponent(roomUrl)}`));
    };

    it('shows a manager the Bricks standing here, their own first, those placed by others each with Take out, and never an email or an instruction', async () => {
      await put(brickId, hosted.roomUrl, { behaviorConfig: SPOT });
      const own2 = await createBrick({ ownerId: host.id, name: 'Host Brick' });
      await prisma.brickHome.create({ data: { botId: own2.id, roomId: hosted.roomId, placedById: host.id } });
      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'secret instructions' } });
      const asHost = await list(host, hosted.roomUrl);
      expect(asHost.status).toBe(200);
      const body = await asHost.json();
      expect(body.roomName).toBe((await prisma.room.findUniqueOrThrow({ where: { id: hosted.roomId }, select: { name: true } })).name);
      expect(body.here.map((row: { name: string; mine: boolean }) => [row.name, row.mine])).toEqual([['Host Brick', true], ['Brick', false]]);
      expect(body.here.every((row: { canTakeOut: boolean }) => row.canTakeOut)).toBe(true);
      expect(body.here[1].ownerName).toBe('sara');
      // "Khalid's Brick · here since 10 Nov": the day it came
      expect(new Date(body.here[1].since).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(JSON.stringify(body)).not.toMatch(/example\.test|secret instructions/);
      await prisma.bot.delete({ where: { id: own2.id } });
    });

    it('offers a person their own Bricks that can be added, leaving out one that is here already and flagging one at home elsewhere', async () => {
      await put(brickId, hosted.roomUrl);
      await put(secondBrickId, own.roomUrl);
      const body = await (await list(sara, hosted.roomUrl)).json();
      expect(body.mine.map((card: { id: string; homeElsewhere: boolean }) => [card.id, card.homeElsewhere])).toEqual([[secondBrickId, true]]);
    });

    it('is only for someone who can manage bots in the room, and an address that is no room is "not found"', async () => {
      expect((await list(omar, hosted.roomUrl)).status).toBe(404);
      expect((await list(sara, closed.roomUrl)).status).toBe(404);
      expect((await list(sara, `${BASE}/@/x/y/z`)).status).toBe(404);
    });

    it('lets a manager move a Brick placed by someone else, but not place one', async () => {
      await put(brickId, hosted.roomUrl);
      as(host);
      expect((await moveHome(call('PATCH', `/api/brick-homes/${brickId}`, { behaviorConfig: SPOT }), ids(brickId))).status).toBe(200);
      expect((await home(brickId))?.behaviorConfig).toEqual(SPOT);
      expect((await put(secondBrickId, hosted.roomUrl)).status).toBe(404);
      as(omar);
      expect((await moveHome(call('PATCH', `/api/brick-homes/${brickId}`, { behaviorConfig: {} }), ids(brickId))).status).toBe(404);
    });

    it('takes a Brick out: its owner or the room’s manager, nobody else, asked twice the same, and nothing of the owner’s is deleted', async () => {
      await put(brickId, hosted.roomUrl);
      as(omar);
      expect((await takeOut(call('DELETE', `/api/brick-homes/${brickId}`), ids(brickId))).status).toBe(404);
      expect(await home(brickId)).not.toBeNull();
      as(host);
      expect((await takeOut(call('DELETE', `/api/brick-homes/${brickId}`), ids(brickId))).status).toBe(200);
      expect(await home(brickId)).toBeNull();
      expect(await prisma.bot.findUnique({ where: { id: brickId }, select: { ownerId: true, enabled: true, name: true } })).toEqual({ ownerId: sara.id, enabled: true, name: 'Brick' });

      await put(secondBrickId, own.roomUrl);
      as(sara);
      for (let i = 0; i < 2; i++) expect((await deleteHome(call('DELETE', `/api/bricks/${secondBrickId}/home`), ids(secondBrickId))).status).toBe(200);
      expect(await home(secondBrickId)).toBeNull();
    });
  });

  describe('what makes a home go, and what never goes', () => {
    it('keeps the Brick and everything of its owner’s when the room is deleted', async () => {
      const world = await prisma.world.findFirstOrThrow({ where: { universeId: own.universeId } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'temp', name: 'Temp' } });
      expect((await put(brickId, `${BASE}/@/own-${tag}/hq/temp`)).status).toBe(200);
      await prisma.room.delete({ where: { id: room.id } });
      expect(await home(brickId)).toBeNull();
      expect(await prisma.bot.findUnique({ where: { id: brickId } })).toMatchObject({ ownerId: sara.id, roomId: null, enabled: true });
    });

    it('leaves the room when its owner can no longer manage bots there, on a read and in the sweep, and the Brick stays', async () => {
      await put(brickId, hosted.roomUrl);
      await prisma.worldMember.deleteMany({ where: { userId: sara.id, worldId: (await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } })).id } });
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await (await getHome(call('GET', `/api/bricks/${brickId}/home`), ids(brickId))).json()).toEqual({ home: null });
      expect(await home(brickId)).toBeNull();

      await prisma.worldMember.create({ data: { userId: sara.id, worldId: (await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } })).id, tags: ['admin'] } });
      await put(brickId, hosted.roomUrl);
      await prisma.worldMember.deleteMany({ where: { userId: sara.id, worldId: (await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } })).id } });
      expect((await sweep(call('POST', '/api/bricks/sweep', undefined, service))).status).toBe(200);
      expect(await home(brickId)).toBeNull();
      expect(await prisma.bot.findUnique({ where: { id: brickId } })).not.toBeNull();
    });

    it('the sweep reads every home, page after page, so a stale one is never left behind healthy ones', async () => {
      const world = await prisma.world.findFirstOrThrow({ where: { universeId: hosted.universeId } });
      await put(brickId, own.roomUrl);
      await put(secondBrickId, hosted.roomUrl);
      await prisma.worldMember.deleteMany({ where: { userId: sara.id, worldId: world.id } });
      // One home per page: the healthy one may come first, the stale one is still reached
      expect(await dropHomesWithoutAccess(undefined, 1)).toBe(1);
      expect(await home(secondBrickId)).toBeNull();
      expect(await home(brickId)).not.toBeNull();
      await prisma.worldMember.create({ data: { userId: sara.id, worldId: world.id, tags: ['admin'] } });
    });

    it('is withdrawn, with its visit, when its owner deletes the Brick, and Undo does not bring it back', async () => {
      await put(brickId, own.roomUrl);
      await prisma.universe.update({ where: { id: own.universeId }, data: { allowVisitingBricks: true } });
      await startVisit(brickId, sara.id, own.roomUrl);
      await deleteBrick(brickId, sara.id);
      expect(await home(brickId)).toBeNull();
      expect(await prisma.brickVisit.count({ where: { botId: brickId } })).toBe(0);
      await prisma.bot.update({ where: { id: brickId }, data: { deletedAt: null, goneAt: null, enabled: true, enabledBeforeDelete: null } });
    });

    it('is not on the map while the Brick is switched off', async () => {
      await put(brickId, own.roomUrl);
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await whereIsBrick(brickId, null)).toBeNull();
      const feed = await (await homeFeed(call('POST', '/api/brick-homes/room', { roomUrl: own.roomUrl }, service))).json();
      expect(feed).toEqual([]);
    });
  });

  describe('what the bot server is given', () => {
    it('is each Brick that lives in the room, in the Brick shape with where it stands and whose it is, voice off', async () => {
      await put(brickId, own.roomUrl, { behaviorType: 'idle', behaviorConfig: SPOT });
      const response = await homeFeed(call('POST', '/api/brick-homes/room', { roomUrl: own.roomUrl }, service));
      expect(response.status).toBe(200);
      const feed = await response.json();
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        botId: brickId, roomUrl: own.roomUrl, behaviorType: 'idle', enabled: true, voiceEnabled: false,
        assignedSpace: SPOT.assignedSpace, brick: { ownerId: sara.id, deleted: false, home: { ownerUuid: sara.uuid } },
      });
      expect(await (await homeFeed(call('POST', '/api/brick-homes/room', { roomUrl: own.otherRoomUrl }, service))).json()).toEqual([]);
    });

    it('refuses a spot or a route that is not shaped like one, on placing and on moving, and stores nothing', async () => {
      await put(brickId, own.roomUrl, { behaviorConfig: SPOT });
      for (const bad of ['text', [], { assignedSpace: 'here' }, { assignedSpace: { center: { x: 'a', y: 1 }, radius: 3 } }, { assignedSpace: { center: { x: 1, y: 1 }, radius: -1 } }, { speed: 'fast' }, { patrolWaypoints: [{ x: 1 }] }, { moves: 'fly' }]) {
        expect((await put(brickId, own.roomUrl, { behaviorConfig: bad })).status).toBe(400);
        expect((await moveHome(call('PATCH', `/api/brick-homes/${brickId}`, { behaviorConfig: bad }), ids(brickId))).status).toBe(400);
      }
      expect((await home(brickId))?.behaviorConfig).toEqual(SPOT);
    });

    it('never lets a room manager’s edit reach what is the owner’s to set: only the spot and how it moves pass', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { behaviorConfig: { showToolCalls: true, vision: { mode: 'own' } } } });
      await put(brickId, hosted.roomUrl, { behaviorConfig: { ...SPOT, vision: { mode: 'x' }, showToolCalls: false } });
      as(host);
      const pushed = { ...SPOT, speed: 40, vision: { mode: 'steal', keyId: 'k' }, showToolCalls: false, chatInstructions: 'x' };
      expect((await moveHome(call('PATCH', `/api/brick-homes/${brickId}`, { behaviorConfig: pushed }), ids(brickId))).status).toBe(200);
      expect((await home(brickId))?.behaviorConfig).toEqual({ ...SPOT, speed: 40 });
      // A row stored before this rule is cleaned on the way out too
      await prisma.brickHome.update({ where: { botId: brickId }, data: { behaviorConfig: pushed } });
      const feed = await (await homeFeed(call('POST', '/api/brick-homes/room', { roomUrl: hosted.roomUrl }, service))).json();
      expect(feed[0].behaviorConfig).toMatchObject({ speed: 40, showToolCalls: true, vision: { mode: 'own' } });
      expect(feed[0].behaviorConfig.chatInstructions).toBeUndefined();
      await prisma.bot.update({ where: { id: brickId }, data: { behaviorConfig: {} } });
    });

    it('needs the bot server’s token', async () => {
      expect((await homeFeed(call('POST', '/api/brick-homes/room', { roomUrl: own.roomUrl }))).status).toBe(401);
      expect((await homeFeed(call('POST', '/api/brick-homes/room', {}, service))).status).toBe(400);
    });

    it('leaves today’s room bots and their lists exactly as they were: no Brick in either', async () => {
      await put(brickId, hosted.roomUrl);
      as(null);
      const configured = await getConfiguration(new NextRequest(`http://localhost/api/bots/configuration?roomUrl=${encodeURIComponent(hosted.roomUrl)}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(((await configured.json()) as { botId: string }[]).map((bot) => bot.botId)).toEqual([roomBotId]);
      const roomList = await listRoomBots(new NextRequest(`http://localhost/api/bots?roomId=${encodeURIComponent(hosted.roomUrl)}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(roomList.status).toBe(200);
      expect(((await roomList.json()) as { id: string }[]).map((bot) => bot.id)).toEqual([roomBotId]);
    });
  });

  describe('who may talk to a Brick that lives in a room, and who pays', () => {
    const credentials = (asker: string, roomUrl?: string) => aiCredentials(call('GET', `/api/bots/${brickId}/ai-credentials?asker=${encodeURIComponent(asker)}${roomUrl ? `&roomUrl=${encodeURIComponent(roomUrl)}` : ''}`, undefined, service), ids(brickId));

    it('lets other people chat nearby and send a message by the room’s roles, and nothing else, only in its own room', async () => {
      await put(brickId, hosted.roomUrl);
      expect(await chat(brickId, omar, 'chat', hosted.roomUrl)).toMatchObject({ allowed: true });
      expect(await chat(brickId, omar, 'dm')).toMatchObject({ allowed: true });
      for (const who of [omar, host]) for (const action of ['summon', 'change', 'deleteOrSend'] as const) expect(await chat(brickId, who, action, hosted.roomUrl)).toMatchObject({ allowed: false });
      expect(await chat(brickId, omar, 'chat', closed.roomUrl)).toMatchObject({ allowed: false });
      expect(await chat(brickId, sara, 'dm')).toMatchObject({ allowed: true });
      await deleteHome(call('DELETE', `/api/bricks/${brickId}/home`), ids(brickId));
      expect(await chat(brickId, omar, 'chat', hosted.roomUrl)).toMatchObject({ allowed: false });
    });

    it('does not depend on the Visiting Bricks switch: a home stands where visits are not taken', async () => {
      await prisma.universe.update({ where: { id: own.universeId }, data: { allowVisitingBricks: false } });
      await put(brickId, own.roomUrl);
      expect(await chat(brickId, omar, 'chat', own.roomUrl)).toMatchObject({ allowed: true });
    });

    it('answers each person on their own allowance on Universe AI, and on its owner’s key only where lent, never on the chatter’s', async () => {
      await put(brickId, own.roomUrl);
      expect((await credentials(omar.uuid)).status).toBe(200);
      expect(await (await credentials(omar.uuid)).json()).toMatchObject({ source: 'universe-ai' });
      await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });
      // Not lent: others are never refused while Universe AI can answer; it serves them on their own allowance
      const stoodIn = await credentials(omar.uuid);
      expect(stoodIn.status).toBe(200);
      expect(await stoodIn.json()).toMatchObject({ source: 'universe-ai', standingInFor: keyId });
      expect(await (await credentials(sara.uuid)).json()).toMatchObject({ source: 'own-key', providerId: keyId });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: own.universeId } });
      expect(await (await credentials(omar.uuid)).json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
    });

    it('can be at home in one room and visiting in another at the same time, and each room is answered by its own place', async () => {
      await prisma.universe.update({ where: { id: hosted.universeId }, data: { allowVisitingBricks: true } });
      await put(brickId, own.roomUrl);
      await startVisit(brickId, sara.id, hosted.roomUrl);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { roomId: hosted.roomId, seenAt: new Date() } });
      expect((await whereIsBrick(brickId, own.roomUrl))?.kind).toBe('home');
      expect((await whereIsBrick(brickId, hosted.roomUrl))?.kind).toBe('visiting');
      expect(await whereIsBrick(brickId, closed.roomUrl)).toBeNull();
      expect(await chat(brickId, omar, 'chat', own.roomUrl)).toMatchObject({ allowed: true });
      expect(await chat(brickId, omar, 'chat', hosted.roomUrl)).toMatchObject({ allowed: true });
      await prisma.universe.update({ where: { id: hosted.universeId }, data: { allowVisitingBricks: false } });
    });
  });
});
