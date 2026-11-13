/**
 * Lending an app to a universe, and a universe's own apps (game #2001 step 7, the approved mock), against a real database. Runs
 * only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/app-sharing-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  checkOutboundUrl: jest.fn(async () => ({ allowed: true })),
}));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { encryptApiKey } from '@/lib/encryption';
import { managerCandidates } from '@/lib/app-sharing';
import { createConnection, grantToBrick, markConnectionReconnected, checkAppUse } from '@/lib/app-connections';
import { GET as getApp } from '@/app/api/me/apps/[connectionId]/route';
import { POST as lend } from '@/app/api/me/apps/[connectionId]/lends/route';
import { PATCH as changeLendRoute, DELETE as takeBackRoute } from '@/app/api/me/apps/[connectionId]/lends/[universeId]/route';
import { GET as myUniverses } from '@/app/api/me/universes/route';
import { GET as teamList, POST as teamAdd } from '@/app/api/me/universes/[universeId]/apps/route';
import { GET as teamGet, DELETE as teamDisconnect } from '@/app/api/me/team-apps/[connectionId]/route';
import { POST as addManagerRoute } from '@/app/api/me/team-apps/[connectionId]/managers/route';
import { DELETE as removeManagerRoute } from '@/app/api/me/team-apps/[connectionId]/managers/[personId]/route';
import { GET as available, POST as letBotUse } from '@/app/api/bots/[id]/apps/available/route';
import { POST as useCheck } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/route';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { GET as signInStart } from '@/app/api/me/apps/[connectionId]/sign-in/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const LINK = 'https://tavily.example.com/mcp';

const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = ''; // owns universe A, lends Tavily
let omar = ''; // manages bots in A (admin tag), a named manager
let nora = ''; // manages bots in A, then leaves
let lena = ''; // a stranger
let universeA = '';
let universeB = '';
let worldA = '';
let guide = ''; // a room bot in A, managed by sara
let farBot = ''; // a room bot in B (lena's universe)
let saraBrick = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, adminUrl: process.env.ADMIN_API_URL, key: process.env.ENCRYPTION_KEY };

const as = (id: string) => (mockUser.current = { id, email: `${id}@example.test` });
const json = async (response: Response) => response.json();
const keyApp = (ownerId: string, extra: Record<string, unknown> = {}) =>
  createConnection(ownerId, { name: 'Tavily', serverUrl: LINK, authType: 'bearer', authConfig: 'tvly-secret', source: 'link', ...extra } as never);
const lendTo = (connectionId: string, body: Record<string, unknown>) => lend(request(`/api/me/apps/${connectionId}/lends`, { method: 'POST', body }), params({ connectionId }));
const letGuide = async (userId: string, connectionId: string, botId = guide) => {
  as(userId);
  return letBotUse(request(`/api/bots/${botId}/apps/available`, { method: 'POST', body: { connectionId } }), params({ id: botId }));
};
const check = async (botId: string, serverId: string, body: Record<string, unknown> = {}) => {
  const response = await useCheck(request(`/api/bots/${botId}/mcp-servers/${serverId}/use`, { method: 'POST', token: SERVICE_TOKEN, body }), params({ id: botId, serverId }));
  return { status: response.status, body: await response.json() };
};
async function lentAndLet(extra: Record<string, unknown> = {}) {
  const app = await keyApp(sara);
  as(sara);
  expect((await lendTo(app.id, { universeId: universeA, ...extra })).status).toBe(201);
  const granted = await letGuide(sara, app.id);
  expect(granted.status).toBe(201);
  return { app, serverId: (await json(granted)).serverId as string };
}

run('lending an app to a universe and a universe’s own apps, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.ADMIN_API_URL = 'https://orbit.example.com';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name: name[0].toUpperCase() + name.slice(1) } });
    const people = [await person('sara'), await person('omar'), await person('nora'), await person('lena')];
    [sara, omar, nora, lena] = people.map((user) => user.id);
    // The test's `as()` gives each person this email; make the stored emails match
    for (const user of people) await prisma.user.update({ where: { id: user.id }, data: { email: `${user.id}@example.test` } });
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
    universeA = (await prisma.universe.create({ data: { slug: `a-${tag}`, name: 'BAWES Universe', ownerId: sara } })).id;
    worldA = (await prisma.world.create({ data: { universeId: universeA, slug: 'hq', name: 'HQ' } })).id;
    const roomA = await prisma.room.create({ data: { worldId: worldA, slug: 'lobby', name: 'Lobby' } });
    guide = (await prisma.bot.create({ data: { roomId: roomA.id, name: 'Guide', createdById: sara, behaviorConfig: {} } })).id;
    universeB = (await prisma.universe.create({ data: { slug: `b-${tag}`, name: 'Far Away', ownerId: lena } })).id;
    const worldB = await prisma.world.create({ data: { universeId: universeB, slug: 'hq', name: 'HQ' } });
    const roomB = await prisma.room.create({ data: { worldId: worldB.id, slug: 'lobby', name: 'Lobby' } });
    farBot = (await prisma.bot.create({ data: { roomId: roomB.id, name: 'Far Guide', createdById: lena, behaviorConfig: {} } })).id;
    // A world tag of "admin" gives Manage bots there (the universe's owner has it already)
    for (const id of [omar, nora]) await prisma.worldMember.create({ data: { worldId: worldA, userId: id, tags: ['admin'] } });
  });

  afterEach(async () => {
    mockUser.current = null;
    await prisma.botMcpServer.deleteMany({ where: { botId: { in: [guide, farBot, saraBrick] } } });
    await prisma.appConnection.deleteMany({ where: { OR: [{ ownerId: { in: [sara, omar, nora, lena] } }, { universeId: { in: [universeA, universeB] } }] } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar, nora, lena] } } });
    await prisma.botActionRequest.deleteMany({ where: { botId: { in: [guide, saraBrick] } } });
    await prisma.botActionGrant.deleteMany({ where: { botId: { in: [guide, saraBrick] } } });
    const member = await prisma.worldMember.findUnique({ where: { userId_worldId: { userId: nora, worldId: worldA } } });
    if (!member) await prisma.worldMember.create({ data: { worldId: worldA, userId: nora, tags: ['admin'] } });
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: { in: [universeA, universeB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, nora, lena] } } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ADMIN_API_TOKEN', envBefore.admin], ['ADMIN_API_URL', envBefore.adminUrl], ['ENCRYPTION_KEY', envBefore.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  /* ---------------------------------- lending ---------------------------------- */

  describe('lending one of your apps', () => {
    it('lists the universes you could lend to and moves no bot when you do', async () => {
      const app = await keyApp(sara);
      as(sara);
      const page = await json(await getApp(request(`/api/me/apps/${app.id}`), params({ connectionId: app.id })));
      expect(page.app.lendable).toBe(true);
      expect(page.canLendTo.map((universe: { id: string }) => universe.id)).toEqual([universeA]);
      expect((await lendTo(app.id, { universeId: universeA, things: ['lookUp'], usesPerDay: 200 })).status).toBe(201);
      expect(await prisma.botMcpServer.count({ where: { connectionId: app.id } })).toBe(0);
      const after = await json(await getApp(request(`/api/me/apps/${app.id}`), params({ connectionId: app.id })));
      expect(after.lentTo).toEqual([expect.objectContaining({ universeId: universeA, universeName: 'BAWES Universe', things: ['lookUp'], usesPerDay: 200, usedToday: 0, bots: [] })]);
      expect(after.canLendTo).toEqual([]);
    });

    it('lends only where you can manage bots', async () => {
      const app = await keyApp(lena);
      as(lena);
      expect((await lendTo(app.id, { universeId: universeA })).status).toBe(403);
      expect(await prisma.appLend.count({ where: { connectionId: app.id } })).toBe(0);
    });

    it('never lends an app that is signed in as you, by any route or by a direct write', async () => {
      const oauth = await createConnection(sara, { name: 'Notion', serverUrl: LINK, authType: 'oauth', authConfig: encryptApiKey('{}'), source: 'link' } as never);
      const listed = await keyApp(sara, { source: 'listed' });
      const readyMade = await keyApp(sara, { source: 'ready_made' });
      as(sara);
      for (const app of [oauth, listed, readyMade]) {
        expect((await lendTo(app.id, { universeId: universeA })).status).toBe(409);
        await expect(prisma.appLend.create({ data: { connectionId: app.id, universeId: universeA, lentById: sara } })).rejects.toThrow(/can be lent/);
      }
      const page = await json(await getApp(request(`/api/me/apps/${oauth.id}`), params({ connectionId: oauth.id })));
      expect(page.app.lendable).toBe(false);
      expect(page.canLendTo).toEqual([]);
    });

    it('answers someone else’s app like one that is not there', async () => {
      const app = await keyApp(sara);
      as(lena);
      expect((await lendTo(app.id, { universeId: universeB })).status).toBe(404);
    });

    it('changes the limits, and a second lend to the same universe is the same lend', async () => {
      const app = await keyApp(sara);
      as(sara);
      await lendTo(app.id, { universeId: universeA, usesPerDay: 50 });
      await lendTo(app.id, { universeId: universeA, usesPerDay: 500 });
      expect(await prisma.appLend.count({ where: { connectionId: app.id } })).toBe(1);
      const changed = await changeLendRoute(request(`/api/me/apps/${app.id}/lends/${universeA}`, { method: 'PATCH', body: { things: ['lookUp', 'make'], usesPerDay: null } }), params({ connectionId: app.id, universeId: universeA }));
      expect(await json(changed)).toMatchObject({ things: ['lookUp', 'make'], usesPerDay: null });
      expect((await changeLendRoute(request(`/api/me/apps/${app.id}/lends/${universeB}`, { method: 'PATCH', body: { usesPerDay: 5 } }), params({ connectionId: app.id, universeId: universeB }))).status).toBe(404);
    });
  });

  describe('letting a bot use a lent app', () => {
    it('is for the person who lent it, who manages the bot, in the universe it was lent to', async () => {
      const app = await keyApp(sara);
      as(sara);
      await lendTo(app.id, { universeId: universeA });
      // Others who manage the bot never see it, and cannot let the bot use it
      as(omar);
      expect((await json(await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide })))).apps).toEqual([]);
      expect((await letGuide(omar, app.id)).status).toBe(404);
      // A person who cannot manage the bot cannot ask either
      expect((await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide }))).status).toBe(200);
      as(lena);
      expect((await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide }))).status).toBe(404);
      // The lender sees it, lets Guide use it, and then it is no longer on offer
      as(sara);
      expect((await json(await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide })))).apps).toEqual([{ connectionId: app.id, name: 'Tavily', kind: 'lent' }]);
      expect((await letGuide(sara, app.id)).status).toBe(201);
      expect((await letGuide(sara, app.id)).status).toBe(201);
      expect(await prisma.botMcpServer.count({ where: { botId: guide, connectionId: app.id } })).toBe(1);
      expect((await json(await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide })))).apps).toEqual([]);
    });

    it('refuses a bot of a universe it was not lent to, also by a direct write', async () => {
      const app = await keyApp(sara);
      as(sara);
      await lendTo(app.id, { universeId: universeA });
      expect((await letGuide(sara, app.id, farBot)).status).toBe(404);
      await expect(prisma.botMcpServer.create({ data: { botId: farBot, connectionId: app.id, name: 'Tavily', serverUrl: '' } })).rejects.toThrow(/can only be used/);
    });

    it('refuses a room bot with no lend, also by a direct write', async () => {
      const app = await keyApp(sara);
      expect((await letGuide(sara, app.id)).status).toBe(404);
      await expect(prisma.botMcpServer.create({ data: { botId: guide, connectionId: app.id, name: 'Tavily', serverUrl: '' } })).rejects.toThrow(/can only be used/);
    });

    it('shows the bot’s page what was lent, and the person’s own page lists the bot with its uses', async () => {
      const { app, serverId } = await lentAndLet({ things: ['lookUp'], usesPerDay: 200 });
      await check(guide, serverId, { callId: 'one', heading: 'lookUp' });
      await check(guide, serverId, { callId: 'two', heading: 'lookUp' });
      as(sara);
      const list = await json(await listServers(request(`/api/bots/${guide}/mcp-servers`), params({ id: guide })));
      expect(list).toEqual([expect.objectContaining({ id: serverId, name: 'Tavily', lent: { things: ['lookUp'], usesPerDay: 200 } })]);
      expect(JSON.stringify(list)).not.toContain('tvly-secret');
      const page = await json(await getApp(request(`/api/me/apps/${app.id}`), params({ connectionId: app.id })));
      expect(page.lentTo[0]).toMatchObject({ usedToday: 2, bots: [{ botId: guide, serverId, usesThisMonth: 2 }] });
      // A bot that uses it through a lend is not listed as one of the person's own Bricks
      expect(page.app.bricks).toEqual([]);
    });
  });

  describe('using a lent app', () => {
    it('answers every visitor of the bot, counted for the lender, and holds the heading the lender allowed', async () => {
      const { serverId } = await lentAndLet({ things: ['lookUp', 'make'] });
      const ok = await check(guide, serverId, { callId: 'a', heading: 'lookUp' });
      expect(ok).toMatchObject({ status: 200, body: { allowed: true, paidBy: { kind: 'person', personId: sara } } });
      expect((await check(guide, serverId, { requesterKey: `lena-${tag}`, callId: 'b', heading: 'make' })).body.allowed).toBe(true);
      const refused = await check(guide, serverId, { callId: 'c', heading: 'deleteSend' });
      expect(refused.body).toMatchObject({ allowed: false, reason: 'not_lent' });
      expect(await prisma.appUse.count({ where: { botId: guide } })).toBe(2);
    });

    it('refuses a use that does not say which call or which heading it is: nothing is let through unchecked or uncounted', async () => {
      const { serverId } = await lentAndLet({ things: ['lookUp'], usesPerDay: 5 });
      expect((await check(guide, serverId, { heading: 'deleteSend' })).body).toMatchObject({ allowed: false, reason: 'incomplete' });
      expect((await check(guide, serverId, { callId: 'no-heading' })).body).toMatchObject({ allowed: false, reason: 'incomplete' });
      expect((await check(guide, serverId, {})).body).toMatchObject({ allowed: false, reason: 'incomplete' });
      expect(await prisma.appUse.count({ where: { botId: guide } })).toBe(0);
    });

    it('stops serving the universe when the person who lent it no longer has Manage bots there, and starts again when they do', async () => {
      const app = await keyApp(nora);
      as(nora);
      expect((await lendTo(app.id, { universeId: universeA })).status).toBe(201);
      const serverId = (await json(await letGuide(nora, app.id))).serverId as string;
      expect((await check(guide, serverId, { callId: 'before', heading: 'lookUp' })).body).toMatchObject({ allowed: true, paidBy: { kind: 'person', personId: nora } });
      // nora leaves the universe: the lend row is still there, the app is not served and nothing is billed to her
      await prisma.worldMember.delete({ where: { userId_worldId: { userId: nora, worldId: worldA } } });
      expect((await check(guide, serverId, { callId: 'after', heading: 'lookUp' })).body).toMatchObject({ allowed: false, reason: 'gone' });
      expect(await prisma.appUse.count({ where: { botId: guide, callId: 'after' } })).toBe(0);
      // They come back with the role: it carries on, as before
      await prisma.worldMember.create({ data: { worldId: worldA, userId: nora, tags: ['admin'] } });
      expect((await check(guide, serverId, { callId: 'back', heading: 'lookUp' })).body.allowed).toBe(true);
    });

    it('counts the same call id of two different bots as two uses, so one bot cannot hide behind another’s id', async () => {
      const { app, serverId } = await lentAndLet({ usesPerDay: 2 });
      const second = await prisma.bot.create({ data: { roomId: (await prisma.bot.findUniqueOrThrow({ where: { id: guide }, select: { roomId: true } })).roomId, name: 'Second', createdById: sara, behaviorConfig: {} } });
      try {
        const grant = await letGuide(sara, app.id, second.id);
        expect(grant.status).toBe(201);
        const secondServer = (await json(grant)).serverId as string;
        expect((await check(guide, serverId, { callId: 'same', heading: 'lookUp' })).body.allowed).toBe(true);
        expect((await check(second.id, secondServer, { callId: 'same', heading: 'lookUp' })).body.allowed).toBe(true);
        expect(await prisma.appUse.count({ where: { connectionId: app.id } })).toBe(2);
        // The day's two uses are gone: a third id, from either bot, is over the limit
        expect((await check(second.id, secondServer, { callId: 'third', heading: 'lookUp' })).body).toMatchObject({ allowed: false, reason: 'limit_reached' });
        // And each bot's own retry is still the same use
        expect((await check(guide, serverId, { callId: 'same', heading: 'lookUp' })).body.allowed).toBe(true);
        expect(await prisma.appUse.count({ where: { connectionId: app.id } })).toBe(2);
      } finally {
        await prisma.botMcpServer.deleteMany({ where: { botId: second.id } });
        await prisma.bot.delete({ where: { id: second.id } });
      }
    });

    it('stops at the day’s limit, counts a retry once, and tells the lender once', async () => {
      const { serverId } = await lentAndLet({ usesPerDay: 2 });
      expect((await check(guide, serverId, { callId: 'c1', heading: 'lookUp' })).body.allowed).toBe(true);
      expect((await check(guide, serverId, { callId: 'c2', heading: 'lookUp' })).body.allowed).toBe(true);
      const over = await check(guide, serverId, { callId: 'c3', heading: 'lookUp' });
      expect(over.body).toMatchObject({ allowed: false, reason: 'limit_reached' });
      expect((await check(guide, serverId, { callId: 'c4', heading: 'lookUp' })).body.reason).toBe('limit_reached');
      // The same call again is the same use, even at the limit
      expect((await check(guide, serverId, { callId: 'c1', heading: 'lookUp' })).body.allowed).toBe(true);
      expect(await prisma.appUse.count({ where: { botId: guide } })).toBe(2);
      expect(await prisma.userNotice.count({ where: { userId: sara, kind: 'app-lend-limit' } })).toBe(1);
    });

    it('never lets two calls at once take the last use', async () => {
      const { serverId } = await lentAndLet({ usesPerDay: 3 });
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => check(guide, serverId, { callId: `p${index}`, heading: 'lookUp' })));
      expect(results.filter((result) => result.body.allowed)).toHaveLength(3);
      expect(await prisma.appUse.count({ where: { botId: guide } })).toBe(3);
    });

    it('counts nothing for a person’s own Brick, which needs no call id', async () => {
      const { app } = await lentAndLet({ usesPerDay: 1 });
      const own = await grantToBrick(sara, app.id, saraBrick);
      const verdict = await checkAppUse(saraBrick, own!.id, { requesterKey: `sara-${tag}`, callId: 'x' });
      expect(verdict).toMatchObject({ allowed: true });
      expect(await prisma.appUse.count({ where: { botId: saraBrick } })).toBe(0);
    });

    it('keeps a person’s app used by their own Brick only for them, as before', async () => {
      const app = await keyApp(sara);
      const own = await grantToBrick(sara, app.id, saraBrick);
      expect((await check(saraBrick, own!.id, { requesterKey: `lena-${tag}` })).body).toMatchObject({ allowed: false, reason: 'not_owner' });
      expect((await check(saraBrick, own!.id, { requesterKey: `sara-${tag}` })).body.allowed).toBe(true);
    });

    it('has the bot’s switch turn it off', async () => {
      const { serverId } = await lentAndLet();
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { enabled: false } });
      expect((await check(guide, serverId, { callId: 'z', heading: 'lookUp' })).body).toMatchObject({ allowed: false, reason: 'off' });
    });
  });

  describe('taking it back', () => {
    it('makes a bot wait for a lend that is being taken back, then refuses it: never a grant without a lend', async () => {
      const app = await keyApp(sara);
      as(sara);
      expect((await lendTo(app.id, { universeId: universeA })).status).toBe(201);
      let letting: ReturnType<typeof letGuide> | null = null;
      // The lend is held by a taker that has not committed yet; the bot is let use it meanwhile
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "app_lends" WHERE "connection_id" = ${app.id} AND "universe_id" = ${universeA} FOR UPDATE`;
        letting = letGuide(sara, app.id);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tx.appLend.deleteMany({ where: { connectionId: app.id } });
      });
      expect((await letting!).status).toBe(404);
      expect(await prisma.botMcpServer.count({ where: { connectionId: app.id } })).toBe(0);
    });

    it('leaves no grant behind when a bot is let use the app at the very moment the lend is taken back', async () => {
      for (let round = 0; round < 6; round += 1) {
        const app = await keyApp(sara);
        as(sara);
        expect((await lendTo(app.id, { universeId: universeA })).status).toBe(201);
        const letting = letGuide(sara, app.id);
        const taking = takeBackRoute(request(`/api/me/apps/${app.id}/lends/${universeA}`, { method: 'DELETE' }), params({ connectionId: app.id, universeId: universeA }));
        await Promise.all([letting, taking]);
        expect(await prisma.appLend.count({ where: { connectionId: app.id } })).toBe(0);
        expect(await prisma.botMcpServer.count({ where: { connectionId: app.id } })).toBe(0);
        await prisma.appConnection.delete({ where: { id: app.id } });
      }
    });

    it('stops the bot at once, ends its approvals, and lending again does not give it back', async () => {
      const { app, serverId } = await lentAndLet();
      const base = { botId: guide, requesterKey: `sara-${tag}`, conversationKey: 'dm', connectionRef: serverId, toolName: 'search', heading: 'changesThings', toolFingerprint: 'fp', policyRevision: 1 };
      const grant = await prisma.botActionGrant.create({
        data: { ...base, scope: { fixed: {}, varies: [] }, idleMinutes: 60, idleExpiresAt: new Date(Date.now() + 3_600_000), absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000) },
      });
      expect((await check(guide, serverId, { callId: 'open', heading: 'lookUp' })).body.allowed).toBe(true);
      as(sara);
      expect((await takeBackRoute(request(`/api/me/apps/${app.id}/lends/${universeA}`, { method: 'DELETE' }), params({ connectionId: app.id, universeId: universeA }))).status).toBe(204);
      expect((await check(guide, serverId, { callId: 'after', heading: 'lookUp' })).status).toBe(404);
      expect(await prisma.botMcpServer.count({ where: { connectionId: app.id } })).toBe(0);
      expect((await prisma.botActionGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt).not.toBeNull();
      // Lending again later gives Guide nothing
      await lendTo(app.id, { universeId: universeA });
      expect(await prisma.botMcpServer.count({ where: { connectionId: app.id } })).toBe(0);
      expect((await takeBackRoute(request(`/api/me/apps/${app.id}/lends/${universeB}`, { method: 'DELETE' }), params({ connectionId: app.id, universeId: universeB }))).status).toBe(404);
    });

    it('leaves a bot of another universe that uses the same app alone, and only the lender can take it back', async () => {
      const { app } = await lentAndLet();
      as(omar);
      expect((await takeBackRoute(request(`/api/me/apps/${app.id}/lends/${universeA}`, { method: 'DELETE' }), params({ connectionId: app.id, universeId: universeA }))).status).toBe(404);
      expect(await prisma.appLend.count({ where: { connectionId: app.id } })).toBe(1);
    });

    it('goes when the app is disconnected', async () => {
      const { app, serverId } = await lentAndLet();
      await prisma.appConnection.delete({ where: { id: app.id } });
      expect((await check(guide, serverId, {})).status).toBe(404);
      expect(await prisma.appLend.count({ where: { connectionId: app.id } })).toBe(0);
    });
  });

  /* ------------------------------ a universe's own apps ------------------------------ */

  describe('a universe’s own apps', () => {
    const addTeam = (userId: string, universeId = universeA, body: Record<string, unknown> = {}) => {
      as(userId);
      return teamAdd(request(`/api/me/universes/${universeId}/apps`, { method: 'POST', body: { name: 'Notion', serverUrl: 'https://notion.example.com/mcp', authType: 'bearer', authConfig: 'ntn-secret', ...body } }), params({ universeId }));
    };

    it('lists "Your universes" for people who manage bots, and shows nobody else a universe’s apps', async () => {
      as(omar);
      expect((await json(await myUniverses(request('/api/me/universes')))).universes).toEqual([expect.objectContaining({ id: universeA, name: 'BAWES Universe', apps: 0 })]);
      const created = await addTeam(omar);
      expect(created.status).toBe(201);
      as(sara);
      expect((await json(await myUniverses(request('/api/me/universes')))).universes[0].apps).toBe(1);
      as(lena);
      expect((await teamList(request(`/api/me/universes/${universeA}/apps`), params({ universeId: universeA }))).status).toBe(404);
      expect((await addTeam(lena)).status).toBe(404);
      expect(await prisma.appConnection.count({ where: { universeId: universeA } })).toBe(1);
    });

    it('belongs to the universe, not a person, and its connector becomes its manager', async () => {
      const created = await json(await addTeam(omar));
      const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({ ownerId: null, universeId: universeA, connectedById: omar });
      expect(row.authConfig).not.toContain('ntn-secret');
      expect(created.app).toMatchObject({ name: 'Notion', universeName: 'BAWES Universe', youManage: true, connectedBy: { name: 'Omar', stillManages: true } });
      expect(created.app.managers.map((person: { name: string }) => person.name).sort()).toEqual(['Omar', 'Sara']);
      // The game's list marks who owns the universe (not removable) and who is asking
      expect(created.app.managers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sara, owner: true, you: false }),
        expect.objectContaining({ id: omar, owner: false, you: true }),
      ]));
      expect(created.app.connectedBy.you).toBe(true);
      expect(JSON.stringify(created)).not.toContain('ntn-secret');
      // A direct write cannot make one that is nobody's or everybody's
      await expect(prisma.appConnection.create({ data: { name: 'x', serverUrl: LINK, ownerId: null, universeId: null } })).rejects.toThrow(/owner_xor_universe/);
      await expect(prisma.appConnection.create({ data: { name: 'x', serverUrl: LINK, ownerId: sara, universeId: universeA } })).rejects.toThrow(/owner_xor_universe/);
    });

    it('is managed by the owner always, and by named managers who still manage bots there', async () => {
      const created = await json(await addTeam(omar));
      const id = created.id as string;
      as(sara); // the owner, never named
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(200);
      // nora manages bots there but is not named
      as(nora);
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(404);
      as(lena);
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(404);
    });

    it('adds a manager who can manage bots there, and refuses anyone else', async () => {
      const id = (await json(await addTeam(omar))).id as string;
      as(omar);
      const view = await json(await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id })));
      expect(view.canAddAsManager.map((person: { name: string }) => person.name)).toEqual(['Nora']);
      expect((await addManagerRoute(request(`/api/me/team-apps/${id}/managers`, { method: 'POST', body: { userId: lena } }), params({ connectionId: id }))).status).toBe(422);
      expect((await addManagerRoute(request(`/api/me/team-apps/${id}/managers`, { method: 'POST', body: { userId: nora } }), params({ connectionId: id }))).status).toBe(201);
      expect((await addManagerRoute(request(`/api/me/team-apps/${id}/managers`, { method: 'POST', body: { userId: nora } }), params({ connectionId: id }))).status).toBe(201);
      expect(await prisma.appConnectionManager.count({ where: { connectionId: id, userId: nora } })).toBe(1);
      as(nora);
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(200);
      // A stranger and a manager-less person cannot add managers
      as(lena);
      expect((await addManagerRoute(request(`/api/me/team-apps/${id}/managers`, { method: 'POST', body: { userId: lena } }), params({ connectionId: id }))).status).toBe(404);
      // A manager takes another off, and the owner keeps it
      as(omar);
      expect((await removeManagerRoute(request(`/api/me/team-apps/${id}/managers/${nora}`, { method: 'DELETE' }), params({ connectionId: id, personId: nora }))).status).toBe(204);
      as(nora);
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(404);
    });

    it('lets a bot of the universe use it when a manager of both says so, and never a bot of another universe', async () => {
      const id = (await json(await addTeam(omar))).id as string;
      as(omar);
      expect((await json(await available(request(`/api/bots/${guide}/apps/available`), params({ id: guide })))).apps).toEqual([{ connectionId: id, name: 'Notion', kind: 'team' }]);
      expect((await letGuide(omar, id)).status).toBe(201);
      expect((await letGuide(omar, id, farBot)).status).toBe(404);
      await expect(prisma.botMcpServer.create({ data: { botId: farBot, connectionId: id, name: 'Notion', serverUrl: '' } })).rejects.toThrow(/can only be used/);
      // nora manages the bot but not the app
      expect((await letGuide(nora, id)).status).toBe(404);
    });

    it('offers as new managers exactly the people with Manage bots who are not managers yet, with a fixed number of queries', async () => {
      const id = (await json(await addTeam(omar))).id as string;
      // Omar and Sara manage it; Nora can manage bots; a guest with the same role and Lena (nothing) are not offered
      const guest = await prisma.user.create({ data: { uuid: `guest-${tag}`, email: `guest-${tag}@example.test`, name: 'Guest', isGuest: true } });
      await prisma.worldMember.create({ data: { worldId: worldA, userId: guest.id, tags: ['admin'] } });
      const findUnique = jest.spyOn(prisma.user, 'findUnique');
      const findMany = jest.spyOn(prisma.user, 'findMany');
      try {
        const offered = await managerCandidates(sara, id);
        expect(offered?.map((person) => person.name)).toEqual(['Nora']);
        // The people are read together: no read of a user for each candidate
        expect(findUnique).not.toHaveBeenCalled();
        expect(findMany.mock.calls.filter(([args]) => JSON.stringify(args).includes('"isGuest":false'))).toHaveLength(1);
        // More candidates do not add queries to the people read
        for (let index = 0; index < 5; index += 1) {
          const extra = await prisma.user.create({ data: { uuid: `extra${index}-${tag}`, email: `extra${index}-${tag}@example.test`, name: `Extra ${index}` } });
          await prisma.worldMember.create({ data: { worldId: worldA, userId: extra.id, tags: ['admin'] } });
        }
        findUnique.mockClear();
        findMany.mockClear();
        expect((await managerCandidates(sara, id))?.map((person) => person.name).sort()).toEqual(['Extra 0', 'Extra 1', 'Extra 2', 'Extra 3', 'Extra 4', 'Nora']);
        expect(findUnique).not.toHaveBeenCalled();
        expect(findMany.mock.calls.filter(([args]) => JSON.stringify(args).includes('"isGuest":false'))).toHaveLength(1);
      } finally {
        findUnique.mockRestore();
        findMany.mockRestore();
        await prisma.worldMember.deleteMany({ where: { worldId: worldA, user: { uuid: { contains: tag }, NOT: { id: { in: [sara, omar, nora, lena] } } } } });
        await prisma.user.deleteMany({ where: { uuid: { contains: tag }, id: { notIn: [sara, omar, nora, lena] } } });
      }
    });

    it('is used by the universe’s bot for any visitor, and counted for the universe', async () => {
      const id = (await json(await addTeam(omar))).id as string;
      const serverId = (await json(await letGuide(omar, id))).serverId as string;
      expect((await check(guide, serverId, {})).body).toMatchObject({ allowed: false, reason: 'incomplete' });
      expect((await check(guide, serverId, { callId: 'u1' })).body).toMatchObject({ allowed: true, paidBy: { kind: 'universe', universeId: universeA } });
      expect((await check(guide, serverId, { requesterKey: `lena-${tag}`, callId: 'u1' })).body.allowed).toBe(true);
      expect((await check(guide, serverId, { callId: 'u2' })).body.allowed).toBe(true);
      as(omar);
      expect((await json(await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id })))).app).toMatchObject({ usesThisMonth: 2, bots: [{ botId: guide, serverId, enabled: true }] });
    });

    it('outlives a manager who leaves: they stop managing it, it says so, the bots keep working, and a reconnect names who did it', async () => {
      const id = (await json(await addTeam(nora))).id as string;
      as(nora);
      const serverId = (await json(await letGuide(nora, id))).serverId as string;
      // nora is a manager and also the owner's... make omar a second manager first
      as(nora);
      await addManagerRoute(request(`/api/me/team-apps/${id}/managers`, { method: 'POST', body: { userId: omar } }), params({ connectionId: id }));
      // nora leaves the universe
      await prisma.worldMember.delete({ where: { userId_worldId: { userId: nora, worldId: worldA } } });
      as(nora);
      expect((await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id }))).status).toBe(404);
      as(omar);
      const view = (await json(await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id })))).app;
      expect(view.managers.map((person: { name: string }) => person.name).sort()).toEqual(['Omar', 'Sara']);
      expect(view.connectedBy).toMatchObject({ name: 'Nora', stillManages: false });
      expect(view.bots).toHaveLength(1);
      // Nothing was handed over, and the bot still uses it
      expect(await prisma.appConnection.count({ where: { id: id } })).toBe(1);
      expect((await check(guide, serverId, { callId: 'after-leave' })).body.allowed).toBe(true);
      // Signing it in again by a manager names them as who connected it
      await markConnectionReconnected(id, omar);
      const again = (await json(await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id })))).app;
      expect(again.connectedBy).toMatchObject({ name: 'Omar', stillManages: true });
      // A person who left cannot sign it in
      await markConnectionReconnected(id, nora);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).connectedById).toBe(omar);
    });

    it('stays when the person who connected it deletes their account', async () => {
      const id = (await json(await addTeam(nora))).id as string;
      await prisma.user.delete({ where: { id: nora } });
      const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
      expect(row.connectedById).toBeNull();
      expect(row.universeId).toBe(universeA);
      nora = (await prisma.user.create({ data: { uuid: `nora2-${tag}`, email: `nora2-${tag}@example.test`, name: 'Nora' } })).id;
      await prisma.worldMember.create({ data: { worldId: worldA, userId: nora, tags: ['admin'] } });
    });

    it('says who can reconnect when its sign-in ended, and a manager starts the sign-in', async () => {
      const id = (await json(await addTeam(omar, universeA, { authType: 'oauth', authConfig: JSON.stringify({ clientId: 'c', authorizeUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token' }) }))).id as string;
      await prisma.appConnection.update({ where: { id }, data: { signInLostAt: new Date() } });
      as(omar);
      const view = (await json(await teamGet(request(`/api/me/team-apps/${id}`), params({ connectionId: id })))).app;
      expect(view).toMatchObject({ reconnectRequired: true, youManage: true });
      expect(view.managers.map((person: { name: string }) => person.name).sort()).toEqual(['Omar', 'Sara']);
      expect((await signInStart(request(`/api/me/apps/${id}/sign-in`), params({ connectionId: id }))).status).toBe(200);
      as(lena);
      expect((await signInStart(request(`/api/me/apps/${id}/sign-in`), params({ connectionId: id }))).status).toBe(404);
    });

    it('is disconnected by a manager: every bot stops at once', async () => {
      const id = (await json(await addTeam(omar))).id as string;
      const serverId = (await json(await letGuide(omar, id))).serverId as string;
      as(lena);
      expect((await teamDisconnect(request(`/api/me/team-apps/${id}`, { method: 'DELETE' }), params({ connectionId: id }))).status).toBe(404);
      as(omar);
      expect((await teamDisconnect(request(`/api/me/team-apps/${id}`, { method: 'DELETE' }), params({ connectionId: id }))).status).toBe(204);
      expect((await check(guide, serverId, {})).status).toBe(404);
    });

    it('is never in a person’s own list of apps', async () => {
      await addTeam(omar);
      const { GET: listApps } = await import('@/app/api/me/apps/route');
      as(omar);
      expect((await json(await listApps(request('/api/me/apps')))).apps).toEqual([]);
    });
  });
});
