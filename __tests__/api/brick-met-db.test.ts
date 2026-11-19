/**
 * Keeping an allowed direct message after a visit ends (game #2005, "People who met"; audit F05, A25) against a real database.
 *
 * Khalid, 5 Nov: "regarding a bot without a room, if i met them and i have dmd them and permissions allow dms then i should be able
 * to keep dming until a person changes permission". So whether someone may message a Brick that is not theirs depends on what they
 * are allowed, never on where the Brick is: meet it, message it, the visit ends, and the message still goes; the owner taking them
 * off, a ban, losing access to the place, or the Brick going off or being deleted stops it. Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest -i __tests__/api/brick-met-db.test.ts
 *
 * (One at a time, as the other database tests: they share a database and one default Universe AI provider.)
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
import { endVisit, startVisit, whereIsBrick } from '@/lib/brick-visit';
import { listMet, revokeMet } from '@/lib/brick-met';
import { placeBrick } from '@/lib/brick-home';
import { POST as access } from '@/app/api/bots/[id]/access/route';
import { GET as getMet, POST as postMet, DELETE as deleteMet } from '@/app/api/bricks/[id]/met/route';
import { POST as roomFeed } from '@/app/api/brick-visits/room/route';
import { POST as sweep } from '@/app/api/bricks/sweep/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const BASE = 'http://play.workadventure.localhost';
const session = getSessionUser as jest.Mock;
const DAY = 24 * 60 * 60 * 1000;

type Person = { id: string; uuid: string; email: string };
let sara: Person = { id: '', uuid: '', email: '' };
let omar: Person = { id: '', uuid: '', email: '' };
let lina: Person = { id: '', uuid: '', email: '' };
let host: Person = { id: '', uuid: '', email: '' };
const places: Record<'open' | 'other', { id: string; worldId: string; roomId: string; roomUrl: string }> = {
  open: { id: '', worldId: '', roomId: '', roomUrl: '' },
  other: { id: '', worldId: '', roomId: '', roomUrl: '' },
};
let brickId = '';
let roomBotId = '';
let serverProviderId = '';
const keyId = `key-${tag}`;
const tokensBefore = { service: process.env.BOT_SERVICE_TOKEN };

const as = (user: { id: string; email: string } | null) => session.mockResolvedValue(user ? { id: user.id, email: user.email, name: 'x', isSuperAdmin: false } : null);
const ids = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const service = { Authorization: `Bearer ${SERVICE_TOKEN}` };
const ask = (botId: string, user: { email: string }, action: 'chat' | 'dm' | 'call' | 'summon' | 'change' | 'deleteOrSend', roomUrl?: string) =>
  checkBotAccess({ botId, action, roomUrl: roomUrl ?? null, person: { signedIn: true, identifier: user.email } });
const dm = (user: { email: string }) => ask(brickId, user, 'dm');
const feed = async (roomUrl: string, people: string[]) => {
  const response = await roomFeed(call('POST', '/api/brick-visits/room', { roomUrl, people }, service));
  expect(response.status).toBe(200);
};
const met = (userId: string) => prisma.brickMet.findUnique({ where: { botId_userId: { botId: brickId, userId } } });
const credentials = async (asker?: string) =>
  credentialsForBot(brickId, asker ? { asker } : {});

/** Sara walks her Brick into the room, and Omar chats with it there. */
const meet = async (user: Person = omar, roomUrl = places.open.roomUrl) => {
  await startVisit(brickId, sara.id, roomUrl);
  await feed(roomUrl, [sara.uuid]);
  expect(await ask(brickId, user, 'chat', roomUrl)).toMatchObject({ allowed: true });
};
/** The visit ends: the Brick goes home to its owner, as it does when she ends it or leaves Universe. */
const endTheVisit = async () => {
  expect(await endVisit(brickId, sara.id)).toBe(true);
  expect(await whereIsBrick(brickId, null)).toBeNull();
};

run('keeping an allowed direct message after a visit ends, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    const person = async (name: string): Promise<Person> => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
      return { id: user.id, uuid: user.uuid, email: user.email! };
    };
    sara = await person('sara');
    omar = await person('omar');
    lina = await person('lina');
    host = await person('host');
    const place = async (key: 'open' | 'other') => {
      const universe = await prisma.universe.create({ data: { slug: `${key}-${tag}`, name: `${key} place`, ownerId: host.id, allowVisitingBricks: true } });
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      places[key] = { id: universe.id, worldId: world.id, roomId: room.id, roomUrl: `${BASE}/@/${universe.slug}/hq/lobby` };
    };
    await place('open');
    await place('other');
    serverProviderId = `srv-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId: serverProviderId, name: `Server ${tag}`, type: 'openai', enabled: true, isDefault: true, model: 'server-model' } });
    await prisma.botsAiProvider.create({ data: { providerId: keyId, name: 'Sara key', type: 'openai', enabled: true, ownerId: sara.id, model: 'key-model' } });
    brickId = (await createBrick({ ownerId: sara.id, name: 'Melody' })).id;
    roomBotId = (await prisma.bot.create({ data: { roomId: places.open.roomId, name: 'Nora', createdById: host.id, behaviorConfig: {} } })).id;
  });

  afterAll(async () => {
    await prisma.ban.deleteMany({ where: { userId: { in: [omar.id, lina.id] } } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId: { in: [serverProviderId, keyId] } } });
    await prisma.universe.deleteMany({ where: { id: { in: Object.values(places).map((one) => one.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id, lina.id, host.id] } } });
    if (tokensBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = tokensBefore.service;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brickMet.deleteMany({ where: { botId: brickId } });
    await prisma.brickVisit.deleteMany({ where: { userId: sara.id } });
    await prisma.brickHome.deleteMany({ where: { botId: brickId } });
    await prisma.ban.deleteMany({ where: { userId: { in: [omar.id, lina.id] } } });
    await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: UNIVERSE_AI_REF, aiModel: null, enabled: true, deletedAt: null, goneAt: null, enabledBeforeDelete: null } });
    await prisma.aiKeyLend.deleteMany({ where: { providerId: keyId } });
    await prisma.universe.updateMany({ where: { id: { in: Object.values(places).map((one) => one.id) } }, data: { allowVisitingBricks: true, isPublic: true } });
    await prisma.world.updateMany({ where: { universeId: { in: Object.values(places).map((one) => one.id) } }, data: { isPublic: true } });
    await prisma.room.updateMany({ where: { world: { universeId: { in: Object.values(places).map((one) => one.id) } } }, data: { isPublic: true } });
    await prisma.worldMember.deleteMany({ where: { userId: { in: [sara.id, omar.id, lina.id] } } });
    as(sara);
  });

  describe('A25: meet it, message it, the visit ends, carry on', () => {
    it('keeps a direct message going after the visit ends, for someone who met it nearby and wrote to it', async () => {
      await meet();
      expect(await dm(omar)).toMatchObject({ allowed: true });
      expect((await met(omar.id))?.dmAt).not.toBeNull();
      await endTheVisit();
      // Not anywhere other people can reach it, yet the conversation they started is still theirs to continue
      expect(await dm(omar)).toMatchObject({ allowed: true, code: 'allowed' });
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('keeps it for someone who only met it nearby and has not written yet: their first message can come after the visit', async () => {
      await meet();
      expect((await met(omar.id))?.dmAt).toBeNull();
      await endTheVisit();
      expect(await dm(omar)).toMatchObject({ allowed: true });
      // Writing to it is what makes it last: from then on only a decision ends it
      expect((await met(omar.id))?.dmAt).not.toBeNull();
    });

    it('keeps nothing for someone it never answered: before, during or after a visit, only a direct message to a Brick that is there is allowed', async () => {
      await meet(omar);
      await endTheVisit();
      expect(await dm(omar)).toMatchObject({ allowed: true });
      expect(await dm(lina)).toMatchObject({ allowed: false, code: 'not_allowed', reason: "You can't message Melody now." });
      // While it is there, a direct message is allowed by the roles of the place, and that is a meeting
      await startVisit(brickId, sara.id, places.open.roomUrl);
      await feed(places.open.roomUrl, [sara.uuid]);
      expect(await dm(lina)).toMatchObject({ allowed: true });
      await endTheVisit();
      expect(await dm(lina)).toMatchObject({ allowed: true });
    });

    it('works from any room and through the bot server’s own route, with the same answer', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      const response = await access(call('POST', `/api/bots/${brickId}/access`, { action: 'dm', roomUrl: places.other.roomUrl, person: { signedIn: true, identifier: omar.email } }, service), ids(brickId));
      expect(await response.json()).toMatchObject({ allowed: true, code: 'allowed' });
    });

    it('does not turn a direct message into nearby chat, a call or anything else: only direct messages outlive the visit', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      for (const action of ['chat', 'call', 'summon', 'change', 'deleteOrSend'] as const) {
        expect(await ask(brickId, omar, action, places.open.roomUrl)).toMatchObject({ allowed: false });
      }
    });

    it('a guest cannot message it, met or not, and a person who is not its owner never becomes its owner', async () => {
      await meet();
      await endTheVisit();
      expect(await checkBotAccess({ botId: brickId, action: 'dm', person: { signedIn: false } })).toMatchObject({ allowed: false, code: 'sign_in_required' });
      expect(await ask(brickId, omar, 'summon')).toMatchObject({ allowed: false });
      expect(await ask(brickId, sara, 'deleteOrSend')).toMatchObject({ allowed: true });
    });

    it('is recorded for the Brick, never for a room bot, and never for its owner', async () => {
      expect(await ask(roomBotId, omar, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      expect(await ask(brickId, sara, 'chat')).toMatchObject({ allowed: true });
      await meet();
      expect(await prisma.brickMet.count({ where: { botId: roomBotId } })).toBe(0);
      expect(await met(sara.id)).toBeNull();
      expect(await met(omar.id)).not.toBeNull();
    });

    it('is one row for the person however often it answers them, and a busy room does not rewrite it on every message', async () => {
      await meet();
      const first = await met(omar.id);
      for (let i = 0; i < 5; i++) expect(await ask(brickId, omar, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      const after = await met(omar.id);
      expect(await prisma.brickMet.count({ where: { botId: brickId, userId: omar.id } })).toBe(1);
      expect(after?.lastMetAt?.getTime()).toBe(first?.lastMetAt?.getTime());
    });
  });

  describe('where it is never decides', () => {
    it('a Brick with no home: the visit was its only place, and it is gone', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      expect(await prisma.brickHome.count({ where: { botId: brickId } })).toBe(0);
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('a Brick that had a home, taken out of its room: the conversation outlives the home as it does a visit', async () => {
      await prisma.worldMember.create({ data: { userId: sara.id, worldId: places.open.worldId, tags: ['admin'] } });
      expect(await placeBrick({ brickId, ownerId: sara.id, roomUrl: places.open.roomUrl })).toMatchObject({ ok: true });
      expect(await ask(brickId, omar, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      await prisma.brickHome.deleteMany({ where: { botId: brickId } });
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('a change of universe: it walks on, or stops being taken in the universe it was met in, and the conversation holds', async () => {
      await meet();
      await dm(omar);
      // It walks into another universe: still the same conversation, and the meeting there is kept too
      await startVisit(brickId, sara.id, places.other.roomUrl);
      await feed(places.other.roomUrl, [sara.uuid]);
      expect(await dm(omar)).toMatchObject({ allowed: true });
      // The universe it was met in stops taking visiting Bricks: that is about visits, not a decision about a message
      await endTheVisit();
      await prisma.universe.update({ where: { id: places.open.id }, data: { allowVisitingBricks: false } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('meeting it in a second universe moves where it was met, so that universe’s roles and bans apply from then on', async () => {
      await meet();
      expect((await met(omar.id))?.roomId).toBe(places.open.roomId);
      await endTheVisit();
      await meet(omar, places.other.roomUrl);
      expect((await met(omar.id))?.roomId).toBe(places.other.roomId);
    });

    it('its owner leaving the place it was met in: the owner can no longer open the room, nobody there reaches the Brick, the conversation holds', async () => {
      await meet();
      await dm(omar);
      // The universe goes private and Sara is not a member; Omar, who still belongs, can still open it
      const world = await prisma.world.findUniqueOrThrow({ where: { id: places.open.worldId } });
      await prisma.worldMember.create({ data: { userId: omar.id, worldId: world.id, tags: ['member'] } });
      await prisma.universe.update({ where: { id: places.open.id }, data: { isPublic: false } });
      await prisma.world.update({ where: { id: world.id }, data: { isPublic: false } });
      await prisma.room.update({ where: { id: places.open.roomId }, data: { isPublic: false } });
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await ask(brickId, omar, 'chat', places.open.roomUrl)).toMatchObject({ allowed: false });
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('the room it was met in being deleted: no place is left to ask, so it holds, and a ban from everywhere still stops it', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      await prisma.room.delete({ where: { id: places.open.roomId } });
      try {
        expect((await met(omar.id))?.roomId).toBeNull();
        expect(await dm(omar)).toMatchObject({ allowed: true });
        await prisma.ban.create({ data: { userId: omar.id, reason: 'everywhere' } });
        expect(await dm(omar)).toMatchObject({ allowed: false, code: 'banned' });
      } finally {
        const room = await prisma.room.create({ data: { worldId: places.open.worldId, slug: 'lobby', name: 'Lobby' } });
        places.open.roomId = room.id;
      }
    });
  });

  describe('what ends it: a decision, and nothing else', () => {
    it('A25: the owner takes the person off, and the very next message is refused, with the visit over or still going', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      expect(await dm(omar)).toMatchObject({ allowed: true });
      as(sara);
      const off = await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId));
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ takenOff: 1 });
      expect(await dm(omar)).toMatchObject({ allowed: false, code: 'not_allowed', reason: "You can't message Melody now." });
      // Asked twice, the same
      expect(await (await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId))).json()).toEqual({ takenOff: 1 });
      // Meeting it again nearby does not undo the owner's decision about messages; the roles still decide nearby chat
      await startVisit(brickId, sara.id, places.open.roomUrl);
      await feed(places.open.roomUrl, [sara.uuid]);
      expect(await ask(brickId, omar, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      await endTheVisit();
      expect(await dm(omar)).toMatchObject({ allowed: false });
    });

    it('the owner can let them back, and only someone who met it gets back what they had', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId));
      expect(await dm(omar)).toMatchObject({ allowed: false });
      const back = await postMet(call('POST', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId));
      expect(await back.json()).toEqual({ allowed: true });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      // Nothing to let back for someone who was never taken off
      expect(await (await postMet(call('POST', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId))).json()).toEqual({ allowed: false });
      // Someone taken off before they ever met it: letting them back gives them nothing, they still have to meet it
      await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, { personId: lina.id }), ids(brickId));
      await postMet(call('POST', `/api/bricks/${brickId}/met`, { personId: lina.id }), ids(brickId));
      expect(await dm(lina)).toMatchObject({ allowed: false });
    });

    it('takes everyone off when no body is sent or it is empty, one person when named, and refuses a body that is not an object, never reading it as "everyone"', async () => {
      await meet(omar);
      expect(await ask(brickId, lina, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      await endTheVisit();
      const raw = (body: string | undefined) =>
        deleteMet(new NextRequest(`http://localhost/api/bricks/${brickId}/met`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) }), ids(brickId));
      // Not valid JSON, or not an object: refused, and nobody is taken off
      for (const bad of ['{"personId":', 'oops', 'null', '[]', '"all"', '{"person":"x"}']) {
        const refused = await raw(bad);
        expect(refused.status).toBe(400);
      }
      expect(await dm(omar)).toMatchObject({ allowed: true });
      expect(await dm(lina)).toMatchObject({ allowed: true });
      // One named
      expect(await (await raw('{"personId":"' + omar.id + '"}')).json()).toEqual({ takenOff: 1 });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      expect(await dm(lina)).toMatchObject({ allowed: true });
      // No body at all: that is what the request says (everyone still on it: Lina; Omar was already off)
      expect(await (await raw(undefined)).json()).toEqual({ takenOff: 1 });
      expect(await dm(lina)).toMatchObject({ allowed: false });
    });

    it('takes everyone off in one decision, and lists who may still write, by name', async () => {
      await meet(omar);
      await dm(omar);
      expect(await ask(brickId, lina, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      const listed = await (await getMet(call('GET', `/api/bricks/${brickId}/met`), ids(brickId))).json();
      expect(listed.people.map((p: { name: string }) => p.name).sort()).toEqual(['lina', 'omar']);
      expect(listed.people.find((p: { name: string }) => p.name === 'omar').wrote).toBe(true);
      expect(listed.people.find((p: { name: string }) => p.name === 'lina').wrote).toBe(false);
      await endTheVisit();
      expect(await (await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, {}), ids(brickId))).json()).toEqual({ takenOff: 2 });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      expect(await dm(lina)).toMatchObject({ allowed: false });
      expect((await (await getMet(call('GET', `/api/bricks/${brickId}/met`), ids(brickId))).json()).people).toEqual([]);
    });

    it('only its owner may read or change who met it: anyone else, a super admin included, hears "not found"', async () => {
      await meet();
      for (const who of [omar, host]) {
        as(who);
        expect((await getMet(call('GET', `/api/bricks/${brickId}/met`), ids(brickId))).status).toBe(404);
        expect((await deleteMet(call('DELETE', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId))).status).toBe(404);
        expect((await postMet(call('POST', `/api/bricks/${brickId}/met`, { personId: omar.id }), ids(brickId))).status).toBe(404);
      }
      as(null);
      expect((await getMet(call('GET', `/api/bricks/${brickId}/met`), ids(brickId))).status).toBe(401);
      expect(await revokeMet(brickId, omar.id, omar.id)).toBeNull();
      expect(await listMet(brickId, host.id)).toBeNull();
      // A room bot has no one who "met" it: it has its own rules
      as(sara);
      expect((await getMet(call('GET', `/api/bricks/${roomBotId}/met`), ids(roomBotId))).status).toBe(404);
      // The owner cannot take themselves off
      expect(await revokeMet(brickId, sara.id, sara.id)).toBe(0);
      expect(await dm(sara)).toMatchObject({ allowed: true });
      expect((await met(omar.id))?.revokedAt).toBeNull();
    });

    it('a banned requester is refused where they were banned, however they met it, and is let back when the ban is lifted', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      const ban = await prisma.ban.create({ data: { userId: omar.id, worldId: places.open.worldId, universeId: places.open.id, reason: 'x' } });
      expect(await dm(omar)).toMatchObject({ allowed: false, code: 'banned' });
      // A ban from the other universe says nothing about this one
      await prisma.ban.update({ where: { id: ban.id }, data: { worldId: places.other.worldId, universeId: places.other.id } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      await prisma.ban.update({ where: { id: ban.id }, data: { worldId: places.open.worldId, universeId: places.open.id } });
      expect(await dm(omar)).toMatchObject({ allowed: false, code: 'banned' });
      // Lifted, or run out: the conversation was never ended, so it carries on
      await prisma.ban.update({ where: { id: ban.id }, data: { isActive: false, liftedAt: new Date() } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      await prisma.ban.update({ where: { id: ban.id }, data: { isActive: true, liftedAt: null, expiresAt: new Date(Date.now() - 1000) } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      // And a ban stops them meeting it too
      await prisma.ban.update({ where: { id: ban.id }, data: { expiresAt: null } });
      expect(await dm(omar)).toMatchObject({ allowed: false });
    });

    it('losing access to the place it was met in refuses with the host’s line, and gaining it back restores it', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      await prisma.universe.update({ where: { id: places.open.id }, data: { isPublic: false } });
      await prisma.world.update({ where: { id: places.open.worldId }, data: { isPublic: false } });
      await prisma.room.update({ where: { id: places.open.roomId }, data: { isPublic: false } });
      expect(await dm(omar)).toMatchObject({ allowed: false, code: 'no_room_access' });
      await prisma.worldMember.create({ data: { userId: omar.id, worldId: places.open.worldId, tags: ['member'] } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('the Brick switched off or deleted is nobody’s to write to, and is again when it is back; a deleted one waits for Undo', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: false } });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      await prisma.bot.update({ where: { id: brickId }, data: { enabled: true } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      const now = new Date();
      await prisma.bot.update({ where: { id: brickId }, data: { deletedAt: now, goneAt: new Date(now.getTime() + DAY), enabled: false, enabledBeforeDelete: true } });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      await prisma.bot.update({ where: { id: brickId }, data: { deletedAt: null, goneAt: null, enabledBeforeDelete: null, enabled: true } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
    });

    it('someone who only met it, and never wrote, can start a message for the days Limits give and not after; once they have written, never time', async () => {
      await meet(omar);
      expect(await ask(brickId, lina, 'chat', places.open.roomUrl)).toMatchObject({ allowed: true });
      await endTheVisit();
      const old = new Date(Date.now() - 40 * DAY);
      await prisma.brickMet.updateMany({ where: { botId: brickId }, data: { lastMetAt: old, metAt: old } });
      expect(await dm(omar)).toMatchObject({ allowed: false });
      // Omar had not written: he is gone. Meet it again, write once, and it lasts however long ago
      await meet(omar);
      expect(await dm(omar)).toMatchObject({ allowed: true });
      await endTheVisit();
      const longAgo = new Date(Date.now() - 400 * DAY);
      await prisma.brickMet.updateMany({ where: { botId: brickId, userId: omar.id }, data: { lastMetAt: longAgo, metAt: longAgo, dmAt: longAgo } });
      expect(await dm(omar)).toMatchObject({ allowed: true });
      // Lina met it and never wrote: she expired
      expect(await dm(lina)).toMatchObject({ allowed: false });
      // Within the days, she can
      await prisma.brickMet.update({ where: { botId_userId: { botId: brickId, userId: lina.id } }, data: { lastMetAt: new Date(Date.now() - 20 * DAY) } });
      expect(await dm(lina)).toMatchObject({ allowed: true });
    });

    it('is never ended by a visit being swept, ended, expiring or swapped for another Brick', async () => {
      await meet();
      await dm(omar);
      await prisma.brickVisit.update({ where: { userId: sara.id }, data: { seenAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const swept = await sweep(call('POST', '/api/bricks/sweep', {}, service));
      expect(swept.status).toBe(200);
      expect(await whereIsBrick(brickId, null)).toBeNull();
      expect(await dm(omar)).toMatchObject({ allowed: true });
      expect(await met(omar.id)).not.toBeNull();
    });
  });

  describe('who answers it afterwards: nothing of its owner’s, and never the asker’s own key', () => {
    it('serves someone who met it on what it runs on for others, and nobody else: never the owner’s key unless it was lent to the universe they met it in', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });
      await meet();
      await dm(omar);
      await endTheVisit();
      // Not lent to where they met it: Universe AI stands in, as it did while it was there
      const stoodIn = await credentials(omar.uuid);
      expect(stoodIn).toMatchObject({ status: 200, body: { source: 'universe-ai', standingInFor: keyId, forOthers: true } });
      // Lent there: the owner's key serves them, as it did
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: places.open.id } });
      expect(await credentials(omar.uuid)).toMatchObject({ status: 200, body: { source: 'own-key', providerId: keyId, forOthers: true } });
      // Its owner is served as always
      expect(await credentials(sara.uuid)).toMatchObject({ status: 200, body: { source: 'own-key', providerId: keyId } });
      expect((await credentials(sara.uuid)) as { body: { forOthers?: boolean } }).not.toMatchObject({ body: { forOthers: true } });
    });

    it('is not served to someone who never met it or who was taken off, whatever room is named; someone who met it is served the same with or without one', async () => {
      await meet();
      await dm(omar);
      await endTheVisit();
      expect((await credentials(lina.uuid)).status).toBe(404);
      expect((await credentials('unknown')).status).toBe(404);
      expect(await credentialsForBot(brickId, { asker: lina.uuid, roomUrl: places.other.roomUrl })).toMatchObject({ status: 404 });
      // The room the caller names changes nothing for a direct message (Sentry on #993): the same answer as access gives
      expect(await credentialsForBot(brickId, { asker: omar.uuid, roomUrl: places.other.roomUrl })).toMatchObject({ status: 200, body: { forOthers: true } });
      expect(await credentials(omar.uuid)).toMatchObject({ status: 200 });
      await revokeMet(brickId, sara.id, omar.id);
      expect((await credentials(omar.uuid)).status).toBe(404);
    });

    it('serves someone whose room is gone on Universe AI, never on a lend', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId } });
      await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId: places.open.id } });
      await meet();
      await dm(omar);
      await endTheVisit();
      await prisma.brickMet.update({ where: { botId_userId: { botId: brickId, userId: omar.id } }, data: { roomId: null } });
      expect(await credentials(omar.uuid)).toMatchObject({ status: 200, body: { source: 'universe-ai', standingInFor: keyId } });
    });
  });
});
