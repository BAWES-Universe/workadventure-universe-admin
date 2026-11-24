/**
 * Pause now, for each paid capability on its own (Instant Apps, Apps, computers), against a real database with a FAKE adapter and the
 * PRETEND computer provider. A paused one refuses NEW work (kindly, before anything is counted or sent) and keeps what is made; work
 * going finishes; only a super admin pauses and resumes. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY
 * database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type LinkAnswer, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { POST as connectReadyMadeApp } from '@/app/api/me/apps/ready-made/route';
import { POST as useApp } from '@/app/api/ready-made/use/route';
import { POST as linkApp } from '@/app/api/ready-made/link/route';
import { POST as askUseCheck } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/route';
import { GET as pauseGet, POST as pausePost } from '@/app/api/admin/capability-pause/route';
import { grantToBrick } from '@/lib/app-connections';
import { saveMeterSettings } from '@/lib/meter';
import { createBrick } from '@/lib/brick-create';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, isWindingDown, startJob, startWindDown, sweepComputers } from '@/lib/computer';
import { computerReadiness } from '@/lib/computer-readiness';
import { getInstantPause, pauseInstant } from '@/lib/instant/state';
import { getCapabilityPause } from '@/lib/capability-pause';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEY = `gmail-${tag}`;
const SERVICE_TOKEN = `service-${tag}`;
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = '';
let boss = '';
let saraBrick = '';
let provider: FakeComputerProvider;
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY, computer: process.env.COMPUTER_PROVIDER };

const fake = () =>
  ({
    startConnect: jest.fn(async () => ({ redirectUrl: 'https://connect.example/sign-in', providerAccountId: `ca_${tag}`, expiresAt: null })),
    connectionStatus: jest.fn(async (): Promise<'active' | 'pending' | 'failed'> => 'active'),
    appLink: jest.fn(async () => ({ url: `https://mcp.example/${tag}/mcp` })),
    callLink: jest.fn(async (): Promise<LinkAnswer> => ({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' })),
    use: jest.fn(async () => ({ ok: true, data: { free: ['10:00'] }, error: null, providerCallId: 'log_1' })),
  }) satisfies ReadyMadeAdapter;

const asBoss = () => (mockUser.current = { id: boss, email: 'boss@example.test' });
const asSara = () => (mockUser.current = { id: sara, email: `sara-${tag}@example.test` });
const command = (capability: string, action: string) => pausePost(request('/api/admin/capability-pause', { method: 'POST', body: { capability, action } }));

run('pausing each capability on its own, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.COMPUTER_PROVIDER = 'fake';
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });
  beforeEach(async () => {
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, appUseCeilingMicros: 100_000_000, appUseMemberCeilingMicros: 50_000_000 }, 'admin');
  });
  afterEach(async () => {
    setAdapterForTests(undefined);
    mockUser.current = null;
    await prisma.computerJob.deleteMany({ where: { personId: sara } });
    await prisma.brickComputer.deleteMany({ where: { botId: saraBrick } });
    await prisma.meterEvent.deleteMany({ where: { personId: sara } });
    await prisma.meterReservation.deleteMany({});
    await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
    await prisma.appSetting.deleteMany({ where: { key: { in: ['ready-made-apps', 'apps-pause', 'computer-pause', 'computer-wind-down', 'instant-state', 'meter'] } } });
  });
  afterAll(async () => {
    setComputerProviderForTests(null);
    if (envBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN; else process.env.BOT_SERVICE_TOKEN = envBefore.service;
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = envBefore.key;
    if (envBefore.computer === undefined) delete process.env.COMPUTER_PROVIDER; else process.env.COMPUTER_PROVIDER = envBefore.computer;
    await prisma.user.deleteMany({ where: { id: { in: [sara, boss] } } });
    await prisma.$disconnect();
  });

  describe('the command', () => {
    it('is for super admins only: nobody else can pause, resume or read it, and nothing changes', async () => {
      for (const user of [null, { id: sara, email: `sara-${tag}@example.test` }, { id: sara, email: null }]) {
        mockUser.current = user;
        expect((await command('apps', 'pause')).status).toBe(403);
        expect((await command('computers', 'resume')).status).toBe(403);
        expect((await pauseGet(request('/api/admin/capability-pause'))).status).toBe(403);
      }
      expect((await getCapabilityPause('apps')).paused).toBe(false);
    });

    it('refuses anything it was not told clearly, and changes nothing', async () => {
      asBoss();
      expect((await command('everything', 'pause')).status).toBe(400);
      expect((await command('apps', 'stop')).status).toBe(400);
      expect((await pausePost(request('/api/admin/capability-pause', { method: 'POST', body: {} }))).status).toBe(400);
      expect((await getCapabilityPause('apps')).paused).toBe(false);
    });

    it('pauses and resumes each one on its own, at once, and says where each stands', async () => {
      asBoss();
      const stands = async () => Object.fromEntries(((await (await pauseGet(request('/api/admin/capability-pause'))).json()).capabilities as { key: string; paused: boolean }[]).map((row) => [row.key, row.paused]));
      expect(await stands()).toEqual({ instant: false, apps: false, computers: false });
      expect((await command('apps', 'pause')).status).toBe(200);
      expect(await stands()).toEqual({ instant: false, apps: true, computers: false });
      await command('computers', 'pause');
      await command('instant', 'pause');
      expect(await stands()).toEqual({ instant: true, apps: true, computers: true });
      await command('apps', 'resume');
      expect(await stands()).toEqual({ instant: true, apps: false, computers: true });
      await command('instant', 'resume');
      await command('computers', 'resume');
      expect(await stands()).toEqual({ instant: false, apps: false, computers: false });
      // Asked twice it is the same
      await command('apps', 'resume');
      expect(await stands()).toEqual({ instant: false, apps: false, computers: false });
    });

    it('says in words when Instant paused itself, and one resume answers both', async () => {
      await pauseInstant('failure_rate');
      asBoss();
      const row = ((await (await pauseGet(request('/api/admin/capability-pause'))).json()).capabilities as { key: string; paused: boolean; reason: string; words: string }[]).find((one) => one.key === 'instant');
      expect(row).toMatchObject({ paused: true, reason: 'failure_rate', words: 'Paused by itself: too many runs failed' });
      await command('instant', 'resume');
      expect((await getInstantPause()).paused).toBe(false);
    });
  });

  describe('Apps', () => {
    const list = () => saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: true } } }, boss);
    async function granted() {
      const adapter = fake();
      setAdapterForTests(adapter);
      await list();
      asSara();
      const made = await (await connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: KEY } }))).json();
      const grant = (await grantToBrick(sara, made.id, saraBrick)) as { id: string };
      mockUser.current = null;
      return { adapter, serverId: grant.id };
    }
    const check = (serverId: string, callId: string) => askUseCheck(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/use`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}`, callId } }), params({ id: saraBrick, serverId }));
    const useIt = (serverId: string) => useApp(request('/api/ready-made/use', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, tool: 'GMAIL_FETCH_EMAILS', arguments: {}, callId: `call-${randomUUID()}` } }));
    const link = (serverId: string, message: Record<string, unknown>, callId?: string) => linkApp(request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, message, ...(callId ? { callId } : {}) } }));
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'GMAIL_FETCH_EMAILS', arguments: {} } };

    it('refuses a new use of a ready-made App while paused: the check says paused, and nothing is counted or sent', async () => {
      const { adapter, serverId } = await granted();
      expect(await (await check(serverId, `c-${randomUUID()}`)).json()).toMatchObject({ allowed: true });
      asBoss();
      await command('apps', 'pause');
      const answer = await (await check(serverId, `c-${randomUUID()}`)).json();
      expect(answer).toMatchObject({ allowed: false, reason: 'paused' });
      const meterBefore = await prisma.meterEvent.count({ where: { personId: sara } });
      // The use route asks the same check first and answers like the link route does
      const used = await useIt(serverId);
      expect(used.status).toBe(503);
      expect(await used.json()).toMatchObject({ code: 'paused' });
      const called = await link(serverId, call, `c-${randomUUID()}`);
      expect(called.status).toBe(503);
      expect(await called.json()).toMatchObject({ code: 'paused' });
      expect(adapter.use).not.toHaveBeenCalled();
      expect(adapter.callLink).not.toHaveBeenCalled();
      expect(await prisma.meterEvent.count({ where: { personId: sara } })).toBe(meterBefore);
    });

    it('keeps what is not a use: the Brick can still open the link and list what the App can do, so it can tell the person kindly', async () => {
      const { adapter, serverId } = await granted();
      asBoss();
      await command('apps', 'pause');
      const listed = await link(serverId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(listed.status).toBe(200);
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
    });

    it('takes uses again the moment it is resumed, and the same call id a refusal did not count still counts once', async () => {
      const { adapter, serverId } = await granted();
      asBoss();
      await command('apps', 'pause');
      const callId = `c-${randomUUID()}`;
      expect((await link(serverId, call, callId)).status).toBe(503);
      await command('apps', 'resume');
      expect((await link(serverId, call, callId)).status).toBe(200);
      expect((await useIt(serverId)).status).toBe(200);
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
      expect(adapter.use).toHaveBeenCalledTimes(1);
    });

    it('answers a retry of a call that already ran with "already asked", never "paused", so the Brick does not think it was not done', async () => {
      const { adapter, serverId } = await granted();
      const callId = `c-${randomUUID()}`;
      expect((await link(serverId, call, callId)).status).toBe(200);
      asBoss();
      await command('apps', 'pause');
      const retried = await link(serverId, call, callId);
      expect(retried.status).toBe(409);
      expect(await retried.json()).toMatchObject({ code: 'already_asked' });
      expect(await (await check(serverId, callId)).json()).toMatchObject({ allowed: true });
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
      // A new call id is still refused
      expect((await link(serverId, call, `c-${randomUUID()}`)).status).toBe(503);
    });

    it('reads a pause that cannot be read as a pause', async () => {
      const { serverId } = await granted();
      const find = jest.spyOn(prisma.appSetting, 'findUnique').mockRejectedValueOnce(new Error('db down'));
      const spoke = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await (await check(serverId, `c-${randomUUID()}`)).json()).toMatchObject({ allowed: false, reason: 'paused' });
      find.mockRestore();
      spoke.mockRestore();
    });

    it('does not touch Instant or computers', async () => {
      asBoss();
      await command('apps', 'pause');
      expect((await getInstantPause()).paused).toBe(false);
      expect(await (await import('@/lib/capability-pause')).computersArePaused()).toBe(false);
    });
  });

  describe('computers', () => {
    it('starts no new job while paused, says so, and makes and wakes no machine', async () => {
      await giveComputer(saraBrick, sara);
      asBoss();
      await command('computers', 'pause');
      expect(await startJob({ botId: saraBrick, personId: sara, title: 'Visa form' }, NOW)).toEqual({ ok: false, reason: 'paused' });
      expect(await prisma.computerJob.count({ where: { botId: saraBrick } })).toBe(0);
      expect(provider.calls).toEqual([]);
    });

    it('lets a job already going finish, keeps a job in line with its work saved, and starts it by itself once resumed', async () => {
      await giveComputer(saraBrick, sara);
      const both = await Promise.all([startJob({ botId: saraBrick, personId: sara, title: 'A' }, NOW), startJob({ botId: saraBrick, personId: sara, title: 'B' }, NOW)]);
      const running = both.find((one) => one.ok && one.job.status === 'running');
      const queued = both.find((one) => one.ok && one.job.status === 'queued');
      if (!running || !queued || !running.ok || !queued.ok) throw new Error('did not queue');
      asBoss();
      await command('computers', 'pause');
      // The going job is not touched, and finishes as always
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: running.job.id } })).status).toBe('running');
      await finishJob(running.job.id, 'done', minutes(5));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: running.job.id } })).status).toBe('done');
      // The one in line stays in line, however often the sweep looks
      await sweepComputers(minutes(6));
      await sweepComputers(minutes(7));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } })).status).toBe('queued');
      await command('computers', 'resume');
      await sweepComputers(minutes(8));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } })).status).toBe('running');
    });

    it('answers a retry of a run that already has its job with that job, even while paused, and starts no second one', async () => {
      await giveComputer(saraBrick, sara);
      const item = await prisma.brickItem.create({ data: { ownerId: sara, botId: saraBrick, kind: 'goal', words: 'Book it', cadence: {}, timeZone: 'UTC' } });
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: minutes(30) } });
      const first = await startJob({ botId: saraBrick, personId: sara, title: 'Book it', runId: run.id }, NOW);
      if (!first.ok) throw new Error('did not start');
      asBoss();
      await command('computers', 'pause');
      const again = await startJob({ botId: saraBrick, personId: sara, title: 'Book it', runId: run.id }, minutes(1));
      expect(again.ok && again.job.id).toBe(first.job.id);
      // A run with no job yet is a new job: refused while paused
      const other = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: minutes(5), revision: 1, leaseUntil: minutes(30) } });
      expect(await startJob({ botId: saraBrick, personId: sara, title: 'Another', runId: other.id }, minutes(2))).toEqual({ ok: false, reason: 'paused' });
      expect(await prisma.computerJob.count({ where: { botId: saraBrick } })).toBe(1);
      await prisma.brickItem.delete({ where: { id: item.id } });
    });

    it('waits in line for no reason a person could act on: a job that waited for room says "busy" while paused, never "allowance"', async () => {
      await giveComputer(saraBrick, sara);
      const both = await Promise.all([startJob({ botId: saraBrick, personId: sara, title: 'A' }, NOW), startJob({ botId: saraBrick, personId: sara, title: 'B' }, NOW)]);
      const queued = both.find((one) => one.ok && one.job.status === 'queued');
      if (!queued || !queued.ok) throw new Error('did not queue');
      await prisma.computerJob.update({ where: { id: queued.job.id }, data: { queuedFor: 'allowance' } });
      asBoss();
      await command('computers', 'pause');
      await sweepComputers(minutes(3));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } })).toMatchObject({ status: 'queued', queuedFor: 'busy' });
    });

    it('still lets a person give their Brick a computer (that costs nothing) and keeps everything made', async () => {
      asBoss();
      await command('computers', 'pause');
      expect((await giveComputer(saraBrick, sara)).ok).toBe(true);
    });

    it('stands closed while the deeper wind-down is on, and one resume lifts both', async () => {
      await startWindDown('boss@example.test', NOW);
      asBoss();
      const row = ((await (await pauseGet(request('/api/admin/capability-pause'))).json()).capabilities as { key: string; paused: boolean; reason: string }[]).find((one) => one.key === 'computers');
      expect(row).toMatchObject({ paused: true, reason: 'wind_down' });
      await command('computers', 'resume');
      expect(await isWindingDown()).toBe(false);
      expect((await giveComputer(saraBrick, sara)).ok).toBe(true);
      expect((await startJob({ botId: saraBrick, personId: sara, title: 'Again' }, minutes(1))).ok).toBe(true);
    });

    it('shows in the readiness check', async () => {
      asBoss();
      await command('computers', 'pause');
      expect((await computerReadiness()).checks.find((check) => check.name === 'pause')).toMatchObject({ ok: false });
      await command('computers', 'resume');
      expect((await computerReadiness()).checks.find((check) => check.name === 'pause')).toMatchObject({ ok: true });
    });
  });

  describe('Instant Apps', () => {
    it('is paused by the team in the very row it pauses itself in, so every run reads it first and one resume answers both', async () => {
      asBoss();
      await command('instant', 'pause');
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'manual' });
      // Asked twice, the first reason stands
      await pauseInstant('failure_rate');
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'manual' });
      await command('instant', 'resume');
      expect((await getInstantPause()).paused).toBe(false);
    });
  });
});
