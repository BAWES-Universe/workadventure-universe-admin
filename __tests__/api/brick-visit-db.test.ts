/**
 * Bringing a Brick along (game #2005) against a real database: what only the database can show. The switch is per
 * universe and a closed one keeps the Brick off the map; a visit is one Brick per person, swapped, ended by its owner
 * or by time, and follows its person from room to room; other people may chat with a visiting Brick by the roles of the
 * place and for nothing else; and the four counting cases hold (Universe AI on each person's own allowance, the owner's
 * key only where it is lent, never the key of the person chatting). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL
 * to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-visit-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { checkBotAccess } from '@/lib/bot-access';
import { credentialsForBot } from '@/lib/bot-ai-credentials';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { endStaleVisits, keepVisitAlive, placeOfRoomUrl, startVisit, visitState, whereIsBrick } from '@/lib/brick-visit';
import { mayReadRoomBots, whoMayReadRoomBots } from '@/lib/bot-room-access';
import { GET as getVisit, POST as postVisit, DELETE as deleteVisit } from '@/app/api/bricks/[id]/visit/route';
import { POST as roomFeed } from '@/app/api/brick-visits/room/route';
import { POST as seenFeed } from '@/app/api/brick-visits/seen/route';
import { POST as sweep } from '@/app/api/bricks/sweep/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/route';
import { GET as aiCredentials } from '@/app/api/bots/[id]/ai-credentials/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const BASE = 'http://play.workadventure.localhost';
const session = getSessionUser as jest.Mock;

const MIN = 60 * 1000;
const NOW = new Date();

let sara = { id: '', uuid: '', email: '' };
let omar = { id: '', uuid: '', email: '' };
let host = { id: '', uuid: '', email: '' };
const universes: Record<'open' | 'closed' | 'second', { id: string; roomId: string; roomUrl: string; otherRoomUrl: string }> = {
  open: { id: '', roomId: '', roomUrl: '', otherRoomUrl: '' },
  closed: { id: '', roomId: '', roomUrl: '', otherRoomUrl: '' },
  second: { id: '', roomId: '', roomUrl: '', otherRoomUrl: '' },
};
let brickId = '';
let secondBrickId = '';
let roomBotId = '';
let serverProviderId = '';
const keyId = `key-${tag}`;

const tokensBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN };

const as = (user: { id: string; email: string } | null, guest = false) =>
  session.mockResolvedValue(user ? { id: user.id, email: user.email, name: 'x', isSuperAdmin: false, ...(guest ? {} : {}) } : null);
const ids = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const service = { Authorization: `Bearer ${SERVICE_TOKEN}` };
const chat = (botId: string, user: { email: string }, action: 'chat' | 'dm' | 'summon' | 'change' | 'deleteOrSend', roomUrl?: string) =>
  checkBotAccess({ botId, action, roomUrl: roomUrl ?? null, person: { signedIn: true, identifier: user.email } });
const CLIENT = 'page-laptop-0001';
const feed = async (roomUrl: string, people: string[], enteredAt?: number, clientId: string | null = enteredAt === undefined ? null : CLIENT) => {
  const response = await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl, people, ...(enteredAt === undefined ? {} : { enteredAt }), ...(clientId ? { clientId } : {}) }, service));
  expect(response.status).toBe(200);
  return (await response.json()) as { botId: string; roomUrl: string; brick: { visiting?: { ownerUuid: string } } }[];
};
const visit = (userId: string) => prisma.brickVisit.findUnique({ where: { userId } });

run('bringing a Brick along, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    const person = async (name: string) => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
      return { id: user.id, uuid: user.uuid, email: user.email! };
    };
    sara = await person('sara');
    omar = await person('omar');
    host = await person('host');
    const place = async (key: 'open' | 'closed' | 'second', takesVisits: boolean) => {
      const universe = await prisma.universe.create({ data: { slug: `${key}-${tag}`, name: `${key} place`, ownerId: host.id, allowVisitingBricks: takesVisits } });
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      await prisma.room.create({ data: { worldId: world.id, slug: 'cafe', name: 'Cafe' } });
      const base = `${BASE}/@/${universe.slug}/hq`;
      universes[key] = { id: universe.id, roomId: room.id, roomUrl: `${base}/lobby`, otherRoomUrl: `${base}/cafe` };
    };
    await place('open', true);
    await place('closed', false);
    await place('second', true);
    serverProviderId = `srv-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId: serverProviderId, name: `Server ${tag}`, type: 'openai', enabled: true, isDefault: true, model: 'server-model' } });
    await prisma.botsAiProvider.create({ data: { providerId: keyId, name: 'Sara key', type: 'openai', enabled: true, ownerId: sara.id, model: 'key-model' } });
    brickId = (await createBrick({ ownerId: sara.id, name: 'Brick' })).id;
    secondBrickId = (await createBrick({ ownerId: sara.id, name: 'Recipe Brick' })).id;
    roomBotId = (await prisma.bot.create({ data: { roomId: universes.open.roomId, name: 'Nora', createdById: host.id, behaviorConfig: {} } })).id;
  });

  afterAll(async () => {
    await prisma.botsAiProvider.deleteMany({ where: { providerId: { in: [serverProviderId, keyId] } } });
    await prisma.universe.deleteMany({ where: { id: { in: Object.values(universes).map((one) => one.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id, host.id] } } });
    if (tokensBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = tokensBefore.service;
    if (tokensBefore.admin === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = tokensBefore.admin;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brickVisit.deleteMany({ where: { userId: { in: [sara.id, omar.id] } } });
    await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: UNIVERSE_AI_REF, aiModel: null, enabled: true } });
    await prisma.aiKeyLend.deleteMany({ where: { providerId: keyId } });
    await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: true } });
    as(sara);
  });

  describe('the switch and the page', () => {
    it('is on for a universe made with the default and says so on the universe', async () => {
      const made = await prisma.universe.create({ data: { slug: `fresh-${tag}`, name: 'fresh', ownerId: host.id } });
      expect(made.allowVisitingBricks).toBe(true);
      await prisma.universe.delete({ where: { id: made.id } });
    });

    it('offers "Bring along" where visits are taken, and says one line where they are not', async () => {
      const takes = await getVisit(call('GET', `/api/bricks/${brickId}/visit?roomUrl=${encodeURIComponent(universes.open.roomUrl)}`), ids(brickId));
      expect(await takes.json()).toEqual({ state: 'none', place: 'open place' });
      const refuses = await getVisit(call('GET', `/api/bricks/${brickId}/visit?roomUrl=${encodeURIComponent(universes.closed.roomUrl)}`), ids(brickId));
      expect(await refuses.json()).toEqual({ state: 'blocked', place: 'closed place', visiting: false });
    });

    it('refuses to bring a Brick along to a place that does not take visits, and changes nothing', async () => {
      const response = await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.closed.roomUrl }), ids(brickId));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: 'not_taken', place: 'closed place' });
      expect(await visit(sara.id)).toBeNull();
    });

    it('brings a Brick along, says where it is, and ends the visit with one tap, asked twice the same', async () => {
      const started = await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(brickId));
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ state: 'visiting', place: 'open place' });
      expect((await visit(sara.id))?.botId).toBe(brickId);
      const state = await getVisit(call('GET', `/api/bricks/${brickId}/visit?roomUrl=${encodeURIComponent(universes.open.otherRoomUrl)}`), ids(brickId));
      expect(await state.json()).toMatchObject({ state: 'visiting', place: 'open place' });

      for (let i = 0; i < 2; i++) {
        const ended = await deleteVisit(call('DELETE', `/api/bricks/${brickId}/visit`), ids(brickId));
        expect(ended.status).toBe(200);
        expect(await ended.json()).toEqual({ state: 'none', place: null });
      }
      expect(await visit(sara.id)).toBeNull();
      // Ending a visit removes the visit and nothing else: the Brick is the same bot, on, and no second bot was made
      expect(await prisma.bot.findUnique({ where: { id: brickId }, select: { enabled: true, ownerId: true, roomId: true } })).toEqual({ enabled: true, ownerId: sara.id, roomId: null });
      expect(await prisma.bot.count({ where: { ownerId: sara.id } })).toBe(2);
    });

    it('ends as one visit when the same person taps twice at once, without a failure (Sentry on #927)', async () => {
      const answers = await Promise.all([1, 2, 3].map(() => startVisit(brickId, sara.id, universes.open.roomUrl)));
      expect(answers.every((answer) => answer.ok)).toBe(true);
      expect(await prisma.brickVisit.count({ where: { userId: sara.id } })).toBe(1);
      const other = await Promise.all([startVisit(brickId, sara.id, universes.open.roomUrl), startVisit(secondBrickId, sara.id, universes.open.roomUrl)]);
      expect(other.every((answer) => answer.ok)).toBe(true);
      expect(await prisma.brickVisit.count({ where: { userId: sara.id } })).toBe(1);
    });

    it('walks one Brick with a person at a time: bringing another swaps them', async () => {
      await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(brickId));
      await postVisit(call('POST', `/api/bricks/${secondBrickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(secondBrickId));
      expect((await visit(sara.id))?.botId).toBe(secondBrickId);
      expect(await prisma.brickVisit.count({ where: { userId: sara.id } })).toBe(1);
    });

    it('answers "not found" for a Brick that is not yours, a room bot and a Brick that waits deleted, and 401 or 403 with no account', async () => {
      as(omar);
      expect((await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(brickId))).status).toBe(404);
      expect((await getVisit(call('GET', `/api/bricks/${brickId}/visit`), ids(brickId))).status).toBe(404);
      expect((await deleteVisit(call('DELETE', `/api/bricks/${brickId}/visit`), ids(brickId))).status).toBe(404);
      as(sara);
      expect((await postVisit(call('POST', `/api/bricks/${roomBotId}/visit`, { roomUrl: universes.open.roomUrl }), ids(roomBotId))).status).toBe(404);
      await prisma.bot.update({ where: { id: secondBrickId }, data: { deletedAt: NOW, goneAt: new Date(NOW.getTime() + 86_400_000), enabledBeforeDelete: true, enabled: false } });
      expect((await postVisit(call('POST', `/api/bricks/${secondBrickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(secondBrickId))).status).toBe(404);
      await prisma.bot.update({ where: { id: secondBrickId }, data: { deletedAt: null, goneAt: null, enabledBeforeDelete: null, enabled: true } });
      as(null);
      expect((await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(brickId))).status).toBe(401);
      expect(await prisma.brickVisit.count({ where: { userId: omar.id } })).toBe(0);
    });

    it('does not bring a switched-off Brick along', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      const response = await postVisit(call('POST', `/api/bricks/${brickId}/visit`, { roomUrl: universes.open.roomUrl }), ids(brickId));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: 'off' });
    });
  });

  describe('what the bot server is given', () => {
    it('is the Brick beside its person in the room they are in, in the shape it knows a Brick in, with whose it walks beside', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const here = await feed(universes.open.roomUrl, [sara.uuid, omar.uuid]);
      expect(here).toHaveLength(1);
      expect(here[0]).toMatchObject({ botId: brickId, roomUrl: universes.open.roomUrl, enabled: true, voiceEnabled: false, brick: { ownerId: sara.id, deleted: false, visiting: { ownerUuid: sara.uuid } } });
      expect(here[0]).toHaveProperty('universeUrl');
    });

    it('follows its person from room to room and is not left behind: the visit is seen where the person is', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await feed(universes.open.otherRoomUrl, [sara.uuid])).toHaveLength(1);
      expect((await visit(sara.id))?.roomId).not.toBe(universes.open.roomId);
      // The room it left no longer has it: nobody there walks with it
      expect(await feed(universes.open.roomUrl, [omar.uuid])).toHaveLength(0);
    });

    it('brings nothing where the universe does not take visits, keeps the visit, and is back where visits are taken', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await feed(universes.closed.roomUrl, [sara.uuid])).toHaveLength(0);
      expect(await visitState(brickId, sara.id, universes.closed.roomUrl)).toMatchObject({ state: 'blocked', visiting: true });
      expect(await feed(universes.second.roomUrl, [sara.uuid])).toHaveLength(1);
    });

    it('keeps the visit alive while its person stays where visits are not taken, so it is there when they come back (Sentry on #927)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const before = new Date(Date.now() - 9 * MIN);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: before } });
      expect(await feed(universes.closed.roomUrl, [sara.uuid])).toHaveLength(0);
      const kept = await visit(sara.id);
      expect(kept!.seenAt.getTime()).toBeGreaterThan(before.getTime() + 8 * MIN);
      // Where it was last seen on a map that takes visits is kept, so nothing says it walks in the closed place
      expect(kept!.roomId).toBe(universes.open.roomId);
      expect(await whereIsBrick(brickId, universes.closed.roomUrl)).toBeNull();
      expect(await feed(universes.second.roomUrl, [sara.uuid])).toHaveLength(1);
    });

    it('says nothing of a visit for a Brick that is switched off, and has it again when it is switched back on (Sentry on #927)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await visitState(brickId, sara.id, universes.open.roomUrl)).toEqual({ state: 'none', place: 'open place' });
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: true } });
      expect(await visitState(brickId, sara.id, universes.open.roomUrl)).toMatchObject({ state: 'visiting' });
    });

    it('never names a place with a blank when the visit has no room left to name (Sentry on #927)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { roomId: null } });
      expect(await visitState(brickId, sara.id, null)).toEqual({ state: 'none', place: null });
    });

    it('never moves a visit into a room its person could not open (Sentry on #2023)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: false } });
      await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: false } });
      await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: false } });
      try {
        expect(await feed(universes.second.roomUrl, [sara.uuid])).toHaveLength(0);
        expect((await visit(sara.id))?.roomId).toBe(universes.open.roomId);
      } finally {
        await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: true } });
        await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: true } });
        await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: true } });
      }
      expect(await feed(universes.second.roomUrl, [sara.uuid])).toHaveLength(1);
    });

    it('asks who may open a room for everyone found in it at once, with the same answer as asking about each (Sentry on #927)', async () => {
      const everyone = [sara.id, omar.id, host.id, randomUUID()];
      const check = async () => {
        const place = (await placeOfRoomUrl(universes.second.roomUrl))!;
        const together = await whoMayReadRoomBots(place.room, everyone);
        for (const id of everyone) expect(together.has(id)).toBe(await mayReadRoomBots(place.room, id));
        return together;
      };
      await check();
      await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: false } });
      await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: false } });
      await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: false } });
      try {
        const closed = await check();
        // The universe's owner opens it; people who are not members do not, and nor does a person Orbit has no account for
        expect([...closed].sort()).toEqual([host.id]);
        const world = await prisma.world.findFirstOrThrow({ where: { universeId: universes.second.id } });
        await prisma.worldMember.create({ data: { worldId: world.id, userId: omar.id } });
        expect([...(await check())].sort()).toEqual([host.id, omar.id].sort());
      } finally {
        await prisma.worldMember.deleteMany({ where: { world: { universeId: universes.second.id } } });
        await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: true } });
        await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: true } });
        await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: true } });
      }
      expect((await whoMayReadRoomBots((await placeOfRoomUrl(universes.second.roomUrl))!.room, [])).size).toBe(0);
    });

    it('looks people up once for the whole room, never once for each (Sentry on #927)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await startVisit(secondBrickId, omar.id, universes.open.roomUrl).catch(() => undefined);
      const one = jest.spyOn(prisma.user, 'findUnique');
      const many = jest.spyOn(prisma.user, 'findMany');
      const memberOne = jest.spyOn(prisma.worldMember, 'findUnique');
      const memberMany = jest.spyOn(prisma.worldMember, 'findMany');
      try {
        await feed(universes.open.roomUrl, [sara.uuid, omar.uuid, host.uuid]);
        expect(one).not.toHaveBeenCalled();
        expect(memberOne).not.toHaveBeenCalled();
        expect(many.mock.calls.filter(([args]) => JSON.stringify(args).includes('"in"'))).toHaveLength(1);
        expect(memberMany).toHaveBeenCalledTimes(1);
      } finally {
        for (const spy of [one, many, memberOne, memberMany]) spy.mockRestore();
      }
    });

    it('stops bringing a Brick when its universe turns the switch off, and when the Brick is switched off or deleted', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(1);
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: false } });
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(0);
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: true } });
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(0);
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: true } });
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(1);
    });

    it('ends a visit nobody has seen for the time a super admin gave, and does not bring it back when its person turns up later', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const long = new Date(Date.now() - 11 * MIN);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: long } });
      expect(await visitState(brickId, sara.id, universes.open.roomUrl)).toMatchObject({ state: 'none' });
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(0);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await endStaleVisits()).toBeGreaterThanOrEqual(1);
      expect(await visit(sara.id)).toBeNull();
    });

    it('is cleared by the sweep the bot server already asks for', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: new Date(Date.now() - 60 * MIN) } });
      expect((await sweep(call('POST', '/api/bricks/sweep', undefined, service))).status).toBe(200);
      expect(await visit(sara.id)).toBeNull();
    });

    it('still answers with the Bricks it removed when clearing visits fails', async () => {
      const spy = jest.spyOn(prisma.brickVisit, 'deleteMany').mockRejectedValueOnce(new Error('database blinked'));
      try {
        const response = await sweep(call('POST', '/api/bricks/sweep', undefined, service));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ removed: expect.any(Array) });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('needs the bot server’s token and a well-formed body', async () => {
      expect((await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl: universes.open.roomUrl, people: [] }))).status).toBe(401);
      expect((await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl: 'nonsense' }, service))).status).toBe(400);
      expect(await feed('http://play.workadventure.localhost/@/nothing/here/at-all', [sara.uuid])).toEqual([]);
    });

    it('is not in the list of room bots a bot server reads, which stays as it is today', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      // The bot server has no session: it asks with the admin token
      as(null);
      const response = await getConfiguration(new NextRequest(`http://localhost/api/bots/configuration?roomUrl=${encodeURIComponent(universes.open.roomUrl)}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }));
      const body = await response.json();
      expect(response.status).toBe(200);
      const listed = (body as { botId: string }[]).map((bot) => bot.botId);
      expect(listed).toEqual([roomBotId]);
    });
  });

  describe('who may talk to a visiting Brick', () => {
    it('lets its owner do everything with it, where it visits and where visits are not taken', async () => {
      for (const action of ['chat', 'dm', 'summon', 'change', 'deleteOrSend'] as const) {
        expect(await chat(brickId, sara, action)).toMatchObject({ allowed: true });
      }
    });

    it('lets nobody else near it while it is not visiting anywhere: as before, a direct message and a chat are both refused', async () => {
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: false, code: 'not_allowed' });
      expect(await chat(brickId, omar, 'dm')).toMatchObject({ allowed: false, code: 'not_allowed' });
    });

    it('lets other people chat with it nearby and send it a message in the room it is in, by the roles of the place', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true, code: 'allowed' });
      expect(await chat(brickId, omar, 'dm')).toMatchObject({ allowed: true });
      // A guest is nobody a direct message can come from
      expect(await checkBotAccess({ botId: brickId, action: 'dm', person: { signedIn: false } })).toMatchObject({ allowed: false, code: 'sign_in_required' });
    });

    it('lets them do nothing else with it: nobody summons it, has it change things, or have it delete or send, a host and a stranger alike', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      for (const who of [omar, host]) {
        for (const action of ['summon', 'change', 'deleteOrSend'] as const) {
          expect(await chat(brickId, who, action, universes.open.roomUrl)).toMatchObject({ allowed: false });
        }
      }
      // The universe's owner is nobody's bot owner here: a chat is as for any member
      expect(await chat(brickId, host, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true });
    });

    it('is not reached by a caller that names no room (the files, artifacts and tools of a reply), but is in a direct message', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      expect(await chat(brickId, omar, 'chat')).toMatchObject({ allowed: false, code: 'not_allowed' });
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true });
      expect(await chat(brickId, omar, 'dm')).toMatchObject({ allowed: true });
      expect(await chat(brickId, sara, 'chat')).toMatchObject({ allowed: true });
    });

    it('is reached only from the room it is in, and only where the universe takes visits', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      expect(await chat(brickId, omar, 'chat', universes.open.otherRoomUrl)).toMatchObject({ allowed: false });
      expect(await chat(brickId, omar, 'chat', universes.second.roomUrl)).toMatchObject({ allowed: false });
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: false } });
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: false });
      expect(await chat(brickId, omar, 'dm')).toMatchObject({ allowed: false });
      // Still its owner’s in direct messages, wherever
      expect(await chat(brickId, sara, 'dm')).toMatchObject({ allowed: true });
    });

    it('ends when the visit ends, and never reaches a Brick that is off or waits deleted', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: false });
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: true } });
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true });
      await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: false });
    });

    it('leaves a room bot as it is: its own rules and roles still decide', async () => {
      expect(await chat(roomBotId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true });
      expect(await chat(roomBotId, host, 'summon', universes.open.roomUrl)).toMatchObject({ allowed: true });
    });
  });

  describe('who pays when other people talk to it', () => {
    const credentials = async (asker?: string) => aiCredentials(call('GET', `/api/bots/${brickId}/ai-credentials${asker ? `?asker=${encodeURIComponent(asker)}` : ''}`, undefined, service), ids(brickId));
    const onKey = () => prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });

    beforeEach(async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
    });

    it('1. on Universe AI, serves Universe AI to its owner and to anyone else, and each person’s own allowance counts', async () => {
      for (const asker of [undefined, sara.uuid, omar.uuid]) {
        const response = await credentials(asker);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ source: 'universe-ai', providerId: serverProviderId });
      }
    });

    it('2. on its owner’s key, answers its owner on that key, others on it where the owner lent it, and others on Universe AI where not', async () => {
      await onKey();
      const owner = await credentials(sara.uuid);
      expect(await owner.json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
      // Not lent: others are served Universe AI on their own allowance, never the owner's key. The Brick is NOT moved off its owner's key
      // Access does not refuse them for the key either (Sentry on #927): credentials decide who answers
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: true });
      const stoodIn = await credentials(omar.uuid);
      expect(stoodIn.status).toBe(200);
      expect(await stoodIn.json()).toMatchObject({ source: 'universe-ai', providerId: serverProviderId, standingInFor: keyId });
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: brickId } })).aiProviderRef).toBe(keyId);
      // Lent to this universe: others are served that key, with the models the lend allows
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: universes.open.id } });
      const lent = await credentials(omar.uuid);
      expect(lent.status).toBe(200);
      expect(await lent.json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
      // Lent to another universe only: still not here
      await prisma.aiKeyLend.deleteMany({ where: { providerId: keyId } });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: universes.second.id } });
      expect(await (await credentials(omar.uuid)).json()).toMatchObject({ source: 'universe-ai', standingInFor: keyId });
    });

    it('2b. refuses with the line only when nothing else can answer: Universe AI is not there to stand in', async () => {
      await onKey();
      await prisma.botsAiProvider.update({ where: { providerId: serverProviderId }, data: { enabled: false } });
      try {
        const refused = await credentials(omar.uuid);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: 'key_not_lent' });
        // Its owner is served their own key as always
        expect((await (await credentials(sara.uuid)).json()).source).toBe('own-key');
      } finally {
        await prisma.botsAiProvider.update({ where: { providerId: serverProviderId }, data: { enabled: true } });
      }
    });

    it('3. never runs on the key of the person chatting: the only key ever served is the Brick’s own, and the asker’s own key is never read', async () => {
      await prisma.botsAiProvider.create({ data: { providerId: `key-omar-${tag}`, name: 'Omar key', type: 'openai', enabled: true, ownerId: omar.id, model: 'omar-model' } });
      try {
        await prisma.aiKeyLend.create({ data: { providerId: `key-omar-${tag}`, universeId: universes.open.id } });
        for (const ref of [UNIVERSE_AI_REF, keyId]) {
          await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: ref } });
          await prisma.aiKeyLend.upsert({ where: { providerId_universeId: { providerId: keyId, universeId: universes.open.id } }, update: {}, create: { providerId: keyId, universeId: universes.open.id } });
          const body = await (await credentials(omar.uuid)).json();
          expect(body.providerId).not.toBe(`key-omar-${tag}`);
          expect(body.keyOwnerId ?? sara.id).toBe(sara.id);
        }
      } finally {
        await prisma.botsAiProvider.delete({ where: { providerId: `key-omar-${tag}` } });
      }
    });

    it('4. is not served to anyone but its owner while it is not visiting, and a Brick that is not a visitor answers its owner as it always did', async () => {
      await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
      expect((await credentials(omar.uuid)).status).toBe(404);
      expect((await credentials(sara.uuid)).status).toBe(200);
      expect((await credentials()).status).toBe(200);
      // The bot server that does not name an asker gets the answer it always got
      expect(await credentialsForBot(brickId)).toMatchObject({ status: 200 });
    });
  });

  describe('who the answer is for, so the bot server keeps the owner’s things out of it (audit on #2023)', () => {
    const credentials = async (asker?: string) => aiCredentials(call('GET', `/api/bots/${brickId}/ai-credentials${asker ? `?asker=${encodeURIComponent(asker)}` : ''}`, undefined, service), ids(brickId));
    const onKey = () => prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });

    it('flags every answer for someone who is not the owner, on every route, and never the owner’s', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      // Universe AI, the owner's key unlent (stood in for), the owner's key lent
      expect((await (await credentials(omar.uuid)).json()).forOthers).toBe(true);
      await onKey();
      expect(await (await credentials(omar.uuid)).json()).toMatchObject({ source: 'universe-ai', standingInFor: keyId, forOthers: true });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: universes.open.id } });
      expect(await (await credentials(omar.uuid)).json()).toMatchObject({ source: 'own-key', forOthers: true });
      // A person the bot server cannot name is nobody's owner
      expect(await (await credentials('unknown')).json()).toMatchObject({ forOthers: true });
      // Its owner is never flagged, by WorkAdventure id, email or Orbit id
      for (const asker of [sara.uuid, sara.email, sara.id]) {
        expect((await (await credentials(asker)).json()).forOthers).toBeUndefined();
      }
    });

    it('fails closed for a visiting Brick when nobody is named: never the owner’s key, and never refused', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await feed(universes.open.roomUrl, [sara.uuid]);
      await onKey();
      // The owner's key is not lent here: a call that names nobody is stood in for on Universe AI and flagged, like any stranger
      const unnamed = await credentials();
      expect(unnamed.status).toBe(200);
      expect(await unnamed.json()).toMatchObject({ source: 'universe-ai', standingInFor: keyId, forOthers: true });
      expect(await credentialsForBot(brickId)).toMatchObject({ status: 200, body: { source: 'universe-ai', forOthers: true } });
      // Naming its owner (by any of the three) is how the Brick's own calls get its key
      for (const owner of [sara.uuid, sara.email, sara.id]) {
        expect(await (await credentials(owner)).json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
      }
      // Not visiting anywhere: nobody to protect it from, so naming nobody is the Brick's own business, as it always was
      await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
      expect(await (await credentials()).json()).toMatchObject({ source: 'own-key', providerId: keyId });
      expect((await credentials(omar.uuid)).status).toBe(404);
    });

    it('answers nobody but its owner when the Brick is not visiting anywhere (a restart, a room that takes no visits, a visit that ran out)', async () => {
      await onKey();
      // Never visited
      expect((await credentials(omar.uuid)).status).toBe(404);
      expect((await credentials('unknown')).status).toBe(404);
      // A visit that has run out
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: new Date(Date.now() - 60 * MIN) } });
      expect((await credentials(omar.uuid)).status).toBe(404);
      // The universe it walked into stops taking visits
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: false } });
      try {
        expect((await credentials(omar.uuid)).status).toBe(404);
        // Its owner is served as always, on their own key
        expect(await (await credentials(sara.uuid)).json()).toMatchObject({ source: 'own-key', providerId: keyId });
      } finally {
        await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: true } });
      }
    });
  });

  describe('what keeps a visit alive, and what ends it at once (review on #927)', () => {
    const seenAt = async () => (await visit(sara.id))?.seenAt.getTime();

    it('is kept alive by the bot server seeing its owner, and by nothing else: people chatting with it never prolong it', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const earlier = new Date(Date.now() - 5 * MIN);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: earlier } });

      // Others chat with it, are served by it and are told where it is: its timer does not move
      await chat(brickId, omar, 'chat', universes.open.roomUrl);
      await credentialsForBot(brickId, { asker: omar.uuid });
      await whereIsBrick(brickId, universes.open.roomUrl);
      await visitState(brickId, sara.id, universes.open.roomUrl);
      expect(await seenAt()).toBe(earlier.getTime());
      // Someone else's name in the room's people list moves nothing of hers either
      await feed(universes.open.roomUrl, [omar.uuid]);
      expect(await seenAt()).toBe(earlier.getTime());

      // Its owner is seen with it, by the bot server: the timer starts again
      expect(await keepVisitAlive(brickId, sara.uuid, universes.open.roomUrl)).toBe(true);
      expect(await seenAt()).toBeGreaterThan(earlier.getTime() + 4 * MIN);
    });

    it('is never brought back once it has run out, by a sighting, by its owner’s sync or by a chat', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const long = new Date(Date.now() - 11 * MIN);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: long } });
      // Unusable before the sweep has run
      expect(await whereIsBrick(brickId, universes.open.roomUrl)).toBeNull();
      expect(await chat(brickId, omar, 'chat', universes.open.roomUrl)).toMatchObject({ allowed: false });
      expect(await visitState(brickId, sara.id, universes.open.roomUrl)).toMatchObject({ state: 'none' });
      // And not revived by anything
      expect(await keepVisitAlive(brickId, sara.uuid, universes.open.roomUrl)).toBe(false);
      expect(await feed(universes.open.roomUrl, [sara.uuid])).toHaveLength(0);
      expect(await seenAt()).toBe(long.getTime());
    });

    it('answers that the visit is over, at once and without waiting out the time, when it is ended, switched, switched off or deleted, or its place stops taking visits', async () => {
      const alive = () => keepVisitAlive(brickId, sara.uuid, universes.open.roomUrl);
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await alive()).toBe(true);
      // Someone else's Brick or name is not this owner's sighting
      expect(await keepVisitAlive(brickId, omar.uuid, universes.open.roomUrl)).toBe(false);
      expect(await keepVisitAlive(secondBrickId, sara.uuid, universes.open.roomUrl)).toBe(false);

      // The Brick is switched off, then on, then deleted
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await alive()).toBe(false);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: true } });
      expect(await alive()).toBe(true);
      await prisma.bot.update({ where: { id: brickId }, data: { deletedAt: NOW, goneAt: new Date(NOW.getTime() + 86_400_000), enabledBeforeDelete: true, enabled: false } });
      expect(await alive()).toBe(false);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      await prisma.bot.update({ where: { id: brickId }, data: { deletedAt: null, goneAt: null, enabledBeforeDelete: null, enabled: true } });

      // The universe turns the switch off
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: false } });
      expect(await alive()).toBe(false);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      await prisma.universe.update({ where: { id: universes.open.id }, data: { allowVisitingBricks: true } });
      expect(await alive()).toBe(true);

      // Switching to another Brick ends this one's visit; ending it ends it
      await startVisit(secondBrickId, sara.id, universes.open.roomUrl);
      expect(await alive()).toBe(false);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await whereIsBrick(secondBrickId, null)).not.toBeNull();
      await deleteVisit(call('DELETE', `/api/bricks/${secondBrickId}/visit`), ids(secondBrickId));
      expect(await whereIsBrick(secondBrickId, null)).toBeNull();
      expect(await keepVisitAlive(secondBrickId, sara.uuid, universes.open.roomUrl)).toBe(false);
    });

    it('ends for others at once when its owner may no longer open the room it is in (access revoked)', async () => {
      await startVisit(brickId, sara.id, universes.second.roomUrl);
      expect(await whereIsBrick(brickId, null)).not.toBeNull();
      await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: false } });
      await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: false } });
      await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: false } });
      try {
        expect(await whereIsBrick(brickId, null)).toBeNull();
        expect(await keepVisitAlive(brickId, sara.uuid, universes.second.roomUrl)).toBe(false);
      } finally {
        await prisma.universe.update({ where: { id: universes.second.id }, data: { isPublic: true } });
        await prisma.room.updateMany({ where: { world: { universeId: universes.second.id } }, data: { isPublic: true } });
        await prisma.world.updateMany({ where: { universeId: universes.second.id }, data: { isPublic: true } });
      }
      expect(await whereIsBrick(brickId, null)).not.toBeNull();
    });

    it('moves to another room only on a sighting newer than the move before it: a late sync from a room its person left moves nothing, refreshes nothing, brings nothing back', async () => {
      const T = Date.now() - 60_000;
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      // The first sync from room A names when the game saw Sara come in
      expect(await feed(universes.open.roomUrl, [sara.uuid], T)).toHaveLength(1);
      expect((await visit(sara.id))?.roomSince?.getTime()).toBe(T);
      // She walks on to room B: newer, so the visit goes with her
      expect(await feed(universes.second.roomUrl, [sara.uuid], T + 5_000)).toHaveLength(1);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.second.roomId });
      expect((await visit(sara.id))?.roomSince?.getTime()).toBe(T + 5_000);
      // A's sync arrives late, after B's: it moves nothing, brings no Brick to A and does not refresh the visit
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: new Date(Date.now() - 5 * MIN) } });
      const stamp = (await visit(sara.id))!.seenAt.getTime();
      for (const late of [T, T + 5_000]) {
        const answer = await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl: universes.open.roomUrl, people: [sara.uuid], enteredAt: late, clientId: CLIENT }, service));
        // 409, not an empty list: the bot server leaves the Brick it has standing in B as it is
        expect(answer.status).toBe(409);
      }
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.second.roomId });
      expect((await visit(sara.id))!.seenAt.getTime()).toBe(stamp);
      // Another sync from B is the same room: seen now, the Brick stays
      expect(await feed(universes.second.roomUrl, [sara.uuid], T + 5_000)).toHaveLength(1);
      expect((await visit(sara.id))!.seenAt.getTime()).toBeGreaterThan(stamp + 4 * MIN);
      // She walks back to A later: that is newer again, so it follows
      expect(await feed(universes.open.roomUrl, [sara.uuid], T + 9_000)).toHaveLength(1);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.open.roomId });
    });

    it('compares times only when the same page load said both: another device with an older clock still moves the visit (no clock of one device is held against another)', async () => {
      const T = Date.now() - 60_000;
      // The laptop's clock runs five minutes ahead: it brought the visit into room A at a time far in the future of the phone's
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await feed(universes.open.roomUrl, [sara.uuid], T + 300_000, 'page-laptop-0001')).toHaveLength(1);
      expect((await visit(sara.id))?.roomClient).toBe('page-laptop-0001');
      // She closes the laptop and walks into room B on her phone: its time is older than the laptop's, and it is a move all the same
      expect(await feed(universes.second.roomUrl, [sara.uuid], T, 'page-phone-00002')).toHaveLength(1);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.second.roomId, roomClient: 'page-phone-00002' });
      // The same phone's late sync from the first room is refused by its own clock; the same phone, newer, moves
      expect((await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl: universes.open.roomUrl, people: [sara.uuid], enteredAt: T - 1_000, clientId: 'page-phone-00002' }, service))).status).toBe(409);
      expect(await feed(universes.open.roomUrl, [sara.uuid], T + 1_000, 'page-phone-00002')).toHaveLength(1);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.open.roomId });
      // A game that names no page load, or none stored, is a move, as it was before
      expect(await feed(universes.second.roomUrl, [sara.uuid], T - 500_000, null)).toHaveLength(1);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.second.roomId, roomClient: null });
      expect(await feed(universes.open.roomUrl, [sara.uuid], T - 600_000, 'page-phone-00002')).toHaveLength(1);
    });

    it('treats a sync that names no time as now (an older game), and never takes a time in the future', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await feed(universes.second.roomUrl, [sara.uuid])).toHaveLength(1);
      const first = (await visit(sara.id))!;
      expect(first.roomId).toBe(universes.second.roomId);
      expect(first.roomSince!.getTime()).toBeGreaterThan(Date.now() - 10_000);
      // A game whose clock runs ahead cannot pin the visit in a room: the time is held to the moment Orbit heard it
      expect(await feed(universes.open.roomUrl, [sara.uuid], Date.now() + 3_600_000)).toHaveLength(1);
      const second = (await visit(sara.id))!;
      expect(second.roomId).toBe(universes.open.roomId);
      expect(second.roomSince!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('is seen only in the room the visit is in, which must take visits and be one its owner may open', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      expect(await keepVisitAlive(brickId, sara.uuid, universes.closed.roomUrl)).toBe(false);
      expect(await keepVisitAlive(brickId, sara.uuid, 'nonsense')).toBe(false);
      expect(await keepVisitAlive(brickId, sara.uuid, universes.open.otherRoomUrl)).toBe(true);
    });

    it('is not pulled back by a late sighting from a room its owner has already left: the visit stays where the owner is, and is not ended', async () => {
      // The owner is in room A; A's sighting is in flight; the owner walks on to B (their own sync moves the visit)
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await startVisit(brickId, sara.id, universes.second.roomUrl);
      const before = await visit(sara.id);
      expect(before?.roomId).toBe(universes.second.roomId);
      // A's sighting lands now: it neither moves the visit back nor refreshes it, and it does not end it either
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: new Date(Date.now() - 5 * MIN) } });
      const stamp = (await visit(sara.id))!.seenAt.getTime();
      expect(await keepVisitAlive(brickId, sara.uuid, universes.open.roomUrl)).toBe(true);
      expect(await visit(sara.id)).toMatchObject({ roomId: universes.second.roomId });
      expect((await visit(sara.id))!.seenAt.getTime()).toBe(stamp);
      // People in B still reach it, those in A do not
      expect(await whereIsBrick(brickId, universes.second.roomUrl)).not.toBeNull();
      expect(await whereIsBrick(brickId, universes.open.roomUrl)).toBeNull();
      // B's own sighting is the one that counts
      expect(await keepVisitAlive(brickId, sara.uuid, universes.second.roomUrl)).toBe(true);
      expect((await visit(sara.id))!.seenAt.getTime()).toBeGreaterThan(stamp + 4 * MIN);
    });

    it('is asked for by the bot server only, with a well-formed body', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const body = { botId: brickId, ownerUuid: sara.uuid, roomUrl: universes.open.roomUrl };
      expect((await seenFeed(call('POST', '/api/brick-visits/seen', body))).status).toBe(401);
      expect((await seenFeed(call('POST', '/api/brick-visits/seen', { botId: brickId }, service))).status).toBe(400);
      expect((await seenFeed(call('POST', '/api/brick-visits/seen', { ...body, extra: 1 }, service))).status).toBe(400);
      const alive = await seenFeed(call('POST', '/api/brick-visits/seen', body, service));
      expect(alive.status).toBe(200);
      expect(await alive.json()).toEqual({ alive: true });
      await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
      expect(await (await seenFeed(call('POST', '/api/brick-visits/seen', body, service))).json()).toEqual({ alive: false });
    });
  });

  describe('what a visit does not touch', () => {
    it('keeps today’s room bots out of it: a room bot cannot be brought along and has no visit', async () => {
      expect(await startVisit(roomBotId, sara.id, universes.open.roomUrl)).toEqual({ ok: false, reason: 'not_found' });
      expect(await prisma.brickVisit.count({ where: { botId: roomBotId } })).toBe(0);
    });

    it('goes with the Brick, the person or the room it was last seen in, and deletes nothing of the owner’s', async () => {
      const leaving = await prisma.user.create({ data: { uuid: `leaving-${tag}`, name: 'leaving' } });
      const theirs = await createBrick({ ownerId: leaving.id, name: 'Brick' });
      await startVisit(theirs.id, leaving.id, universes.open.roomUrl);
      await prisma.user.delete({ where: { id: leaving.id } });
      expect(await prisma.brickVisit.count({ where: { botId: theirs.id } })).toBe(0);

      await startVisit(brickId, sara.id, universes.open.roomUrl);
      const world = await prisma.world.findFirstOrThrow({ where: { universeId: universes.open.id } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'temp', name: 'Temp' } });
      await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl: `${BASE}/@/open-${tag}/hq/temp`, people: [sara.uuid] }, service));
      expect((await visit(sara.id))?.roomId).toBe(room.id);
      await prisma.room.delete({ where: { id: room.id } });
      expect(await visit(sara.id)).toMatchObject({ botId: brickId, roomId: null });
      expect(await prisma.bot.findUnique({ where: { id: brickId } })).not.toBeNull();
    });
  });
});
