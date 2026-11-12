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
import { endStaleVisits, startVisit, visitState, whereIsBrick } from '@/lib/brick-visit';
import { GET as getVisit, POST as postVisit, DELETE as deleteVisit } from '@/app/api/bricks/[id]/visit/route';
import { POST as roomFeed } from '@/app/api/brick-visits/room/route';
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
const feed = async (roomUrl: string, people: string[]) => {
  const response = await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl, people }, service));
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

    it('never names a place with a blank when the visit has no room left to name (Sentry on #927)', async () => {
      await startVisit(brickId, sara.id, universes.open.roomUrl);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { roomId: null } });
      expect(await visitState(brickId, sara.id, null)).toEqual({ state: 'none', place: null });
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

    it('2. on its owner’s key, answers its owner on that key and others only where the owner lent it', async () => {
      await onKey();
      const owner = await credentials(sara.uuid);
      expect(await owner.json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
      // Not lent: others are refused with a line that says why. The Brick is NOT moved off its owner's key
      const refused = await credentials(omar.uuid);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'key_not_lent' });
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: brickId } })).aiProviderRef).toBe(keyId);
      // Lent to this universe: others are served that key, with the models the lend allows
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: universes.open.id } });
      const lent = await credentials(omar.uuid);
      expect(lent.status).toBe(200);
      expect(await lent.json()).toMatchObject({ source: 'own-key', providerId: keyId, keyOwnerId: sara.id });
      // Lent to another universe only: still not here
      await prisma.aiKeyLend.deleteMany({ where: { providerId: keyId } });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: universes.second.id } });
      expect((await credentials(omar.uuid)).status).toBe(403);
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
