/**
 * Other people asking a Brick for a job from its owner's app (game #2006, mock Part 17, plan F4.3 and H3 change 3, checks 23, 31, 32,
 * 52 and 54), against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/app-share-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));

// The app answers its list of tools like this; what the owner's page reads, and what a pick is held to
const mockTools = {
  current: null as null | { name: string; description: string | null; inputs: { name: string; required: boolean }[]; outputs: string[] | null }[],
};
jest.mock('@/lib/mcp/test-connection', () => ({
  ...jest.requireActual('@/lib/mcp/test-connection'),
  testMcpConnection: jest.fn(async () =>
    mockTools.current ? { success: true, toolCount: mockTools.current.length, toolNames: mockTools.current.map((tool) => tool.name), tools: mockTools.current } : { success: false, toolCount: 0, toolNames: [], error: 'down' },
  ),
}));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { encryptApiKey } from '@/lib/encryption';
import { createConnection, grantToBrick, removeGrant, disconnect } from '@/lib/app-connections';
import { saveServerLimits } from '@/lib/bot-limits';
import { BRICK_LIMITS_RECOMMENDED } from '@/lib/bot-limit-values';
import { GET as getApp } from '@/app/api/me/apps/[connectionId]/route';
import { GET as getShare, POST as startShareRoute, PATCH as changeShareRoute, DELETE as stopShareRoute } from '@/app/api/me/apps/[connectionId]/bricks/[botId]/share/route';
import { POST as checkRoute } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/route';
import { POST as settleRoute } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/settle/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const LINK = 'https://music.example.com/mcp';
const SECRET = `secret-key-${tag}`;

const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = ''; // owns the app and the Brick
let omar = ''; // signed in, asks the Brick
let lena = ''; // a stranger to the app
let saraBrick = '';
let saraOther = ''; // another Brick of sara's
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY };

const as = (id: string) => (mockUser.current = { id, email: `${id}@example.test` });
const json = async (response: Response) => response.json();

const SONG = { name: 'make_song', description: 'Makes a song', inputs: [{ name: 'prompt', required: true }, { name: 'style', required: false }], outputs: ['url', 'title'] };
const FIND = { name: 'find_songs', description: 'Finds songs', inputs: [{ name: 'query', required: true }], outputs: null };
const WIPE = { name: 'delete_song', description: 'Deletes a song', inputs: [{ name: 'id', required: true }], outputs: null };

const keyApp = (ownerId: string, extra: Record<string, unknown> = {}) =>
  createConnection(ownerId, { name: 'ACE-Step', serverUrl: LINK, authType: 'bearer', authConfig: SECRET, source: 'link', ...extra } as never);

/** The tools the bot server saved for a Brick's use of the app, each confirmed under its heading. */
async function tools(serverId: string) {
  const confirmed = new Date();
  await prisma.botMcpTool.createMany({
    data: [
      { serverId, name: 'make_song', fingerprint: 'fp-make', heading: 'makesNew', confirmedAt: confirmed },
      { serverId, name: 'find_songs', fingerprint: 'fp-find', heading: 'looksUp', confirmedAt: confirmed },
      { serverId, name: 'delete_song', fingerprint: 'fp-wipe', heading: 'deletesOrSends', confirmedAt: confirmed },
    ],
  });
}

async function music(brickId = saraBrick) {
  const app = await keyApp(sara);
  const grant = await grantToBrick(sara, app.id, brickId);
  if (!grant) throw new Error('no grant');
  await tools(grant.id);
  return { app, serverId: grant.id, botId: brickId };
}

const shareRoute = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', appId: string, botId: string, body?: unknown) => {
  const handler = { GET: getShare, POST: startShareRoute, PATCH: changeShareRoute, DELETE: stopShareRoute }[method];
  return handler(request(`/api/me/apps/${appId}/bricks/${botId}/share`, { method, body }), params({ connectionId: appId, botId }));
};

/** Starts sharing "Make a song" the way the one button does, with the two inputs people may fill in. */
async function shareSong(appId: string, botId = saraBrick, extra: Record<string, unknown> = {}) {
  as(sara);
  const response = await shareRoute('POST', appId, botId, { jobs: [{ tool: 'make_song', inputs: ['prompt', 'style'], returns: ['url'] }], ...extra });
  expect(response.status).toBe(201);
  return json(response);
}

const check = async (botId: string, serverId: string, body: Record<string, unknown> = {}) => {
  const response = await checkRoute(request(`/api/bots/${botId}/mcp-servers/${serverId}/use`, { method: 'POST', token: SERVICE_TOKEN, body }), params({ id: botId, serverId }));
  return { status: response.status, body: await response.json() };
};
const ask = (botId: string, serverId: string, who: string, callId: string, extra: Record<string, unknown> = {}) =>
  check(botId, serverId, { requesterKey: who, callId, tool: 'make_song', argumentNames: ['prompt'], ...extra });
const settle = async (botId: string, serverId: string, callId: string, outcome: string, token: string | null = SERVICE_TOKEN) => {
  const response = await settleRoute(request(`/api/bots/${botId}/mcp-servers/${serverId}/use/settle`, { method: 'POST', token: token ?? undefined, body: { callId, outcome } }), params({ id: botId, serverId }));
  return { status: response.status, body: await response.json() };
};
const omarKey = () => `omar-${tag}`;
const saraKey = () => `sara-${tag}`;

const setLimits = (change: Partial<typeof BRICK_LIMITS_RECOMMENDED>) => saveServerLimits({ bricks: change }, sara);

run('other people asking a Brick for a job from its owner’s app, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name: name[0].toUpperCase() + name.slice(1) } });
    const people = [await person('sara'), await person('omar'), await person('lena')];
    [sara, omar, lena] = people.map((user) => user.id);
    for (const user of people) await prisma.user.update({ where: { id: user.id }, data: { email: `${user.id}@example.test` } });
    saraBrick = (await createBrick({ ownerId: sara, name: 'Music Brick' })).id;
    saraOther = (await createBrick({ ownerId: sara, name: 'Other Brick' })).id;
  });

  beforeEach(() => {
    mockTools.current = [SONG, FIND, WIPE];
  });

  afterEach(async () => {
    mockUser.current = null;
    await setLimits(BRICK_LIMITS_RECOMMENDED);
    await prisma.botMcpServer.deleteMany({ where: { botId: { in: [saraBrick, saraOther] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar, lena] } } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar, lena] } } });
    await prisma.meterEvent.deleteMany({ where: { botId: { in: [saraBrick, saraOther] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, lena] } } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ENCRYPTION_KEY', envBefore.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  /* ------------------------------ the owner's page ------------------------------ */

  describe('"Other people: only you" and the one button', () => {
    it('starts as only you: the jobs that can be shared are the look-ups and the makes, with their inputs and what comes back', async () => {
      const { app } = await music();
      as(sara);
      const page = await json(await shareRoute('GET', app.id, saraBrick));
      expect(page).toMatchObject({ shareable: true, shared: false, reachable: true, usedToday: 0, limits: { usesPerDayEveryone: 20, usesPerDayPerson: 3 } });
      // Deleting stays the owner's: it is not even on the list
      expect(page.jobs.map((job: { tool: string }) => job.tool)).toEqual(['find_songs', 'make_song']);
      const song = page.jobs.find((job: { tool: string }) => job.tool === 'make_song');
      expect(song).toMatchObject({ title: 'Make Song', picked: false, inputs: [{ name: 'prompt', required: true, picked: false }, { name: 'style', required: false, picked: false }], returns: { names: ['url', 'title'], picked: null } });
      // The app's page lists its Bricks with whether others can ask each one
      const listed = await json(await getApp(request(`/api/me/apps/${app.id}`), params({ connectionId: app.id })));
      expect(listed.app.shareable).toBe(true);
      expect(listed.app.bricks).toEqual([expect.objectContaining({ botId: saraBrick, shared: false })]);
    });

    it('never shows the owner’s link, key or account', async () => {
      const { app } = await music();
      await shareSong(app.id);
      as(sara);
      const text = JSON.stringify(await json(await shareRoute('GET', app.id, saraBrick)));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(LINK);
      expect(text).not.toContain(sara);
    });

    it('says "Only for you" for an app signed in as the person, by every route and by a direct write', async () => {
      const oauth = await createConnection(sara, { name: 'Gmail', serverUrl: LINK, authType: 'oauth', authConfig: encryptApiKey('{}'), source: 'link' } as never);
      const listed = await keyApp(sara, { name: 'Notion', source: 'listed' });
      const readyMade = await keyApp(sara, { name: 'Calendar', source: 'ready_made' });
      as(sara);
      for (const app of [oauth, listed, readyMade]) {
        const grant = await grantToBrick(sara, app.id, saraBrick);
        expect(grant).not.toBeNull();
        expect((await json(await shareRoute('GET', app.id, saraBrick))).shareable).toBe(false);
        expect((await shareRoute('POST', app.id, saraBrick, { jobs: [{ tool: 'x', inputs: [], returns: null }] })).status).toBe(409);
        await expect(prisma.appShare.create({ data: { serverId: (grant as { id: string }).id, sharedById: sara, usesPerDayEveryone: 1, usesPerDayPerson: 1 } })).rejects.toThrow(/can be shared/);
      }
      expect(await prisma.appShare.count({ where: { server: { botId: saraBrick } } })).toBe(0);
    });

    it('is only for the owner of the app and of the Brick: anyone else sees nothing', async () => {
      const { app } = await music();
      const mine = await keyApp(lena);
      as(lena);
      expect((await shareRoute('GET', app.id, saraBrick)).status).toBe(404);
      expect((await shareRoute('POST', app.id, saraBrick, {})).status).toBe(404);
      as(sara);
      // Someone else's Brick, and an app the Brick does not use
      expect((await shareRoute('GET', mine.id, saraBrick)).status).toBe(404);
      expect((await shareRoute('GET', app.id, saraOther)).status).toBe(404);
    });

    it('with several jobs, the button needs a pick; with exactly one it shares that one', async () => {
      const { app } = await music();
      as(sara);
      const none = await shareRoute('POST', app.id, saraBrick, {});
      expect(none.status).toBe(409);
      expect((await json(none)).reason).toBe('no_job');
      await prisma.botMcpTool.deleteMany({ where: { name: { not: 'make_song' }, server: { botId: saraBrick } } });
      const started = await shareRoute('POST', app.id, saraBrick, {});
      expect(started.status).toBe(201);
      const page = await json(started);
      expect(page.shared).toBe(true);
      expect(page.jobs).toEqual([expect.objectContaining({ tool: 'make_song', picked: true })]);
      // Asked again: the same share, unchanged
      const again = await shareRoute('POST', app.id, saraBrick, { usesPerDayEveryone: 99 });
      expect(again.status).toBe(200);
      expect((await json(again)).limits.usesPerDayEveryone).toBe(20);
    });

    it('holds a pick to what the app really offers', async () => {
      const { app } = await music();
      as(sara);
      const pick = (job: Record<string, unknown>) => shareRoute('POST', app.id, saraBrick, { jobs: [job] });
      // Deleting is never shared, and neither is a tool the app does not have
      expect((await pick({ tool: 'delete_song', inputs: ['id'], returns: null })).status).toBe(400);
      expect((await pick({ tool: 'nothing', inputs: [], returns: null })).status).toBe(400);
      // An input it does not take, and an input it needs that nobody could fill in
      expect((await json(await pick({ tool: 'make_song', inputs: ['prompt', 'secret'], returns: ['url'] }))).reason).toBe('bad_input');
      expect((await json(await pick({ tool: 'make_song', inputs: ['style'], returns: ['url'] }))).reason).toBe('missing_input');
      // A field it does not give back, and a narrower answer for a tool that does not say what it gives back
      expect((await json(await pick({ tool: 'make_song', inputs: ['prompt'], returns: ['password'] }))).reason).toBe('bad_return');
      expect((await json(await pick({ tool: 'find_songs', inputs: ['query'], returns: ['title'] }))).reason).toBe('bad_return');
      expect(await prisma.appShare.count({ where: { server: { botId: saraBrick } } })).toBe(0);
    });

    it('offers only tools the app listed just now, so one it did not list is never shared with an unnamed answer', async () => {
      const { app } = await music();
      mockTools.current = [SONG];
      as(sara);
      const page = await json(await shareRoute('GET', app.id, saraBrick));
      expect(page.jobs.map((job: { tool: string }) => job.tool)).toEqual(['make_song']);
      const refused = await shareRoute('POST', app.id, saraBrick, { jobs: [{ tool: 'find_songs', inputs: ['query'], returns: null }] });
      expect(refused.status).toBe(400);
      expect((await json(refused)).reason).toBe('unknown_job');
    });

    it('cannot pick while the app cannot be reached, and says so', async () => {
      const { app } = await music();
      mockTools.current = null;
      as(sara);
      const page = await json(await shareRoute('GET', app.id, saraBrick));
      expect(page.reachable).toBe(false);
      const refused = await shareRoute('POST', app.id, saraBrick, { jobs: [{ tool: 'make_song', inputs: ['prompt'], returns: ['url'] }] });
      expect(refused.status).toBe(503);
      expect((await json(refused)).reason).toBe('unreachable');
    });

    it('starts at the limits a super admin set in Limits, and the owner changes them for their own app', async () => {
      await setLimits({ sharedUsesEveryone: 7, sharedUsesPerPerson: 2 });
      const { app } = await music();
      const started = await shareSong(app.id);
      expect(started.limits).toEqual({ usesPerDayEveryone: 7, usesPerDayPerson: 2 });
      as(sara);
      const changed = await shareRoute('PATCH', app.id, saraBrick, { usesPerDayEveryone: 50, usesPerDayPerson: 5 });
      expect((await json(changed)).limits).toEqual({ usesPerDayEveryone: 50, usesPerDayPerson: 5 });
      // A later change of the starting values leaves an app already shared as its owner set it
      await setLimits({ sharedUsesEveryone: 9 });
      expect((await json(await shareRoute('GET', app.id, saraBrick))).limits.usesPerDayEveryone).toBe(50);
      expect((await shareRoute('PATCH', app.id, saraBrick, { usesPerDayEveryone: 0 })).status).toBe(400);
    });
  });

  /* --------------------------- someone else's ask --------------------------- */

  describe('someone else asking the Brick for a job', () => {
    it('is turned away while only you, as it always was, and the owner’s own chats and goals are untouched', async () => {
      const { serverId } = await music();
      expect((await ask(saraBrick, serverId, omarKey(), 'a1')).body).toMatchObject({ allowed: false, reason: 'not_owner' });
      expect((await check(saraBrick, serverId, { requesterKey: saraKey(), callId: 'o1' })).body.allowed).toBe(true);
      expect((await check(saraBrick, serverId, { forOwner: true })).body.allowed).toBe(true);
    });

    it('is allowed only for a picked job, inside its picked inputs, and says what may come back', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      const done = await ask(saraBrick, serverId, omarKey(), 'a1', { argumentNames: ['prompt', 'style'] });
      expect(done.body).toMatchObject({ allowed: true, viaConnection: true, shared: { returns: ['url'] }, paidBy: { kind: 'person', personId: sara } });
      // Not picked, not shareable, not an input that was offered, nor a tool that does not exist
      expect((await ask(saraBrick, serverId, omarKey(), 'a2', { tool: 'find_songs', argumentNames: ['query'] })).body).toMatchObject({ allowed: false, reason: 'not_shared' });
      expect((await ask(saraBrick, serverId, omarKey(), 'a3', { tool: 'delete_song', argumentNames: ['id'] })).body.reason).toBe('not_shared');
      expect((await ask(saraBrick, serverId, omarKey(), 'a4', { argumentNames: ['prompt', 'owner_email'] })).body.reason).toBe('not_shared');
      expect((await ask(saraBrick, serverId, omarKey(), 'a5', { tool: 'whatever' })).body.reason).toBe('not_shared');
      // Without what is needed to count it and to hold it to what was picked, it never runs
      expect((await check(saraBrick, serverId, { requesterKey: omarKey(), tool: 'make_song', argumentNames: [] })).body.reason).toBe('incomplete');
      expect((await check(saraBrick, serverId, { requesterKey: omarKey(), callId: 'a6', argumentNames: [] })).body.reason).toBe('incomplete');
      expect((await check(saraBrick, serverId, { requesterKey: omarKey(), callId: 'a7', tool: 'make_song' })).body.reason).toBe('incomplete');
      // Only the one try was written, none for the turned-away ones
      expect(await prisma.appShareUse.count({ where: { share: { serverId } } })).toBe(1);
    });

    it('never reaches the app another way: not through another Brick, and not once the owner’s grant or app is gone (checks 32 and 52)', async () => {
      const { app, serverId } = await music();
      const otherGrant = await grantToBrick(sara, app.id, saraOther);
      await tools((otherGrant as { id: string }).id);
      await shareSong(app.id);
      expect((await ask(saraOther, (otherGrant as { id: string }).id, omarKey(), 'b1')).body).toMatchObject({ allowed: false, reason: 'not_owner' });
      expect((await ask(saraBrick, serverId, omarKey(), 'b2')).body.allowed).toBe(true);
      expect(await removeGrant(sara, app.id, saraBrick)).toBe(true);
      expect((await ask(saraBrick, serverId, omarKey(), 'b3')).status).toBe(404);
      expect(await disconnect(sara, app.id)).toBe(true);
      expect((await ask(saraOther, (otherGrant as { id: string }).id, omarKey(), 'b4')).status).toBe(404);
      expect(await prisma.appShare.count({ where: { server: { botId: { in: [saraBrick, saraOther] } } } })).toBe(0);
    });

    it('stops a job at once when it changed, was moved to a heading that is not shared, or was un-picked', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      expect((await ask(saraBrick, serverId, omarKey(), 'c1')).body.allowed).toBe(true);
      await prisma.botMcpTool.update({ where: { serverId_name: { serverId, name: 'make_song' } }, data: { fingerprint: 'fp-changed' } });
      expect((await ask(saraBrick, serverId, omarKey(), 'c2')).body.reason).toBe('not_shared');
      as(sara);
      expect((await json(await shareRoute('GET', app.id, saraBrick))).jobs.find((job: { tool: string }) => job.tool === 'make_song')).toMatchObject({ picked: false, needsPicking: true });
      await prisma.botMcpTool.update({ where: { serverId_name: { serverId, name: 'make_song' } }, data: { fingerprint: 'fp-make', heading: 'changesThings' } });
      expect((await ask(saraBrick, serverId, omarKey(), 'c3')).body.reason).toBe('not_shared');
      await prisma.botMcpTool.update({ where: { serverId_name: { serverId, name: 'make_song' } }, data: { heading: 'makesNew', confirmedAt: null } });
      expect((await ask(saraBrick, serverId, omarKey(), 'c4')).body.reason).toBe('not_shared');
    });

    it('"Change" takes a job away at once; "Stop letting others use it" blocks every later ask, in a chat already open', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      as(sara);
      const added = await shareRoute('PATCH', app.id, saraBrick, { jobs: [{ tool: 'make_song', inputs: ['prompt', 'style'], returns: ['url'] }, { tool: 'find_songs', inputs: ['query'], returns: null }] });
      expect(added.status).toBe(200);
      expect((await ask(saraBrick, serverId, omarKey(), 'd1', { tool: 'find_songs', argumentNames: ['query'] })).body).toMatchObject({ allowed: true, shared: { returns: null } });
      await shareRoute('PATCH', app.id, saraBrick, { jobs: [{ tool: 'make_song', inputs: ['prompt'], returns: null }] });
      expect((await ask(saraBrick, serverId, omarKey(), 'd2', { tool: 'find_songs', argumentNames: ['query'] })).body.reason).toBe('not_shared');
      // Narrower inputs and returns hold at the next ask
      expect((await ask(saraBrick, serverId, omarKey(), 'd3', { argumentNames: ['prompt', 'style'] })).body.reason).toBe('not_shared');
      expect((await ask(saraBrick, serverId, omarKey(), 'd4')).body).toMatchObject({ allowed: true, shared: { returns: ['url', 'title'] } });
      expect((await shareRoute('DELETE', app.id, saraBrick)).status).toBe(204);
      expect((await ask(saraBrick, serverId, omarKey(), 'd5')).body).toMatchObject({ allowed: false, reason: 'not_owner' });
      expect(await prisma.appShareJob.count()).toBe(0);
      // What went through before the stop is in the books as it happened, and the owner can share again later
      expect(await prisma.meterEvent.count({ where: { botId: saraBrick, kind: 'app_use' } })).toBe(2);
      expect((await shareRoute('DELETE', app.id, saraBrick)).status).toBe(404);
    });

    it('writes every use to the books first, once: who asked, whose app, paid by the owner, never what was asked with (check 23)', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      expect((await ask(saraBrick, serverId, omarKey(), 'e1')).body.allowed).toBe(true);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `app:${saraBrick}:e1` } });
      expect(event).toMatchObject({ kind: 'app_use', personKey: `person:${omar}`, personId: omar, botId: saraBrick, brick: true, payerKind: 'person', payerPersonId: sara, basis: 'paid_by_other', route: 'app', unit: 'use' });
      expect(event.costMicros).toBeNull();
      expect(event.detail).toEqual({ shared: true, tool: 'make_song' });
      // The owner's own chat is the owner's: it counts nothing for the share
      await check(saraBrick, serverId, { requesterKey: saraKey(), callId: 'e2' });
      expect(await prisma.appShareUse.count({ where: { share: { serverId } } })).toBe(1);
    });

    it('never runs a job twice for one call id, however often it is sent, and turns a loop of repeats away (check 31)', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      expect((await ask(saraBrick, serverId, omarKey(), 'f1')).body.allowed).toBe(true);
      const again = await ask(saraBrick, serverId, omarKey(), 'f1');
      expect(again.body).toMatchObject({ allowed: false, reason: 'already_asked', earlier: 'running' });
      expect((await ask(saraBrick, serverId, omarKey(), 'f1')).body.reason).toBe('already_asked');
      // The third repeat is past the two allowed
      expect((await ask(saraBrick, serverId, omarKey(), 'f1')).body.reason).toBe('busy');
      expect(await prisma.appShareUse.count({ where: { share: { serverId } } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { eventId: `app:${saraBrick}:f1` } })).toBe(1);
    });
  });

  /* ------------------------------- the two limits ------------------------------- */

  describe('uses a day', () => {
    it('holds for each person, and tells the asker when it is back', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayPerson: 2 });
      expect((await ask(saraBrick, serverId, omarKey(), 'g1')).body.allowed).toBe(true);
      expect((await ask(saraBrick, serverId, omarKey(), 'g2')).body.allowed).toBe(true);
      const third = await ask(saraBrick, serverId, omarKey(), 'g3');
      expect(third.body).toMatchObject({ allowed: false, reason: 'limit_reached' });
      expect(new Date(third.body.resetsAt).getUTCHours()).toBe(0);
      expect(new Date(third.body.resetsAt).getTime()).toBeGreaterThan(Date.now());
      // Someone else still has theirs, and the owner’s own chats never count
      expect((await ask(saraBrick, serverId, `lena-${tag}`, 'g4')).body.allowed).toBe(true);
      expect((await check(saraBrick, serverId, { requesterKey: saraKey(), callId: 'g5' })).body.allowed).toBe(true);
      // One person's limit is no note to the owner: only the day's limit for everyone is
      expect(await prisma.userNotice.count({ where: { userId: sara, kind: 'app-share-limit' } })).toBe(0);
    });

    it('holds for everyone together, also for a guest who starts a new session, and the owner is told once, never once per person', async () => {
      await setLimits({ sharedJobsAtOnce: 50 });
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 3, usesPerDayPerson: 3 });
      // Guests carry the id of their session: a new session is a new id, so each has their own three, and the three for everyone hold
      expect((await ask(saraBrick, serverId, 'guest-session-1', 'h1')).body.allowed).toBe(true);
      expect((await ask(saraBrick, serverId, 'guest-session-2', 'h2')).body.allowed).toBe(true);
      expect((await ask(saraBrick, serverId, 'guest-session-3', 'h3')).body.allowed).toBe(true);
      for (const who of ['guest-session-4', omarKey(), `lena-${tag}`]) {
        expect((await ask(saraBrick, serverId, who, `h-${who}`)).body).toMatchObject({ allowed: false, reason: 'limit_reached' });
      }
      const notes = await prisma.userNotice.findMany({ where: { userId: sara, kind: 'app-share-limit' } });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ title: expect.stringContaining('used up today'), body: expect.stringContaining('change the limit') });
      expect(notes[0].data).toEqual({ connectionId: app.id, botId: saraBrick, serverId });
      // Never the owner's account in what the asker is told
      const turned = await ask(saraBrick, serverId, 'guest-session-5', 'h-last');
      expect(JSON.stringify(turned.body)).not.toContain(sara);
    });

    it('lets two last uses at the same moment run only once', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 1, usesPerDayPerson: 1 });
      const answers = await Promise.all([ask(saraBrick, serverId, omarKey(), 'i1'), ask(saraBrick, serverId, `lena-${tag}`, 'i2'), ask(saraBrick, serverId, 'guest-x', 'i3')]);
      expect(answers.filter((answer) => answer.body.allowed)).toHaveLength(1);
      expect(answers.filter((answer) => answer.body.reason === 'limit_reached' || answer.body.reason === 'busy')).toHaveLength(2);
      expect(await prisma.appShareUse.count({ where: { share: { serverId } } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { botId: saraBrick, kind: 'app_use' } })).toBe(1);
    });

    it('is not used up by days gone by: only today’s uses count', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 1, usesPerDayPerson: 1 });
      expect((await ask(saraBrick, serverId, omarKey(), 'j1')).body.allowed).toBe(true);
      await prisma.appShareUse.updateMany({ where: { share: { serverId } }, data: { createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000) } });
      expect((await ask(saraBrick, serverId, omarKey(), 'j2')).body.allowed).toBe(true);
    });
  });

  /* ------------------- failures, refunds and the quiet ceilings ------------------- */

  describe('a try that fails', () => {
    it('gives the use back only once the failure is confirmed, and its cost stays in the books (check 31)', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 1, usesPerDayPerson: 1 });
      expect((await ask(saraBrick, serverId, omarKey(), 'k1')).body.allowed).toBe(true);
      // A timeout is no refund by itself: the try is still counted, and the same call is never run again
      expect((await settle(saraBrick, serverId, 'k1', 'unknown')).body).toEqual({ status: 'unknown' });
      expect((await ask(saraBrick, serverId, omarKey(), 'k2')).body.reason).toBe('limit_reached');
      expect((await ask(saraBrick, serverId, omarKey(), 'k1')).body).toMatchObject({ allowed: false, reason: 'already_asked', earlier: 'unknown' });
      // Then it is looked up and confirmed failed: now it is given back
      expect((await settle(saraBrick, serverId, 'k1', 'failed')).body).toEqual({ status: 'refunded' });
      expect((await ask(saraBrick, serverId, omarKey(), 'k3')).body.allowed).toBe(true);
      // What the failed try cost is still recorded
      expect(await prisma.meterEvent.count({ where: { eventId: `app:${saraBrick}:k1` } })).toBe(1);
      // The same call that failed is still never run again
      expect((await ask(saraBrick, serverId, omarKey(), 'k1')).body.reason).toBe('already_asked');
      // Settling again says the same
      expect((await settle(saraBrick, serverId, 'k1', 'failed')).body).toEqual({ status: 'refunded' });
    });

    it('cannot be given back once it finished, and one given back cannot finish', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      await ask(saraBrick, serverId, omarKey(), 'l1');
      await ask(saraBrick, serverId, omarKey(), 'l2');
      expect((await settle(saraBrick, serverId, 'l1', 'done')).body).toEqual({ status: 'done' });
      expect((await settle(saraBrick, serverId, 'l1', 'failed')).status).toBe(409);
      expect((await settle(saraBrick, serverId, 'l1', 'unknown')).body).toEqual({ status: 'done' });
      await settle(saraBrick, serverId, 'l2', 'failed');
      expect((await settle(saraBrick, serverId, 'l2', 'done')).status).toBe(409);
      expect((await settle(saraBrick, serverId, 'nope', 'done')).status).toBe(404);
    });

    it('is settled only by the bot server, and only for the Brick it asked about', async () => {
      const { app, serverId } = await music();
      await shareSong(app.id);
      await ask(saraBrick, serverId, omarKey(), 'm1');
      expect((await settle(saraBrick, serverId, 'm1', 'failed', null)).status).toBe(401);
      expect((await settle(saraBrick, serverId, 'm1', 'failed', 'wrong-token')).status).toBe(401);
      expect((await settle(saraOther, serverId, 'm1', 'failed')).status).toBe(404);
      expect(await prisma.appShareUse.count({ where: { share: { serverId }, status: 'running' } })).toBe(1);
    });

    it('counts as a try for the quiet ceiling in an hour even when it was given back, so endless failures show', async () => {
      await setLimits({ sharedTriesPerHour: 3 });
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 100, usesPerDayPerson: 100 });
      for (const id of ['n1', 'n2', 'n3']) {
        expect((await ask(saraBrick, serverId, omarKey(), id)).body.allowed).toBe(true);
        await settle(saraBrick, serverId, id, 'failed');
      }
      expect((await ask(saraBrick, serverId, omarKey(), 'n4')).body).toMatchObject({ allowed: false, reason: 'busy' });
      await prisma.appShareUse.updateMany({ where: { share: { serverId } }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
      expect((await ask(saraBrick, serverId, omarKey(), 'n5')).body.allowed).toBe(true);
    });

    it('holds the jobs at once to a ceiling, frees the place when the job is settled, and lets a job nobody settled stop holding it', async () => {
      await setLimits({ sharedJobsAtOnce: 2 });
      const { app, serverId } = await music();
      await shareSong(app.id, saraBrick, { usesPerDayEveryone: 100, usesPerDayPerson: 100 });
      expect((await ask(saraBrick, serverId, omarKey(), 'p1')).body.allowed).toBe(true);
      expect((await ask(saraBrick, serverId, `lena-${tag}`, 'p2')).body.allowed).toBe(true);
      expect((await ask(saraBrick, serverId, 'guest-q', 'p3')).body).toMatchObject({ allowed: false, reason: 'busy' });
      await settle(saraBrick, serverId, 'p1', 'done');
      expect((await ask(saraBrick, serverId, 'guest-q', 'p4')).body.allowed).toBe(true);
      // A job nobody ever settled stops holding a place after the minutes set, and still counts as a use
      await prisma.appShareUse.updateMany({ where: { share: { serverId }, status: 'running' }, data: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } });
      expect((await ask(saraBrick, serverId, omarKey(), 'p5')).body.allowed).toBe(true);
      expect(await prisma.appShareUse.count({ where: { share: { serverId }, status: { not: 'refunded' } } })).toBe(4);
    });
  });
});
