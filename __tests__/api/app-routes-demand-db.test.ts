/**
 * "Where an App runs" and "Apps: use and demand" (spec "Paying for Apps", sections 21 and 22; acceptance tests 15 and 16), against
 * a real database and a FAKE adapter. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type LinkAnswer, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { setOwnVersionsForTests, type OwnAppVersion } from '@/lib/app-routes/own-versions';
import { recordMeterEvent, saveMeterSettings } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';
import { GET as demandGet } from '@/app/api/admin/apps-demand/route';
import { PUT as routePut } from '@/app/api/admin/app-routes/[appKey]/route';
import { POST as asked } from '@/app/api/apps/asked/route';
import { POST as connectReadyMadeApp } from '@/app/api/me/apps/ready-made/route';
import { POST as useApp } from '@/app/api/ready-made/use/route';
import { POST as linkApp } from '@/app/api/ready-made/link/route';
import { grantToBrick } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';
import { demandReport } from '@/lib/app-demand';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEY = `gmail-${tag}`;
const OTHER = `notion-${tag}`;
const SERVICE_TOKEN = `service-${tag}`;
const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY };

const fake = () =>
  ({
    startConnect: jest.fn(async () => ({ redirectUrl: 'https://connect.example/sign-in', providerAccountId: `ca_${tag}`, expiresAt: null })),
    connectionStatus: jest.fn(async (): Promise<'active' | 'pending' | 'failed'> => 'active'),
    appLink: jest.fn(async () => ({ url: `https://mcp.example/${tag}/mcp` })),
    callLink: jest.fn(async (): Promise<LinkAnswer> => ({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' })),
    use: jest.fn(async () => ({ ok: true, data: { from: 'composio' }, error: null, providerCallId: 'log_1' })),
  }) satisfies ReadyMadeAdapter;

const TOP = 120;
const ownVersion = (over: Partial<OwnAppVersion> = {}) => {
  const own: OwnAppVersion & { use: jest.Mock } = {
    key: KEY,
    passedChecksOn: '2026-11-12',
    checks: { sameInputsAndOutputs: true, failureAndTimeout: true, permissionAndAccountRules: true },
    topPriceMicros: TOP,
    tools: () => [{ name: 'GMAIL_FETCH_EMAILS', description: 'Read mail' }],
    use: jest.fn(async () => ({ ok: true, data: { from: 'universe' }, error: null, providerCallId: null })),
    ...over,
  } as OwnAppVersion & { use: jest.Mock };
  return own;
};

run('where an App runs, and Apps: use and demand, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });
  beforeEach(async () => {
    // Paid use of an App is held against two Limits (lib/app-use-cap.ts): other suites change the shared meter setting, so this suite states its own
    await saveMeterSettings({ appUseCeilingMicros: 1_000_000_000, appUseMemberCeilingMicros: 1_000_000_000 }, boss);
  });
  afterEach(async () => {
    setAdapterForTests(undefined);
    setOwnVersionsForTests(undefined);
    mockUser.current = null;
    await prisma.appUseOutcome.deleteMany({ where: { appKey: { in: [KEY, OTHER] } } });
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.appRoute.deleteMany({ where: { appKey: { in: [KEY, OTHER] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appAsk.deleteMany({ where: { nameKey: { contains: tag } } });
    await prisma.appSetting.deleteMany({ where: { key: { in: ['ready-made-apps', 'composio-billing', 'composio-invoices'] } } });
  });
  afterAll(async () => {
    if (envBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN; else process.env.BOT_SERVICE_TOKEN = envBefore.service;
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = envBefore.key;
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  const asBoss = () => (mockUser.current = { id: boss, email: 'boss@example.test' });
  const list = () => saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: true }, [OTHER]: { name: 'Notion', enabled: true } } }, boss);
  const useIt = (serverId: string, callId = `call-${randomUUID()}`) =>
    useApp(request('/api/ready-made/use', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, tool: 'GMAIL_FETCH_EMAILS', arguments: { n: 1 }, callId } }));
  const move = (route: string, expectedVersion: number, key = KEY) => routePut(request(`/api/admin/app-routes/${key}`, { method: 'PUT', body: { route, expectedVersion } }), params({ appKey: key }));
  const demand = async (days = 30) => (await (await demandGet(request(`/api/admin/apps-demand?days=${days}`))).json()) as Awaited<ReturnType<typeof demandReport>>;
  const row = async () => (await demand()).apps.find((app) => app.key === KEY)!;

  async function connectedAndGranted() {
    const adapter = fake();
    setAdapterForTests(adapter);
    await list();
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    const made = await (await connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: KEY } }))).json();
    const grant = await grantToBrick(sara, made.id, saraBrick);
    return { adapter, serverId: (grant as { id: string }).id };
  }

  describe('the route of an App (test 15)', () => {
    it('is Composio for an App never moved, and a move is for a super admin only', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      expect((await move('universe', 0)).status).toBe(403);
      expect((await demandGet(request('/api/admin/apps-demand'))).status).toBe(403);
      const answer = await useIt(serverId);
      expect(answer.status).toBe(200);
      expect(adapter.use).toHaveBeenCalledTimes(1);
      const event = await prisma.meterEvent.findFirstOrThrow({ where: { personId: sara, kind: 'app_use' } });
      expect((event.detail as { provider: string }).provider).toBe('composio');
      asBoss();
      expect((await row()).route).toBe('composio');
    });

    it('cannot move to our own version until there is one that passed its checks, and says what is missing', async () => {
      await connectedAndGranted();
      asBoss();
      const none = await move('universe', 0);
      expect(none.status).toBe(409);
      expect((await none.json()).code).toBe('not_ready');
      expect((await row()).route).toBe('composio');
      setOwnVersionsForTests({ [KEY]: ownVersion({ checks: { sameInputsAndOutputs: true, failureAndTimeout: false, permissionAndAccountRules: true } }) });
      const partly = await move('universe', 0);
      expect(partly.status).toBe(409);
      expect((await partly.json()).why).toEqual(['It has not passed failure and timeout handling.']);
      setOwnVersionsForTests({ [KEY]: ownVersion({ topPriceMicros: null }) });
      expect((await (await move('universe', 0)).json()).why).toEqual(['It has no top price.']);
      expect((await move('universe', 0, `nothing-${tag}`)).status).toBe(404);
      expect(await prisma.appRoute.count({ where: { appKey: KEY } })).toBe(0);
    });

    it('moves new runs to our own version with the same list price for people, finishes a run already going where it started, and moves back in one step', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      const own = ownVersion();
      setOwnVersionsForTests({ [KEY]: own });
      asBoss();

      // A run that is already going on Composio when the move is made
      let release: () => void = () => undefined;
      adapter.use.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { ok: true, data: { from: 'composio' }, error: null, providerCallId: 'slow' };
      });
      const going = useIt(serverId, 'going');
      for (let i = 0; i < 100 && adapter.use.mock.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(adapter.use).toHaveBeenCalledTimes(1);

      const moved = await move('universe', 0);
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({ route: 'universe', version: 1 });
      release();
      expect((await going).status).toBe(200);
      const first = await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `app:${saraBrick}:going` } });
      expect((first.detail as { provider: string }).provider).toBe('composio');
      expect(own.use).not.toHaveBeenCalled();

      // The next run goes to our own version, never to Composio
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      const next = await useIt(serverId, 'next');
      expect(next.status).toBe(200);
      expect((await next.json()).data).toEqual({ from: 'universe' });
      expect(own.use).toHaveBeenCalledTimes(1);
      expect(adapter.use).toHaveBeenCalledTimes(1);
      const second = await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `app:${saraBrick}:next` } });
      const a = first.detail as { provider: string; listMicros: number; tier: string };
      const b = second.detail as { provider: string; listMicros: number; tier: string };
      expect(b.provider).toBe('universe');
      // What a person is priced from is the same on both routes; only what it cost us moved, to our own top price
      expect(b.listMicros).toBe(a.listMicros);
      expect(b.tier).toBe(a.tier);
      expect(Number(second.costMicros)).toBe(TOP);
      expect(Number(first.costMicros)).not.toBe(TOP);
      expect(second.payerKind).toBe('universe');

      // A retry of a call that was already made runs nothing and charges nothing, on either route
      expect((await useIt(serverId, 'next')).status).toBe(409);
      expect((await useIt(serverId, 'going')).status).toBe(409);
      expect(own.use).toHaveBeenCalledTimes(1);
      expect(adapter.use).toHaveBeenCalledTimes(1);
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(2);

      // Back to Composio, one step
      asBoss();
      expect((await move('composio', 1)).status).toBe(200);
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      expect((await useIt(serverId, 'back')).status).toBe(200);
      expect(adapter.use).toHaveBeenCalledTimes(2);
      expect(own.use).toHaveBeenCalledTimes(1);
    });

    it('refuses a save made on an older view, and saving the route an App already has changes nothing', async () => {
      setOwnVersionsForTests({ [KEY]: ownVersion() });
      await list();
      asBoss();
      expect((await move('universe', 0)).status).toBe(200);
      const stale = await move('composio', 0);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'stale', route: 'universe', version: 1 });
      expect((await move('universe', 1)).status).toBe(200);
      expect((await prisma.appRoute.findUniqueOrThrow({ where: { appKey: KEY } })).version).toBe(1);
    });

    it('lets an App that has left the list be moved back to Composio, but not moved onto our own version', async () => {
      setOwnVersionsForTests({ [KEY]: ownVersion() });
      await list();
      asBoss();
      expect((await move('universe', 0)).status).toBe(200);
      // The App leaves the list
      await prisma.appSetting.upsert({ where: { key: 'ready-made-apps' }, create: { key: 'ready-made-apps', value: { apps: { [KEY]: null } }, updatedById: boss }, update: { value: { apps: { [KEY]: null } }, updatedById: boss } });
      expect((await move('universe', 1)).status).toBe(404);
      expect((await move('composio', 1)).status).toBe(200);
      expect((await prisma.appRoute.findUniqueOrThrow({ where: { appKey: KEY } })).route).toBe('composio');
      // An App that was never moved and is not on the list is still not found
      expect((await move('composio', 0, `nothing-${tag}`)).status).toBe(404);
    });

    it('never runs on Composio when our own version is gone: the run is refused, nothing is called and nothing is written', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      setOwnVersionsForTests({ [KEY]: ownVersion() });
      asBoss();
      await move('universe', 0);
      setOwnVersionsForTests({});
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      const answer = await useIt(serverId, 'gone');
      expect(answer.status).toBe(502);
      expect(adapter.use).not.toHaveBeenCalled();
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
    });

    it('records a failure on our own version as failed, and does not retry it on Composio', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      const own = ownVersion({ use: jest.fn(async () => ({ ok: false, data: null, error: 'boom', providerCallId: null })) });
      setOwnVersionsForTests({ [KEY]: own });
      asBoss();
      await move('universe', 0);
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      expect((await (await useIt(serverId, 'bad')).json()).ok).toBe(false);
      expect(adapter.use).not.toHaveBeenCalled();
      const outcome = await prisma.appUseOutcome.findUniqueOrThrow({ where: { eventId: `app:${saraBrick}:bad` } });
      expect(outcome).toMatchObject({ appKey: KEY, provider: 'universe', outcome: 'failed', refundedMicros: null });
      asBoss();
      const app = await row();
      expect(app).toMatchObject({ ended: 1, failed: 1, allFailedRefunded: false, refundedMicros: null });
    });

    it('answers the link itself on our own version: no message reaches Composio', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      const own = ownVersion();
      setOwnVersionsForTests({ [KEY]: own });
      asBoss();
      await move('universe', 0);
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      const send = (message: Record<string, unknown>, callId?: string) =>
        linkApp(request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, message, ...(callId ? { callId } : {}) } }));
      const listed = await (await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
      // Our own version keeps no session, so it hands out no session id that could be replayed to Composio after a move back
      expect(listed.sessionId).toBeNull();
      expect(JSON.parse(listed.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['GMAIL_FETCH_EMAILS']);
      const called = await (await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'GMAIL_FETCH_EMAILS', arguments: { n: 1 } } }, 'link-1')).json();
      expect(JSON.parse(called.body).result.isError).toBe(false);
      expect(own.use).toHaveBeenCalledTimes(1);
      expect(adapter.callLink).not.toHaveBeenCalled();
      const event = await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `app:${saraBrick}:link-1` } });
      expect((event.detail as { provider: string }).provider).toBe('universe');
      expect(Number(event.costMicros)).toBe(TOP);
    });
  });

  it('records a failed run when a progress message comes before the error in a stream, for a text request id', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    adapter.callLink.mockImplementationOnce(async () => ({
      status: 200,
      contentType: 'text/event-stream',
      sessionId: 'mcp-1',
      body: ['data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}', 'data: {"jsonrpc":"2.0","id":"mail-1","error":{"code":-32000,"message":"refused"}}', ''].join('\n'),
    }));
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    const response = await linkApp(
      request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, callId: 'link-text-id', message: { jsonrpc: '2.0', id: 'mail-1', method: 'tools/call', params: { name: 'GMAIL_FETCH_EMAILS', arguments: {} } } } }),
    );
    expect(response.status).toBe(200);
    expect(await prisma.appUseOutcome.findUniqueOrThrow({ where: { eventId: `app:${saraBrick}:link-text-id` } })).toMatchObject({ outcome: 'failed' });
  });

  describe('Apps: use and demand (test 16)', () => {
    const event = (id: string, who: string, over: { quantity?: number; cost?: number | null; toolkit?: string; at?: Date; provider?: string } = {}) =>
      recordMeterEvent({
        eventId: `demand-${tag}-${id}`,
        kind: 'app_use',
        pool: 'chat',
        occurredAt: over.at ?? new Date(),
        personKey: personKeyOf({ personId: who }),
        personId: who,
        botId: saraBrick,
        brick: true,
        payerKind: 'universe',
        payerPersonId: null,
        route: 'app',
        jobId: null,
        quantity: over.quantity ?? 1,
        unit: 'use',
        costMicros: over.cost === undefined ? 500 : over.cost,
        basis: 'estimated',
        sourceRef: null,
        detail: { toolkit: over.toolkit ?? KEY, provider: over.provider ?? 'composio' },
      });

    it('counts uses, people, cost and failures exactly as the ledger has them, leaving free lookups and old days out', async () => {
      await list();
      asBoss();
      const before = await demand();
      await event('a', sara, { quantity: 2, cost: 1000 });
      await event('b', sara, { cost: 500 });
      await event('c', omar, { cost: null });
      await event('free', omar, { quantity: 0, cost: 0 });
      await event('old', omar, { at: new Date(Date.now() - 45 * 86400000), cost: 9_000_000 });
      await event('other', omar, { toolkit: OTHER, cost: 2000 });
      await prisma.appUseOutcome.createMany({
        data: [
          { eventId: `demand-${tag}-a`, appKey: KEY, provider: 'composio', outcome: 'ok' },
          { eventId: `demand-${tag}-b`, appKey: KEY, provider: 'composio', outcome: 'failed' },
        ],
      });
      const after = await demand();
      const gmail = after.apps.find((app) => app.key === KEY)!;
      expect(gmail).toMatchObject({ name: 'Gmail', uses: 4, people: 2, costMicros: 1500, unpriced: 1, ended: 2, failed: 1, kind: 'own', route: 'composio' });
      expect(gmail.byRoute.composio).toEqual({ uses: 4, costMicros: 1500, unpriced: 1 });
      const notion = after.apps.find((app) => app.key === OTHER)!;
      expect(notion).toMatchObject({ name: 'Notion', uses: 1, people: 1, costMicros: 2000 });
      // Sorted by what it costs us
      expect(after.apps.findIndex((app) => app.key === OTHER)).toBeLessThan(after.apps.findIndex((app) => app.key === KEY));
      // The totals moved by exactly what was written: uses 5, cost 3500 (the free lookup and the 45-day-old event are out)
      expect(after.totals.uses - before.totals.uses).toBe(5);
      expect(after.totals.costMicros - before.totals.costMicros).toBe(3500);
      // A longer range brings the old day in
      expect((await demand(60)).totals.costMicros - before.totals.costMicros).toBeGreaterThanOrEqual(9_003_500);
    });

    it('says a failed run was refunded only when a refund is recorded for every failed run', async () => {
      await list();
      await event('f1', sara);
      await event('f2', sara);
      await prisma.appUseOutcome.createMany({
        data: [
          { eventId: `demand-${tag}-f1`, appKey: KEY, provider: 'composio', outcome: 'failed', refundedMicros: BigInt(400) },
          { eventId: `demand-${tag}-f2`, appKey: KEY, provider: 'composio', outcome: 'failed' },
        ],
      });
      asBoss();
      expect(await row()).toMatchObject({ failed: 2, allFailedRefunded: false, refundedMicros: null });
      await prisma.appUseOutcome.update({ where: { eventId: `demand-${tag}-f2` }, data: { refundedMicros: BigInt(300) } });
      expect(await row()).toMatchObject({ failed: 2, allFailedRefunded: true, refundedMicros: 700 });
    });

    it('lists an App with no use yet so it can still be moved, only while Apps are on', async () => {
      await list();
      asBoss();
      setAdapterForTests(fake());
      expect((await demand()).apps.find((app) => app.key === OTHER)).toMatchObject({ uses: 0, costMicros: null });
      setAdapterForTests(null);
      expect((await demand()).apps.find((app) => app.key === OTHER)).toBeUndefined();
    });

    it('rejects a days value it cannot use', async () => {
      asBoss();
      for (const days of ['0', '400', 'x', '1.5']) expect((await demandGet(request(`/api/admin/apps-demand?days=${days}`))).status).toBe(400);
    });
  });

  describe('asked for, not available yet', () => {
    const ask = (name: string, who: string, token: string | null = SERVICE_TOKEN) =>
      asked(request('/api/apps/asked', { method: 'POST', ...(token ? { token } : {}), body: { name, requesterKey: `person:${who}` } }));

    it('is for the bot server only', async () => {
      expect((await ask(`Talabat ${tag}`, sara, null)).status).toBe(401);
      expect((await ask(`Talabat ${tag}`, sara, 'wrong')).status).toBe(401);
    });

    it('counts only the App name, times and different people, and shows nothing else', async () => {
      await list();
      expect(await (await ask(`Talabat orders ${tag}`, sara)).json()).toEqual({ counted: true });
      await ask(`talabat  ORDERS ${tag}`, sara);
      await ask(`Talabat orders ${tag}`, omar);
      await ask(`Boubyan ${tag}`, omar);
      asBoss();
      const report = await demand();
      const talabat = report.asked.find((item) => item.name.toLowerCase().startsWith('talabat orders') && item.name.includes(tag));
      expect(talabat).toEqual({ name: `Talabat orders ${tag}`, times: 3, people: 2 });
      expect(report.asked.find((item) => item.name === `Boubyan ${tag}`)).toEqual({ name: `Boubyan ${tag}`, times: 1, people: 1 });
      // Only a hash of the person is kept, never their id
      const rows = await prisma.appAsk.findMany({ where: { nameKey: { contains: tag } } });
      expect(rows.length).toBe(3);
      expect(JSON.stringify(rows)).not.toContain(sara);
      expect(JSON.stringify(rows)).not.toContain(omar);
      // And the report itself carries nothing per person
      expect(JSON.stringify(report.asked)).not.toContain(sara);
    });

    it('does not keep what people wrote: a sentence, a link or an email is not an App name', async () => {
      for (const text of ['Can you please connect my bank account and tell me the balance', 'https://example.com/pay', 'sara@example.com', 'a', '', 'what is my balance?']) {
        expect(await (await ask(text, sara)).json()).toEqual({ counted: false, reason: 'not_a_name' });
      }
      expect(await prisma.appAsk.count({ where: { personKey: { not: '' }, name: { in: ['https://example.com/pay', 'sara@example.com'] } } })).toBe(0);
    });

    it('never fails on a name whose lower case is longer, and groups one App typed in different cases and accents', async () => {
      expect(await (await ask('İ'.repeat(60), sara)).json()).toEqual({ counted: true });
      await prisma.appAsk.deleteMany({ where: { nameKey: 'i'.repeat(60) } });
      expect(await (await ask(`Café ${tag}`, sara)).json()).toEqual({ counted: true });
      await ask(`CAFÉ ${tag}`, omar);
      await ask(`cafe ${tag}`, omar);
      asBoss();
      const row = (await demand()).asked.find((item) => item.name.toLowerCase().includes(`caf`) && item.name.includes(tag));
      expect(row).toMatchObject({ times: 3, people: 2 });
      expect(await prisma.appAsk.count({ where: { nameKey: `cafe ${tag}` } })).toBe(2);
    });

    it('does not count an App that is on the list under an accented name', async () => {
      const entry = await prisma.appCatalogEntry.create({ data: { key: `coffee-shop-${tag}`, name: `Café Shop ${tag}`, blurb: 'Coffee', serverUrl: 'https://mcp.example/coffee', enabled: true } });
      try {
        expect(await (await ask(`Cafe Shop ${tag}`, sara)).json()).toEqual({ counted: false, reason: 'exists' });
        expect(await (await ask(`CAFÉ SHOP ${tag}`, sara)).json()).toEqual({ counted: false, reason: 'exists' });
      } finally {
        await prisma.appCatalogEntry.delete({ where: { id: entry.id } });
      }
    });

    it('does not count an App that is already there', async () => {
      await list();
      expect(await (await ask('Notion', sara)).json()).toEqual({ counted: false, reason: 'exists' });
      expect(await (await ask('Gmail', sara)).json()).toEqual({ counted: false, reason: 'exists' });
    });

    it('stops one person pumping a name: a daily limit per App and per person', async () => {
      let counted = 0;
      for (let i = 0; i < 30; i += 1) if ((await (await ask(`Pump ${tag}`, sara)).json()).counted) counted += 1;
      expect(counted).toBe(25);
      const rows = await prisma.appAsk.findMany({ where: { nameKey: `pump ${tag}` } });
      expect(rows.reduce((sum, item) => sum + item.times, 0)).toBe(25);
    });
  });
});
