/**
 * Code jobs for Apps (the bounded Workbench), against a real database, a FAKE provider workspace and a FAKE file store. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database. The provider is never called.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

// The pause and the way it is read are real; they are only wrapped so a test can make one call fail or answer late
jest.mock('@/lib/workbench/state', () => {
  const actual = jest.requireActual('@/lib/workbench/state');
  return { ...actual, pauseCodeJobs: jest.fn(actual.pauseCodeJobs), getCodeJobPause: jest.fn(actual.getCodeJobPause) };
});

import { prisma } from '@/lib/db';
import { ensureAppActionTools } from '@/lib/app-actions/grant';
import { saveMeterSettings } from '@/lib/meter';
import { AdapterError } from '@/lib/app-adapter/types';
import { readCodeJobsBudget } from '@/lib/workbench/budget';
import { setAdapterForTests, type ReadyMadeAdapter, type WorkbenchAdapter, type WorkbenchRun } from '@/lib/app-adapter';
import { linkReadyMade } from '@/lib/app-adapter/ready-made';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';
import { PREPARE_OUT_DIR, cancelCodeJob, getCodeJob, openOutput, startCodeJob, sweepCodeJobs, type Deps, type ReadRunner, type StartInput } from '@/lib/workbench/executor';
import * as stateModule from '@/lib/workbench/state';
import { getCodeJobPause, resumeCodeJobs, saveCodeJobLimits } from '@/lib/workbench/state';
import { setOutputStoreForTests, type OutputStore } from '@/lib/workbench/store';
import { CODE_JOB_LIMITS_RECOMMENDED, type CodeJobLimits } from '@/lib/workbench/values';
import { GET as outputRoute, DELETE as deleteRoute } from '@/app/api/workbench/outputs/[id]/route';
import { GET as listRoute } from '@/app/api/workbench/outputs/route';
import { POST as promoteRoute } from '@/app/api/workbench/outputs/[id]/artifact/route';
import { artifactKindOf, keepResult, listResults, promoteResult, removeResultsOf } from '@/lib/owned-results';
import { boundAppAnswer } from '@/lib/workbench/link';
import { GET as adminGet, PATCH as adminPatch } from '@/app/api/admin/workbench/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEY = `crm${tag}`;

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';
let connectionId = '';
let serverId = '';

const text = (value: string) => new TextEncoder().encode(value);
const done = (stdout = 'ok', extra: Partial<{ ok: boolean; stderr: string; results: string; error: string | null }> = {}): WorkbenchRun => ({ kind: 'done', cell: { ok: true, stdout, stderr: '', results: '', error: null, logId: 'log_1', ...extra } });

/** A pretend provider workspace: sessions with files, and the same "delete it and it is gone" the real one does. */
function fakeProvider() {
  const sessions = new Map<string, Map<string, Uint8Array>>();
  let counter = 0;
  const state = {
    openFails: false,
    closeFails: 0,
    nested: 0 as number | null,
    listFails: false,
    runs: [] as ((ctx: { sessionId: string; files: Map<string, Uint8Array>; signal?: AbortSignal; timeoutMs: number; code: string }) => Promise<WorkbenchRun> | WorkbenchRun)[],
    codes: [] as string[],
    prepared: 0,
    opened: [] as string[],
  };
  const adapter = {
    open: jest.fn(async ({ jobUserId }: { jobUserId: string }) => {
      if (state.openFails) throw new Error('provider down');
      const sessionId = `trs_${tag}_${(counter += 1)}`;
      sessions.set(sessionId, new Map());
      state.opened.push(jobUserId);
      return { sessionId };
    }),
    run: jest.fn(async ({ sessionId, code, timeoutMs, signal }: { sessionId: string; code: string; timeoutMs: number; signal?: AbortSignal }): Promise<WorkbenchRun> => {
      const files = sessions.get(sessionId);
      if (!files) return { kind: 'gone' };
      // The run that makes the folder for files is the executor's own: it takes no queued answer and is not one of the person's runs
      if (code === PREPARE_OUT_DIR) {
        state.prepared += 1;
        return done('');
      }
      state.codes.push(code);
      const next = state.runs.shift();
      return next ? next({ sessionId, files, signal, timeoutMs, code }) : done();
    }),
    put: jest.fn(async ({ sessionId, path, bytes }: { sessionId: string; path: string; bytes: Uint8Array }) => {
      const files = sessions.get(sessionId);
      if (!files) throw new Error('gone');
      files.set(path, bytes);
    }),
    list: jest.fn(async ({ sessionId, prefix, limit }: { sessionId: string; prefix: string; limit?: number }) => {
      if (state.listFails) throw new Error('list down');
      const files = sessions.get(sessionId);
      if (!files) throw new Error('gone');
      const found = [...files.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => ({ path, bytes: bytes.byteLength }));
      return limit === undefined ? found : found.slice(0, limit);
    }),
    read: jest.fn(async ({ sessionId, path, maxBytes }: { sessionId: string; path: string; maxBytes: number }) => {
      const bytes = sessions.get(sessionId)?.get(path);
      if (!bytes) return { kind: 'missing' as const };
      return bytes.byteLength > maxBytes ? { kind: 'too_big' as const } : { kind: 'ok' as const, bytes };
    }),
    close: jest.fn(async (sessionId: string) => {
      if (state.closeFails > 0) {
        state.closeFails -= 1;
        throw new Error('provider down');
      }
      return sessions.delete(sessionId) ? ('closed' as const) : ('gone' as const);
    }),
    nestedRuns: jest.fn(async () => state.nested),
  } satisfies WorkbenchAdapter;
  /** A run that never ends by itself: it ends when the wait is cancelled or the workspace is deleted, as the real one does. */
  const hang = (ctx: { sessionId: string; signal?: AbortSignal }): Promise<WorkbenchRun> =>
    new Promise((resolve) => {
      const check = setInterval(() => {
        if (!sessions.has(ctx.sessionId)) {
          clearInterval(check);
          resolve({ kind: 'failed', status: null });
        }
      }, 10);
      ctx.signal?.addEventListener('abort', () => {
        clearInterval(check);
        resolve({ kind: 'timeout' });
      });
    });
  return { adapter, sessions, state, hang };
}

function fakeStore() {
  const files = new Map<string, Uint8Array>();
  const store: OutputStore = {
    put: async (key, bytes) => void files.set(key, bytes),
    get: async (key) => {
      const found = files.get(key);
      if (!found) throw new Error('missing');
      return found;
    },
    remove: async (keys) => void keys.forEach((key) => files.delete(key)),
  };
  return { store, files };
}

const clock = { offset: 0 };
const now = () => new Date(Date.now() + clock.offset);
const pending: Promise<void>[] = [];
const background = (work: Promise<void>) => void pending.push(work);
const finishAll = async () => void (await Promise.all(pending.splice(0)));

/** What the migration seeds for the meter: these tests count against it and never set it themselves, so they put it back */
const SEEDED_METER = { memberAllowanceMicros: 250_000, poolCeilingMicros: 2_000_000, reserveMicros: 500_000, storageMicrosPerGbMonth: 90_000, atOnceMember: 1, atOnceAll: 3, appUseCeilingMicros: 10_000_000, appUseMemberCeilingMicros: 500_000 };
const LIMITS: CodeJobLimits = { ...(CODE_JOB_LIMITS_RECOMMENDED as CodeJobLimits), maxSeconds: 10 };

run('code jobs for Apps, in a real database', () => {
  let provider: ReturnType<typeof fakeProvider>;
  let kept: ReturnType<typeof fakeStore>;
  let seq = 0;

  const deps = (extra: Partial<Deps> = {}): Deps => ({ adapter: { workbench: provider.adapter } as unknown as ReadyMadeAdapter, store: kept.store, now, background, ...extra });
  const start = (args: unknown, extra: Partial<StartInput> = {}, d: Partial<Deps> = {}) =>
    startCodeJob({ botId: saraBrick, personId: sara, connectionId, toolkit: KEY, callId: `call-${(seq += 1)}-${tag}`, args, read: null, ...extra }, deps(d));
  const rowOf = async (jobId: string) => ({
    ...(await prisma.codeJob.findUniqueOrThrow({ where: { id: jobId } })),
    outputs: await prisma.ownedResult.findMany({ where: { sourceKind: 'code_job', sourceId: jobId }, orderBy: { name: 'asc' } }),
  });
  const jobOf = (outcome: Awaited<ReturnType<typeof start>>) => {
    if (outcome.status === 'refused') throw new Error(`refused: ${outcome.reason}`);
    return outcome.job;
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
    await saveReadyMadeApps({ apps: { [KEY]: { name: 'Crm', authConfigId: 'ac_1', enabled: true } } }, boss);
    connectionId = (await createConnection(sara, { name: 'Crm', serverUrl: `https://mcp.example/${tag}/mcp`, authType: 'none', authConfig: undefined, source: 'ready_made', providerToolkit: KEY, providerAccountId: `ca_${tag}` })).id;
    // The App's actions as Universe sorted them (lib/app-actions): the Brick's grant takes them as its rows, and reads are gated by these
    const U = KEY.toUpperCase();
    await prisma.appAction.createMany({
      data: [
        ...['LIST', 'LIST_CONTACTS', 'GET'].map((name, position) => ({ toolkit: KEY, slug: `${U}_${name}`, title: name, heading: 'looksUp', source: 'tag', position })),
        { toolkit: KEY, slug: `${U}_DELETE`, title: 'Delete', heading: 'deletesOrSends', source: 'name', position: 3 },
        { toolkit: KEY, slug: `${U}_NEW`, title: 'New', heading: 'makesNew', source: 'tag', position: 4 },
      ],
    });
    await prisma.appActionCatalog.create({ data: { toolkit: KEY, refreshedAt: new Date(), actionCount: 5 } });
    const serverRow = await prisma.botMcpServer.create({ data: { botId: saraBrick, connectionId, name: 'Crm', serverUrl: 'https://mcp.example/unused', enabled: true } });
    serverId = serverRow.id;
    // Brought over to the App's actions, as the first read of a bot server that knows them does
    await ensureAppActionTools(serverId);
  });

  beforeEach(async () => {
    provider = fakeProvider();
    kept = fakeStore();
    setOutputStoreForTests(kept.store);
    clock.offset = 0;
    await prisma.codeJob.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.ownedResult.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.artifact.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await saveCodeJobLimits(LIMITS, boss);
    await resumeCodeJobs(boss);
    // The meter's settings are the ones the migration seeds, put back every time: another suite may have deleted them
    await saveMeterSettings(SEEDED_METER, boss);
  });

  afterEach(async () => {
    await finishAll();
    setAdapterForTests(undefined);
    mockUser.current = null;
  });

  afterAll(async () => {
    setOutputStoreForTests(undefined);
    await prisma.codeJob.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.ownedResult.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.artifact.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'ready-made-apps' } });
    await prisma.appAction.deleteMany({ where: { toolkit: KEY } });
    await prisma.appActionCatalog.deleteMany({ where: { toolkit: KEY } });
    await saveCodeJobLimits(CODE_JOB_LIMITS_RECOMMENDED, boss);
    await resumeCodeJobs(boss);
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  describe('admission: nothing runs unless every rule holds', () => {
    it('refuses while a Limit is empty, so no number is ever assumed in code', async () => {
      await saveCodeJobLimits({ maxOutputBytes: null }, boss);
      const outcome = await start({ code: 'print(1)' });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'not_set' });
      expect(provider.adapter.open).not.toHaveBeenCalled();
      expect(await prisma.codeJob.count({ where: { personId: sara } })).toBe(0);
    });

    it('refuses while paused, and when the provider side is not there', async () => {
      await prisma.appSetting.upsert({ where: { key: 'code-job-state' }, create: { key: 'code-job-state', value: { paused: true, reason: 'manual' } }, update: { value: { paused: true, reason: 'manual' } } });
      expect(await start({ code: 'print(1)' })).toMatchObject({ status: 'refused', reason: 'paused' });
      await resumeCodeJobs(boss);
      expect(await start({ code: 'print(1)' }, {}, { adapter: {} as ReadyMadeAdapter })).toMatchObject({ status: 'refused', reason: 'unavailable' });
      expect(provider.adapter.open).not.toHaveBeenCalled();
    });

    it('is only ever for the Brick’s owner', async () => {
      expect(await start({ code: 'print(1)' }, { personId: omar })).toMatchObject({ status: 'refused', reason: 'not_owner' });
      expect(provider.adapter.open).not.toHaveBeenCalled();
    });

    it('refuses a request that is not one a job takes, or is over a Limit, before anything is reserved', async () => {
      expect(await start({})).toMatchObject({ status: 'refused', reason: 'bad_request' });
      expect(await start({ code: 'x', extra: 1 })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      expect(await start({ code: 'x', steps: ['y'] })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      expect(await start({ code: 'x'.repeat(LIMITS.maxCodeBytes! + 1) })).toMatchObject({ status: 'refused', reason: 'too_big' });
      expect(await start({ steps: Array(LIMITS.maxCells! + 1).fill('x') })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      expect(await start({ code: 'x', inputs: [{ name: '../etc/passwd', content: 'x' }] })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      expect(await start({ code: 'x', inputs: [{ name: 'a.txt', content: 'x'.repeat(LIMITS.maxInputBytes! + 1) }] })).toMatchObject({ status: 'refused', reason: 'too_big' });
      expect(await start({ code: 'x', inputs: [{ name: 'a.bin', content: '!!!not base64', base64: true }] })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      // A read may only run a tool of this App, and never one of the provider's own (its batch and sandbox tools are meta tools)
      const read = jest.fn();
      for (const tool of ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'OTHERAPP_LIST']) {
        expect(await start({ code: 'x', reads: [{ tool }] }, { read })).toMatchObject({ status: 'refused', reason: 'bad_request' });
      }
      expect(read).not.toHaveBeenCalled();
      expect(await prisma.codeJob.count({ where: { personId: sara } })).toBe(0);
      expect(provider.adapter.open).not.toHaveBeenCalled();
    });

    it('holds jobs at once for a person and in all, jobs a day, and the month’s ceiling', async () => {
      // One job going: a second for the same person waits, and so does anyone else when "in all" is 1
      provider.state.runs.push(provider.hang);
      const first = jobOf(await start({ code: 'while True: pass' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await start({ code: 'print(2)' })).toMatchObject({ status: 'refused', reason: 'busy' });
      await saveCodeJobLimits({ atOnceAll: 1, atOncePerPerson: 5 }, boss);
      expect(await start({ code: 'print(2)' })).toMatchObject({ status: 'refused', reason: 'busy' });
      await cancelCodeJob({ jobId: first.jobId, botId: saraBrick, personId: sara }, deps());
      await finishAll();

      await saveCodeJobLimits({ atOnceAll: 3, atOncePerPerson: 1, jobsPerPersonPerDay: 2 }, boss);
      // One job has been made today (the cancelled one); a second is allowed, a third is not
      jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      expect(await start({ code: 'print(1)' })).toMatchObject({ status: 'refused', reason: 'daily_limit' });

      await saveCodeJobLimits({ jobsPerPersonPerDay: 100, exposureCeilingMicros: 450 }, boss);
      await prisma.codeJob.deleteMany({ where: { personId: sara } });
      jobOf(await start({ steps: ['print(1)', 'print(2)'] }));
      await finishAll();
      // 300 micros are used this month (two steps and the run that makes the folder for files): one more step with its folder run is 200, and 300 + 200 > 450, so it does not
      expect(await start({ code: 'print(3)' })).toMatchObject({ status: 'refused', reason: 'exposure_full' });
    });
  });

  describe('a job’s life', () => {
    it('runs in its own workspace with no person in it, keeps its files in Universe’s storage, closes the workspace and settles once', async () => {
      provider.state.runs.push(async ({ files }) => {
        files.set('out/result.csv', text('a,b\n1,2\n'));
        files.set('out/chart.png', text('PNGDATA'));
        files.set('out/nested/deep.txt', text('no'));
        files.set('elsewhere.txt', text('no'));
        return done('hello from the job');
      });
      const outcome = await start({ code: 'print("hello")', inputs: [{ name: 'in.txt', content: 'data' }, { name: 'b.bin', content: Buffer.from('xyz').toString('base64'), base64: true }] });
      expect(outcome.status).toBe('started');
      const job = jobOf(outcome);
      expect(job.state).toBe('running');
      await finishAll();

      const row = await rowOf(job.jobId);
      expect(row).toMatchObject({ state: 'succeeded', reason: null, cellsRun: 1, providerState: 'closed', nestedCalls: 0, steps: 1 });
      // The workspace is made under an id of the job's own (never a person's) and is gone after the job
      expect(provider.state.opened).toEqual([`codejob-${job.jobId}`]);
      expect(provider.state.opened[0]).not.toContain(sara);
      expect(provider.sessions.size).toBe(0);
      expect(provider.adapter.close).toHaveBeenCalledTimes(1);
      // What was put in, and the folder for files made by a run of its own, with the code sent exactly as written
      expect([...(await Promise.resolve(provider.adapter.put.mock.calls.map(([call]) => call.path)))].sort()).toEqual(['in/b.bin', 'in/in.txt']);
      expect(provider.state.prepared).toBe(1);
      expect(provider.state.codes).toEqual(['print("hello")']);
      // Only plain names directly under out/ are kept
      expect(row.outputs.map((output) => output.name).sort()).toEqual(['chart.png', 'result.csv']);
      expect(row.outputs.find((output) => output.name === 'result.csv')).toMatchObject({ contentType: 'text/csv', sizeBytes: 8 });
      expect(kept.files.size).toBe(2);
      const view = (await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps())) as { status: 'ok'; job: { state: string; runs: { printed: string }[]; files: { name: string; preview?: string; path: string }[]; notKept: { name: string }[] } };
      expect(view.job.state).toBe('succeeded');
      expect(view.job.runs[0].printed).toBe('hello from the job');
      expect(view.job.files.find((file) => file.name === 'result.csv')).toMatchObject({ preview: 'a,b\n1,2\n' });
      expect(view.job.files.find((file) => file.name === 'chart.png')?.preview).toBeUndefined();
      expect(view.job.notKept.map((entry) => entry.name)).toEqual(expect.arrayContaining(['nested/deep.txt']));
      // Settled once, as an estimate paid by the universe, naming what ran and never what it was given
      const events = await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: `codejob:${job.jobId}`, basis: 'estimated', payerKind: 'universe', quantity: BigInt(2), costMicros: BigInt(200) });
      expect(JSON.stringify(events[0].detail)).not.toContain('hello');
      // The job keeps what it was admitted under
      expect(row.capabilities).toMatchObject({ credentials: 'none', appTools: 'none', rawRequests: 'off', instant: 'off', network: 'provider-default' });
      expect(row.limits).toMatchObject({ maxSeconds: 10 });
      expect(row.expiresAt).not.toBeNull();
    });

    it('counts the run that makes the folder for files like any other run: reserved, settled and metered', async () => {
      provider.state.runs.push(() => done('1'));
      const job = jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      // One step shown to the person, two runs at the provider, two runs paid for
      expect(row).toMatchObject({ cellsRun: 1, preparedRuns: 1, steps: 1, reservedMicros: BigInt(200), settledMicros: BigInt(200) });
      expect(provider.state.prepared).toBe(1);
      expect(await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps())).toMatchObject({ status: 'ok', job: { runsUsed: 1 } });
      const events = await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } });
      expect(events[0]).toMatchObject({ quantity: BigInt(2), costMicros: BigInt(200) });
    });

    it('sends code that begins with a __future__ import exactly as written, so it still runs, and prepares the folder in a run of its own', async () => {
      const code = 'from __future__ import annotations\nprint(1)';
      provider.state.runs.push(() => done('1'));
      const job = jobOf(await start({ code }));
      await finishAll();
      expect(provider.state.codes).toEqual([code]);
      expect(provider.state.prepared).toBe(1);
      expect((await rowOf(job.jobId)).cellsRun).toBe(1);
      // Both are valid Python as sent (a line put before the import would not be)
      const python = spawnSync('python3', ['-c', 'import sys; [compile(s, "x", "exec") for s in sys.argv[1:]]', PREPARE_OUT_DIR, code]);
      if (!python.error) expect(python.status).toBe(0);
      if (!python.error) expect(spawnSync('python3', ['-c', 'import sys; compile(sys.argv[1], "x", "exec")', `import os; os.makedirs("/x", exist_ok=True)\n${code}`]).status).not.toBe(0);
    });

    it('answers the same call id with the same job, never a second workspace or a second charge', async () => {
      const callId = `repeat-${tag}`;
      const one = jobOf(await start({ code: 'print(1)' }, { callId }));
      await finishAll();
      const again = await start({ code: 'print(1)' }, { callId });
      expect(again.status).toBe('existing');
      expect(jobOf(again).jobId).toBe(one.jobId);
      expect(provider.adapter.open).toHaveBeenCalledTimes(1);
      expect(await prisma.codeJob.count({ where: { personId: sara } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
      // Two asks at the same moment make one job
      const [a, b] = await Promise.all([start({ code: 'print(2)' }, { callId: `race-${tag}` }), start({ code: 'print(2)' }, { callId: `race-${tag}` })]);
      expect(jobOf(a).jobId).toBe(jobOf(b).jobId);
      await finishAll();
      expect(provider.adapter.open).toHaveBeenCalledTimes(2);
    });

    it('runs several steps in the same workspace, stops at the first that fails and still keeps what was made', async () => {
      provider.state.runs.push(
        ({ files }) => {
          files.set('out/partial.txt', text('half'));
          return done('step one');
        },
        () => done('boom', { ok: false, error: 'Traceback: ValueError' }) as WorkbenchRun,
      );
      // `done` marks ok:true unless overridden; the second one fails
      provider.state.runs[1] = () => ({ kind: 'done', cell: { ok: false, stdout: 'boom', stderr: 'err', results: '', error: 'Traceback: ValueError', logId: null } });
      const job = jobOf(await start({ steps: ['a = 1', 'raise ValueError', 'never'] }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row).toMatchObject({ state: 'failed', reason: 'code_failed', cellsRun: 2, providerState: 'closed' });
      expect(provider.state.codes).toHaveLength(2);
      expect(row.outputs.map((output) => output.name)).toEqual(['partial.txt']);
      // Only the runs that happened are charged
      expect((await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } }))[0]).toMatchObject({ quantity: BigInt(3), costMicros: BigInt(300) });
    });

    it('says which steps really ran, which did not work and which never ran, never more than is known', async () => {
      const failing: WorkbenchRun = { kind: 'done', cell: { ok: false, stdout: '', stderr: 'err', results: '', error: 'ValueError', logId: null } };
      provider.state.runs.push(() => done('one'), () => failing);
      const job = jobOf(await start({ steps: ['a = 1', 'raise ValueError', 'never'] }));
      await finishAll();
      const view = await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara }, deps());
      if (view.status !== 'ok') throw new Error('not ok');
      expect(view.job.message).toContain('2 of 3 steps ran; step 2 did not work; 1 step did not run.');
      expect(view.job.message).not.toContain('finished');

      // All of them ran: said as that, with what was kept
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('x'));
        return done('ok');
      });
      const good = jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      const goodView = await getCodeJob({ jobId: good.jobId, botId: saraBrick, personId: sara }, deps());
      if (goodView.status !== 'ok') throw new Error('not ok');
      expect(goodView.job.message).toBe('The job finished. 1 of 1 step ran. 1 file kept.');

      // A read that did not work: the code did not run, and that is said
      const read: ReadRunner = jest.fn(async () => null);
      const noRead = jobOf(await start({ code: 'x', reads: [{ tool: `${KEY.toUpperCase()}_LIST` }] }, { read }));
      await finishAll();
      const noReadView = await getCodeJob({ jobId: noRead.jobId, botId: saraBrick, personId: sara }, deps());
      if (noReadView.status !== 'ok') throw new Error('not ok');
      expect(noReadView.job.message).toContain('0 of 1 App read were done, so the code did not run. None of the 1 step ran.');

      // Cut short: "started", never "ran", because nobody saw it end
      provider.state.runs.push(provider.hang);
      const hung = jobOf(await start({ steps: ['while True: pass', 'later'] }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const running = await getCodeJob({ jobId: hung.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps());
      if (running.status !== 'ok') throw new Error('not ok');
      expect(running.job.message).toBe('The job is still running. 1 of 2 steps have started.');
      const cancelled = await cancelCodeJob({ jobId: hung.jobId, botId: saraBrick, personId: sara }, deps());
      if (cancelled.status !== 'ok') throw new Error('not ok');
      await finishAll();
      expect(cancelled.job.message).toContain('1 of 2 steps started; step 1 was stopped before it finished, so what it did is not known; 1 step did not run.');
    });

    it('never makes a computer, takes none and bills the universe as it does any App step', async () => {
      const before = await prisma.brickComputer.count({ where: { botId: saraBrick } });
      jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      expect(before).toBe(0);
      expect(await prisma.brickComputer.count({ where: { botId: saraBrick } })).toBe(0);
      const line = await prisma.meterEvent.findFirstOrThrow({ where: { personId: sara, kind: 'app_use' } });
      expect(line).toMatchObject({ payerKind: 'universe', payerPersonId: null, botId: saraBrick });
    });

    it('clips what the code printed to the Limit, across all its runs', async () => {
      await saveCodeJobLimits({ maxResultChars: 100 }, boss);
      provider.state.runs.push(() => done('x'.repeat(5000)));
      const job = jobOf(await start({ code: 'print("x"*5000)' }));
      await finishAll();
      const view = (await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara }, deps())) as { job: { runs: { printed: string }[]; clipped: boolean } };
      expect(view.job.runs[0].printed).toHaveLength(100);
      expect(view.job.clipped).toBe(true);
    });

    it('does not run when the workspace cannot be made, and charges nothing it did not run', async () => {
      provider.state.openFails = true;
      const job = jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'failed', reason: 'unavailable', cellsRun: 0, providerState: 'none' });
      expect(provider.adapter.run).not.toHaveBeenCalled();
      expect((await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } }))[0]).toMatchObject({ quantity: BigInt(0), costMicros: BigInt(0) });
    });
  });

  describe('reads: the only way the person’s App data gets in, and Orbit does them', () => {
    it('runs each read itself, one at a time under its own call id, and puts the answer in the workspace as a file', async () => {
      const read: ReadRunner = jest.fn(async ({ tool }) => ({ ok: true, data: { tool, rows: [1, 2, 3] } }));
      const job = jobOf(await start({ code: 'import json', reads: [{ tool: `${KEY.toUpperCase()}_LIST_CONTACTS`, arguments: { limit: 3 } }, { tool: `${KEY.toUpperCase()}_GET`, as: 'deal.json' }] }, { read }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.state).toBe('succeeded');
      expect((read as jest.Mock).mock.calls.map(([call]) => call)).toEqual([
        { tool: `${KEY.toUpperCase()}_LIST_CONTACTS`, arguments: { limit: 3 }, callId: `${row.jobKey}:read:0` },
        { tool: `${KEY.toUpperCase()}_GET`, arguments: {}, callId: `${row.jobKey}:read:1` },
      ]);
      const put = provider.adapter.put.mock.calls.map(([call]) => call);
      expect(put.map((call) => call.path)).toEqual(['in/read-1.json', 'in/deal.json']);
      expect(JSON.parse(Buffer.from(put[0].bytes).toString('utf8'))).toMatchObject({ rows: [1, 2, 3] });
    });

    it('runs only a tool the Brick may run right away: not one that is off, asks first, changes or makes things, or is not on its list', async () => {
      const read: ReadRunner = jest.fn(async () => ({ ok: true, data: {} }));
      const U = KEY.toUpperCase();
      const refused = async (tool: string) => {
        const outcome = await start({ code: 'x', reads: [{ tool }] }, { read });
        expect(outcome).toMatchObject({ status: 'refused', reason: 'not_allowed' });
      };
      await refused(`${U}_DELETE`);
      await refused(`${U}_NEW`);
      await refused(`${U}_NOT_ON_THE_LIST`);
      // The heading's own setting decides too: asks first and off are both a no
      for (const setting of ['asksFirst', 'off']) {
        await prisma.botMcpServer.update({ where: { id: serverId }, data: { lookUpSetting: setting } });
        await refused(`${U}_LIST`);
      }
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { lookUpSetting: 'rightAway' } });
      // An action's own choice decides over its heading's, both ways
      const list = await prisma.botMcpTool.findFirstOrThrow({ where: { serverId, name: `${U}_LIST` } });
      for (const setting of ['asksFirst', 'off']) {
        await prisma.botMcpTool.update({ where: { id: list.id }, data: { setting } });
        await refused(`${U}_LIST`);
      }
      await prisma.botMcpTool.update({ where: { id: list.id }, data: { setting: null } });
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { enabled: false } });
      await refused(`${U}_LIST`);
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { enabled: true } });
      // A good one in the same request does not carry a bad one
      expect(await start({ code: 'x', reads: [{ tool: `${U}_LIST` }, { tool: `${U}_DELETE` }] }, { read })).toMatchObject({ status: 'refused', reason: 'not_allowed' });
      expect(read).not.toHaveBeenCalled();
      expect(await prisma.codeJob.count({ where: { personId: sara } })).toBe(0);
      expect(provider.adapter.open).not.toHaveBeenCalled();
      // And a tool that passes still runs, whatever the case of its name
      jobOf(await start({ code: 'x', reads: [{ tool: `${KEY}_list` }] }, { read }));
      await finishAll();
      expect(read).toHaveBeenCalledTimes(1);
      // A look-up whose heading asks first runs when its own choice is Right away
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { lookUpSetting: 'asksFirst' } });
      const get = await prisma.botMcpTool.findFirstOrThrow({ where: { serverId, name: `${U}_GET` } });
      await prisma.botMcpTool.update({ where: { id: get.id }, data: { setting: 'rightAway' } });
      try {
        await refused(`${U}_LIST`);
        jobOf(await start({ code: 'x', reads: [{ tool: `${U}_GET` }] }, { read }));
        await finishAll();
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        await prisma.botMcpTool.update({ where: { id: get.id }, data: { setting: null } });
        await prisma.botMcpServer.update({ where: { id: serverId }, data: { lookUpSetting: 'rightAway' } });
      }
    });

    it('stops before any code runs when a read does not work, and when the data is over the Limit', async () => {
      const failing: ReadRunner = jest.fn(async () => null);
      const one = jobOf(await start({ code: 'x', reads: [{ tool: `${KEY.toUpperCase()}_LIST` }] }, { read: failing }));
      await finishAll();
      expect(await rowOf(one.jobId)).toMatchObject({ state: 'failed', reason: 'read_failed', cellsRun: 0, providerState: 'closed' });
      expect(provider.adapter.run).not.toHaveBeenCalled();

      await saveCodeJobLimits({ maxInputBytes: 10 }, boss);
      const big: ReadRunner = jest.fn(async () => ({ ok: true, data: { rows: 'x'.repeat(100) } }));
      const two = jobOf(await start({ code: 'x', reads: [{ tool: `${KEY.toUpperCase()}_LIST` }] }, { read: big }));
      await finishAll();
      expect(await rowOf(two.jobId)).toMatchObject({ state: 'failed', reason: 'too_big', cellsRun: 0 });
      expect(provider.adapter.run).not.toHaveBeenCalled();
      expect(provider.sessions.size).toBe(0);
    });
  });

  describe('files kept: bounded by the Limits, never trusted by name, never lost to an expiring link', () => {
    it('keeps only what fits the number and size Limits, and says what it left', async () => {
      await saveCodeJobLimits({ maxOutputFiles: 2, maxOutputBytes: 30 }, boss);
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('aaaaaaaaaa'));
        files.set('out/b.txt', text('bbbbbbbbbb'));
        files.set('out/c.txt', text('cccccccccc'));
        files.set('out/.hidden', text('x'));
        files.set('out/bad name.txt', text('x'));
        return done();
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.outputs.map((output) => output.name).sort()).toEqual(['a.txt', 'b.txt']);
      const result = row.result as { notKept: { name: string; why: string }[] };
      expect(result.notKept.map((entry) => entry.name).sort()).toEqual(['.hidden', 'bad name.txt', 'c.txt']);
      expect(result.notKept.find((entry) => entry.name === 'c.txt')?.why).toMatch(/number of files/);
    });

    it('keeps the allowed number from a job that left thousands of files, and says more were left', async () => {
      await saveCodeJobLimits({ maxOutputFiles: 3 }, boss);
      provider.state.runs.push(({ files }) => {
        for (let n = 0; n < 2_600; n += 1) files.set(`out/f${String(n).padStart(4, '0')}.txt`, text('x'));
        return done();
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.state).toBe('succeeded');
      expect(row.outputs).toHaveLength(3);
      const notKept = (row.result as { notKept: { name: string; why: string }[] }).notKept;
      expect(notKept.some((entry) => entry.name === '(more files)')).toBe(true);
      expect(notKept.some((entry) => entry.name === '(all)')).toBe(false);
    });

    it('says "(more files)" only when there really are more, not when the listing is exactly the number looked at', async () => {
      await saveCodeJobLimits({ maxOutputFiles: 3 }, boss);
      const leave = (count: number) => provider.state.runs.push(({ files }) => {
        for (let n = 0; n < count; n += 1) files.set(`out/f${String(n).padStart(3, '0')}.txt`, text('x'));
        return done();
      });
      const notKeptOf = async (count: number) => {
        leave(count);
        const job = jobOf(await start({ code: `print(${count})` }));
        await finishAll();
        return ((await rowOf(job.jobId)).result as { notKept: { name: string }[] }).notKept.map((entry) => entry.name);
      };
      // 3 kept and 50 more looked at: exactly 53 files is all of them, 54 is not
      expect(await notKeptOf(53)).not.toContain('(more files)');
      expect(await notKeptOf(54)).toContain('(more files)');
    });

    it('does not keep a file bigger than what is left, and does not fail the job over a listing it cannot read', async () => {
      await saveCodeJobLimits({ maxOutputBytes: 15 }, boss);
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('aaaaaaaaaa'));
        files.set('out/b.txt', text('bbbbbbbbbb'));
        return done();
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.outputs.map((output) => output.name)).toEqual(['a.txt']);
      expect((row.result as { notKept: { name: string }[] }).notKept.map((entry) => entry.name)).toEqual(['b.txt']);

      provider.state.listFails = true;
      provider.state.runs.push(({ files }) => {
        files.set('out/c.txt', text('c'));
        return done();
      });
      const second = jobOf(await start({ code: 'x' }));
      await finishAll();
      const secondRow = await rowOf(second.jobId);
      expect(secondRow.state).toBe('succeeded');
      expect(secondRow.outputs).toHaveLength(0);
      expect((secondRow.result as { notKept: { name: string }[] }).notKept[0].name).toBe('(all)');
    });

    it('opens a kept file for its owner only, from Universe’s own copy', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/report.md', text('# done'));
        return done();
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const output = (await rowOf(job.jobId)).outputs[0];
      expect(await openOutput(output.id, sara, deps())).toMatchObject({ name: 'report.md', contentType: 'text/markdown' });
      expect(await openOutput(output.id, omar, deps())).toBeNull();
      expect(await openOutput('not-an-id', sara, deps())).toBeNull();
      // Through the route: a download for the owner, the same 404 for anyone else and for no one signed in
      mockUser.current = { id: sara };
      const ok = await outputRoute(new NextRequest(`http://localhost/api/workbench/outputs/${output.id}`), { params: Promise.resolve({ id: output.id }) });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString('utf8')).toBe('# done');
      expect(ok.headers.get('content-disposition')).toContain('attachment');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-security-policy')).toContain('sandbox');
      mockUser.current = { id: omar };
      expect((await outputRoute(new NextRequest(`http://localhost/api/workbench/outputs/${output.id}`), { params: Promise.resolve({ id: output.id }) })).status).toBe(404);
      mockUser.current = null;
      expect((await outputRoute(new NextRequest(`http://localhost/api/workbench/outputs/${output.id}`), { params: Promise.resolve({ id: output.id }) })).status).toBe(404);
    });

    it('empties a job’s printed result once the days kept have passed, and never the files: those are their owner’s', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/old.txt', text('old'));
        return done('printed');
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      expect(kept.files.size).toBe(1);
      expect((await sweepCodeJobs(deps())).purged).toBe(0);
      await prisma.codeJob.update({ where: { id: job.jobId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await sweepCodeJobs(deps())).purged).toBe(1);
      const row = await rowOf(job.jobId);
      expect(row.result).toBeNull();
      expect(row.expiresAt).toBeNull();
      // The file is still kept, still listed with the job and still opens for its owner
      expect(kept.files.size).toBe(1);
      expect(row.outputs.map((output) => output.name)).toEqual(['old.txt']);
      const view = await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps());
      if (view.status !== 'ok') throw new Error('not ok');
      expect(view.job.files.map((file) => file.name)).toEqual(['old.txt']);
      expect(await openOutput(row.outputs[0].id, sara, deps())).toMatchObject({ name: 'old.txt' });
      // A second sweep finds nothing more
      expect((await sweepCodeJobs(deps())).purged).toBe(0);
    });
  });

  describe('results a person owns: they stay until the owner deletes them, and nothing publishes them by itself', () => {
    const keepOne = async (name: string, body: string, extra: Partial<{ files: Map<string, Uint8Array> }> = {}) => {
      void extra;
      provider.state.runs.push(({ files }) => {
        files.set(`out/${name}`, text(body));
        return done('made');
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      return { job, row, output: row.outputs[0] };
    };
    const asUser = (id: string | null) => (mockUser.current = id ? { id } : null);
    const request = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost/api/workbench/outputs${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

    it('says who owns each one and where it came from, and never lists it to anyone else', async () => {
      const { job, output } = await keepOne('notes.md', '# notes');
      expect(output).toMatchObject({ ownerId: sara, sourceKind: 'code_job', sourceId: job.jobId, makerBotId: saraBrick, makerName: 'Brick', access: 'owner', artifactId: null });
      asUser(sara);
      const mine = (await (await listRoute(request(''))).json()) as { results: { id: string; madeBy: string; access: string; sourceId: string; path: string }[]; keptBytes: number };
      expect(mine.results).toHaveLength(1);
      expect(mine.results[0]).toMatchObject({ id: output.id, madeBy: 'Brick', access: 'owner', sourceId: job.jobId, path: `/api/workbench/outputs/${output.id}` });
      expect(mine.keptBytes).toBe(7);
      asUser(omar);
      expect(((await (await listRoute(request(''))).json()) as { results: unknown[] }).results).toHaveLength(0);
      asUser(null);
      expect((await listRoute(request(''))).status).toBe(401);
    });

    it('stay when the job ends in a cancel record, expires, or the Brick is deleted, and only the Brick’s name turns into "A deleted Brick"', async () => {
      const { output } = await keepOne('keep.txt', 'keep me');
      const original = await prisma.bot.findUniqueOrThrow({ where: { id: saraBrick }, select: { roomId: true, enabled: true } });
      await prisma.bot.update({ where: { id: saraBrick }, data: { deletedAt: new Date(), goneAt: new Date(), roomId: null, enabled: false } });
      try {
        asUser(sara);
        const listed = (await (await listRoute(request(''))).json()) as { results: { madeBy: string }[] };
        expect(listed.results[0].madeBy).toBe('A deleted Brick');
        expect(await openOutput(output.id, sara, deps())).toMatchObject({ name: 'keep.txt' });
        // The sweep leaves it where it is
        await sweepCodeJobs(deps());
        expect(await prisma.ownedResult.count({ where: { id: output.id } })).toBe(1);
      } finally {
        await prisma.bot.update({ where: { id: saraBrick }, data: { deletedAt: null, goneAt: null, roomId: original.roomId, enabled: original.enabled } });
      }
    });

    it('stop at the most one person may keep, say what was left, and count what they already keep', async () => {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 20 }, boss);
      await keepOne('a.txt', '0123456789');
      provider.state.runs.push(({ files }) => {
        files.set('out/b.txt', text('0123456789'));
        files.set('out/c.txt', text('0123456789'));
        return done('two more');
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.outputs.map((output) => output.name)).toEqual(['b.txt']);
      const view = await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps());
      if (view.status !== 'ok') throw new Error('not ok');
      expect(view.job.notKept).toEqual([{ name: 'c.txt', why: 'your kept files are full: delete some to make room' }]);
      // Deleting makes room again
      asUser(sara);
      const first = (await prisma.ownedResult.findFirstOrThrow({ where: { ownerId: sara, name: 'a.txt' } })).id;
      expect((await deleteRoute(request(`/${first}`, 'DELETE'), { params: Promise.resolve({ id: first }) })).status).toBe(200);
      expect(kept.files.size).toBe(1);
      const again = await keepOne('d.txt', '0123456789');
      expect(again.row.outputs.map((output) => output.name)).toEqual(['d.txt']);
    });

    it('can be deleted by the owner alone: the file goes first, and one that could not be removed stays listed', async () => {
      const { output } = await keepOne('gone.txt', 'bye');
      asUser(omar);
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(404);
      asUser(null);
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(404);
      asUser(sara);
      const failing = jest.spyOn(kept.store, 'remove').mockRejectedValueOnce(new Error('bucket down'));
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(502);
      failing.mockRestore();
      expect(await prisma.ownedResult.count({ where: { id: output.id } })).toBe(1);
      expect(kept.files.size).toBe(1);
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(200);
      expect(await prisma.ownedResult.count({ where: { id: output.id } })).toBe(0);
      expect(kept.files.size).toBe(0);
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(404);
    });

    it('are removed with an account that is gone, from storage and the books, and only then', async () => {
      const { output } = await keepOne('orphan.txt', 'x');
      const stranger = randomUUID();
      const strangerKey = 'code-jobs/code_job-stranger/stranger.ucj';
      await kept.store.put(strangerKey, text('theirs'));
      await prisma.ownedResult.create({ data: { id: randomUUID(), ownerId: stranger, sourceKind: 'code_job', sourceId: 'gone-job', makerBotId: 'bot', makerName: 'Brick', name: 'a.txt', contentType: 'text/plain', sizeBytes: 6, sha256: 'x'.repeat(64), storageKey: strangerKey } });
      const swept = await sweepCodeJobs(deps());
      expect(swept.orphansRemoved).toBe(1);
      expect(await prisma.ownedResult.count({ where: { ownerId: stranger } })).toBe(0);
      expect(kept.files.has(strangerKey)).toBe(false);
      expect(await prisma.ownedResult.count({ where: { id: output.id } })).toBe(1);
    });

    it('become an artifact only when the owner asks, "Just you", once, and the file stays', async () => {
      const { output } = await keepOne('report.md', '# Report\n\nAll good.');
      expect(await prisma.artifact.count({ where: { ownerId: sara } })).toBe(0);
      const stored = new Map<string, string>();
      const files = { put: async (key: string, body: string | Uint8Array) => void stored.set(key, String(body)), remove: async (keys: string[]) => keys.forEach((key) => stored.delete(key)) } as unknown as Parameters<typeof promoteResult>[3] extends { files?: infer F } | undefined ? F : never;
      expect(await promoteResult(output.id, omar, {}, { store: kept.store, files })).toEqual({ status: 'refused', reason: 'not_found' });
      const made = await promoteResult(output.id, sara, { title: 'Weekly report' }, { store: kept.store, files });
      expect(made).toMatchObject({ status: 'made', kind: 'markdown' });
      if (made.status !== 'made') throw new Error('not made');
      const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: made.artifactId }, include: { versions: true } });
      expect(artifact).toMatchObject({ ownerId: sara, makerBotId: saraBrick, makerName: 'Brick', title: 'Weekly report', kind: 'markdown', openScope: 'me', changeScope: 'owner', chatKind: null });
      expect(artifact.versions[0].summary).toContain('code job');
      expect([...stored.values()]).toEqual(['# Report\n\nAll good.']);
      expect((await prisma.ownedResult.findUniqueOrThrow({ where: { id: output.id } })).artifactId).toBe(made.artifactId);
      // Asking again names the same artifact and makes no second
      expect(await promoteResult(output.id, sara, {}, { store: kept.store, files })).toEqual({ status: 'already', artifactId: made.artifactId });
      expect(await prisma.artifact.count({ where: { ownerId: sara } })).toBe(1);
      // The file is still there, and deleting it leaves the artifact alone
      expect(await openOutput(output.id, sara, deps())).toMatchObject({ name: 'report.md' });
      asUser(sara);
      expect((await deleteRoute(request(`/${output.id}`, 'DELETE'), { params: Promise.resolve({ id: output.id }) })).status).toBe(200);
      expect(await prisma.artifact.count({ where: { id: made.artifactId } })).toBe(1);
    });

    it('is refused for what an artifact cannot be, and for text that is not text', async () => {
      const csv = await keepOne('table.csv', 'a,b');
      expect(await promoteResult(csv.output.id, sara, {}, { store: kept.store })).toEqual({ status: 'refused', reason: 'not_an_artifact_type' });
      const bad = await keepOne('broken.html', 'x');
      await kept.store.put((await prisma.ownedResult.findUniqueOrThrow({ where: { id: bad.output.id } })).storageKey, new Uint8Array([0xff, 0xfe, 0xfd]));
      expect(await promoteResult(bad.output.id, sara, {}, { store: kept.store })).toEqual({ status: 'refused', reason: 'not_text' });
      asUser(sara);
      const response = await promoteRoute(request(`/${csv.output.id}/artifact`, 'POST', {}), { params: Promise.resolve({ id: csv.output.id }) });
      expect(response.status).toBe(422);
      asUser(omar);
      expect((await promoteRoute(request(`/${csv.output.id}/artifact`, 'POST', {}), { params: Promise.resolve({ id: csv.output.id }) })).status).toBe(404);
      expect(await prisma.artifact.count({ where: { ownerId: { in: [sara, omar] } } })).toBe(0);
    });

    it('says which kinds a file can become', () => {
      expect(artifactKindOf('a.md', 'text/plain')).toBe('markdown');
      expect(artifactKindOf('a.svg', 'application/octet-stream')).toBe('svg');
      expect(artifactKindOf('a.bin', 'text/html; charset=utf-8')).toBe('page');
      expect(artifactKindOf('a.csv', 'text/csv')).toBeNull();
      expect(artifactKindOf('a.png', 'image/png')).toBeNull();
    });
  });

  describe('what really stops the code: the deadline, a cancel and the sweep, each by deleting the workspace', () => {
    it('stops at the deadline, even when a run took the whole of it, and keeps nothing', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/late.txt', text('late'));
        // This run took longer than the whole job may
        clock.offset += 30_000;
        return done('slow');
      });
      const job = jobOf(await start({ steps: ['slow()', 'never()'] }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row).toMatchObject({ state: 'timed_out', reason: 'timed_out', cellsRun: 1, providerState: 'closed' });
      expect(provider.state.codes).toHaveLength(1);
      expect(provider.sessions.size).toBe(0);
      expect(row.outputs).toHaveLength(0);
      expect(kept.files.size).toBe(0);
      expect((await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } }))[0]).toMatchObject({ quantity: BigInt(2), costMicros: BigInt(200) });
    });

    it('stops a run that does not answer by deleting the workspace, not by trusting the wait', async () => {
      provider.state.runs.push(() => ({ kind: 'timeout' }));
      const job = jobOf(await start({ code: 'while True: pass' }));
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'timed_out', providerState: 'closed' });
      expect(provider.adapter.close).toHaveBeenCalledTimes(1);
      expect(provider.sessions.size).toBe(0);
    });

    it('cancels a running job: the wait ends, the workspace is deleted, it settles once at what it used', async () => {
      provider.state.runs.push(provider.hang);
      const job = jobOf(await start({ code: 'while True: pass' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(provider.sessions.size).toBe(1);
      const cancelled = await cancelCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara }, deps());
      expect(cancelled).toMatchObject({ status: 'ok', job: { state: 'cancelled', reason: 'cancelled' } });
      await finishAll();
      expect(provider.sessions.size).toBe(0);
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'cancelled', providerState: 'closed', cellsRun: 1 });
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
      // Cancelling again, or a job that is not theirs, changes nothing
      expect(await cancelCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara }, deps())).toMatchObject({ status: 'ok', job: { state: 'cancelled' } });
      expect(await cancelCodeJob({ jobId: job.jobId, botId: saraBrick, personId: omar }, deps())).toMatchObject({ status: 'refused', reason: 'not_found' });
    });

    it('leaves no kept file behind when a cancel lands while the worker is still copying files', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('aaaa'));
        files.set('out/b.txt', text('bbbb'));
        return done('made files');
      });
      let jobId = '';
      const reading = provider.adapter.read.getMockImplementation() as NonNullable<ReturnType<typeof provider.adapter.read.getMockImplementation>>;
      provider.adapter.read.mockImplementation(async (call) => {
        // The file is read, then a cancel arrives in the middle of copying: it ends the job and cleans up before this worker keeps what it read
        const answer = await reading(call);
        if (provider.adapter.read.mock.calls.length === 1) await cancelCodeJob({ jobId, botId: saraBrick, personId: sara }, deps());
        return answer;
      });
      jobId = jobOf(await start({ code: 'print(1)' })).jobId;
      await finishAll();
      const row = await rowOf(jobId);
      expect(row.state).toBe('cancelled');
      expect(row.outputs).toHaveLength(0);
      expect(kept.files.size).toBe(0);
    });

    it('writes the meter line of a finished job the sweep finds without one, once', async () => {
      const job = jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      expect((await rowOf(job.jobId)).meteredAt).not.toBeNull();
      expect(await prisma.meterEvent.count({ where: { personId: sara, eventId: `codejob:${job.jobId}` } })).toBe(1);
      // The meter did not take it: no line and no mark
      await prisma.meterEvent.deleteMany({ where: { eventId: `codejob:${job.jobId}` } });
      await prisma.codeJob.update({ where: { id: job.jobId }, data: { meteredAt: null } });
      // Not at once: the job is given a minute to write its own
      expect((await sweepCodeJobs(deps())).metered).toBe(0);
      clock.offset += 61_000;
      expect((await sweepCodeJobs(deps())).metered).toBe(1);
      expect(await prisma.meterEvent.count({ where: { eventId: `codejob:${job.jobId}` } })).toBe(1);
      expect((await rowOf(job.jobId)).meteredAt).not.toBeNull();
      expect((await sweepCodeJobs(deps())).metered).toBe(0);
      expect(await prisma.meterEvent.count({ where: { eventId: `codejob:${job.jobId}` } })).toBe(1);
    });

    it('ends a job whose worker is still waiting past its deadline, from the sweep, and the worker does not settle it again', async () => {
      provider.state.runs.push(provider.hang);
      const job = jobOf(await start({ code: 'while True: pass' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Not yet: inside its time and the time to copy files
      expect((await sweepCodeJobs(deps())).stopped).toBe(0);
      clock.offset += 10_000 + 60_000 + 1_000;
      expect((await sweepCodeJobs(deps())).stopped).toBe(1);
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'timed_out', providerState: 'closed' });
      expect(provider.sessions.size).toBe(0);
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
    });

    it('ends a job whose process went away (no heartbeat), charged as if every run was used', async () => {
      const id = randomUUID();
      const session = await provider.adapter.open({ jobUserId: `codejob-${id}` });
      const past = new Date(Date.now() - 5 * 60_000);
      await prisma.codeJob.create({
        data: {
          id,
          jobKey: `lost-${tag}`,
          botId: saraBrick,
          personId: sara,
          state: 'running',
          capabilities: {},
          limits: LIMITS as unknown as object,
          reservedMicros: BigInt(400),
          codeHash: 'x',
          steps: 3,
          cellsRun: 1,
          providerUserId: `codejob-${id}`,
          providerSessionId: session.sessionId,
          providerState: 'open',
          deadlineAt: new Date(Date.now() + 60_000),
          heartbeatAt: past,
          createdAt: past,
        },
      });
      expect((await sweepCodeJobs(deps())).stopped).toBe(1);
      expect(await rowOf(id)).toMatchObject({ state: 'interrupted', reason: 'interrupted', providerState: 'closed', settledMicros: BigInt(400) });
      expect(provider.sessions.size).toBe(0);
    });

    it('keeps trying to delete a workspace the provider would not delete, and never calls it closed on a guess', async () => {
      provider.state.closeFails = 3;
      provider.state.runs.push(() => done());
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'succeeded', providerState: 'unknown' });
      expect(provider.sessions.size).toBe(1);
      expect((await sweepCodeJobs(deps())).closed).toBe(1);
      expect(await rowOf(job.jobId)).toMatchObject({ providerState: 'closed' });
      expect(provider.sessions.size).toBe(0);
      // Nothing more to do
      expect((await sweepCodeJobs(deps())).closed).toBe(0);
    });

    it('reads the provider’s log even while the delete is not confirmed, and again once it is, until a read has worked after it', async () => {
      provider.state.closeFails = 3;
      provider.state.nested = 2;
      provider.state.runs.push(() => done());
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      // The delete was not confirmed, and a run that was not ours is already known and already stops new jobs
      expect(await rowOf(job.jobId)).toMatchObject({ providerState: 'unknown', nestedCalls: 2, nestedCheckedAt: null });
      expect((await getCodeJobPause()).reason).toBe('provider_ran_tools');
      // Once the delete is confirmed the log is read again, and only a read after that counts as checked
      provider.state.nested = null;
      expect((await sweepCodeJobs(deps())).closed).toBe(1);
      expect(await rowOf(job.jobId)).toMatchObject({ providerState: 'closed', nestedCheckedAt: null });
      provider.state.nested = 3;
      await sweepCodeJobs(deps());
      const checked = await rowOf(job.jobId);
      expect(checked.nestedCheckedAt).not.toBeNull();
      expect(checked.nestedCalls).toBe(3);
      // Nothing more to read
      provider.adapter.nestedRuns.mockClear();
      await sweepCodeJobs(deps());
      expect(provider.adapter.nestedRuns).not.toHaveBeenCalled();
    });

    it('counts a workspace that may still be running as a job running and as owed at what was held, until its delete is confirmed', async () => {
      await saveCodeJobLimits({ atOnceAll: 1, atOncePerPerson: 1 }, boss);
      // Both the cancel and the worker's own end try to delete the workspace, each CLOSE_RETRIES times
      provider.state.closeFails = 6;
      // Cancelled at once: settles at nothing, but the workspace was not confirmed deleted
      provider.state.runs.push(provider.hang);
      const first = jobOf(await start({ code: 'while True: pass' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await cancelCodeJob({ jobId: first.jobId, botId: saraBrick, personId: sara }, deps());
      await finishAll();
      expect(await rowOf(first.jobId)).toMatchObject({ state: 'cancelled', providerState: 'unknown' });
      // It is not running as far as the job goes, yet a second job waits: its workspace may still be running code
      expect(await start({ code: 'print(1)' })).toMatchObject({ status: 'refused', reason: 'busy' });
      expect(await readCodeJobsBudget()).toMatchObject({ running: 0, workspacesNotConfirmedDeleted: 1, owedWhileUncertainMicros: 200, settledMicros: 0 });
      // Confirmed gone: it counts at what it settled at, and the next job may start
      expect((await sweepCodeJobs(deps())).closed).toBe(1);
      expect(await readCodeJobsBudget()).toMatchObject({ workspacesNotConfirmedDeleted: 0, owedWhileUncertainMicros: 0 });
      provider.state.runs.push(() => done());
      jobOf(await start({ code: 'print(1)' }));
      await finishAll();
    });

    it('holds the ceiling at what was held, not at what a job settled at, while its delete is unconfirmed', async () => {
      await saveCodeJobLimits({ atOnceAll: 5, atOncePerPerson: 5, exposureCeilingMicros: 300 }, boss);
      // A job that ended and settled at nothing, whose workspace could not be confirmed deleted
      const id = randomUUID();
      const session = await provider.adapter.open({ jobUserId: `codejob-${id}` });
      const earlier = new Date(Date.now() - 60_000);
      await prisma.codeJob.create({
        data: {
          id,
          jobKey: `unsure-${tag}`,
          botId: saraBrick,
          personId: sara,
          state: 'cancelled',
          reason: 'cancelled',
          capabilities: {},
          limits: LIMITS as unknown as object,
          reservedMicros: BigInt(200),
          settledMicros: BigInt(0),
          codeHash: 'x',
          steps: 1,
          providerUserId: `codejob-${id}`,
          providerSessionId: session.sessionId,
          providerState: 'unknown',
          deadlineAt: earlier,
          heartbeatAt: earlier,
          finishedAt: earlier,
          meteredAt: earlier,
          createdAt: earlier,
        },
      });
      // Still held at 200: another job needs 200 more, and 400 is over 300
      expect(await start({ code: 'print(2)' })).toMatchObject({ status: 'refused', reason: 'exposure_full' });
      // Confirmed gone, it counts at what it settled at (nothing) and there is room again
      expect((await sweepCodeJobs(deps())).closed).toBe(1);
      provider.state.runs.push(() => done());
      jobOf(await start({ code: 'print(2)' }));
      await finishAll();
    });

    it('says it is the provider’s own limit when the provider will not make a workspace, and charges nothing', async () => {
      provider.adapter.open.mockRejectedValueOnce(new AdapterError('provider', 'Provider answered 429', 429));
      const job = jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'failed', reason: 'provider_limit', cellsRun: 0, preparedRuns: 0, settledMicros: BigInt(0), providerState: 'none' });
      const view = await getCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara, waitSeconds: 0 }, deps());
      expect(view).toMatchObject({ status: 'ok', job: { reason: 'provider_limit' } });
      provider.adapter.open.mockRejectedValueOnce(new AdapterError('provider', 'Provider answered 500', 500));
      const other = jobOf(await start({ code: 'print(2)' }));
      await finishAll();
      expect(await rowOf(other.jobId)).toMatchObject({ state: 'failed', reason: 'unavailable' });
    });

    it('stops new jobs when the provider ran something that was not ours in a workspace that has no tools', async () => {
      provider.state.nested = 2;
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ nestedCalls: 2 });
      expect((await getCodeJobPause()).reason).toBe('provider_ran_tools');
      expect(await start({ code: 'x' })).toMatchObject({ status: 'refused', reason: 'paused' });
      await resumeCodeJobs(boss);
      provider.state.nested = null;
      jobOf(await start({ code: 'x' }));
      await finishAll();
      // A log that could not be asked is not a reason to pause
      expect((await getCodeJobPause()).paused).toBe(false);
    });
  });

  describe('on the App link, where the Brick meets it', () => {
    const KEYU = KEY.toUpperCase();
    const message = (name: string, args: Record<string, unknown>, id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const link = (msg: Record<string, unknown>, callId: string | null = `link-${(seq += 1)}-${tag}`) => linkReadyMade({ botId: saraBrick, connectionId, ownerId: sara, message: msg, sessionId: null, callId });
    const provider200 = (body: unknown) => ({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: JSON.stringify(body) });
    const answerOf = async (outcome: Awaited<ReturnType<typeof link>>) => {
      if (outcome.status !== 'done') throw new Error(`not done: ${outcome.status}`);
      return JSON.parse(outcome.answer.body) as { id: unknown; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
    };
    const asJson = (text: string): Record<string, unknown> => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { message: text };
      }
    };
    const toolResult = async (outcome: Awaited<ReturnType<typeof link>>) => {
      const answer = await answerOf(outcome);
      return { isError: answer.result?.isError, body: asJson(answer.result?.content?.[0].text ?? 'null') };
    };
    let bridge: ReadyMadeAdapter & { callLink: jest.Mock; use: jest.Mock };

    beforeEach(() => {
      bridge = {
        workbench: provider.adapter,
        startConnect: jest.fn(),
        connectionStatus: jest.fn(async () => 'active' as const),
        appLink: jest.fn(),
        callLink: jest.fn(async () => provider200({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'CRM_THING' }, { name: 'COMPOSIO_REMOTE_WORKBENCH' }, { name: 'composio_remote_bash_tool' }, { name: 'COMPOSIO_SEARCH_TOOLS' }] } })),
        use: jest.fn(async () => ({ ok: true, data: { rows: [1] }, error: null, providerCallId: 'log' })),
      } as unknown as ReadyMadeAdapter & { callLink: jest.Mock; use: jest.Mock };
      setAdapterForTests(bridge);
    });

    it('takes the provider’s sandbox tools out of the list and offers the three code job tools instead', async () => {
      const answer = await answerOf(await link({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null));
      expect(answer.result?.tools?.map((tool) => tool.name)).toEqual(['CRM_THING', 'COMPOSIO_SEARCH_TOOLS', 'UNIVERSE_CODE_JOB_START', 'UNIVERSE_CODE_JOB_RESULT', 'UNIVERSE_CODE_JOB_CANCEL']);
      // Not on a later page of the list, and not at all while code jobs cannot run
      const second = await answerOf(await link({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'next' } }, null));
      expect(second.result?.tools?.map((tool) => tool.name)).toEqual(['CRM_THING', 'COMPOSIO_SEARCH_TOOLS']);
      await saveCodeJobLimits({ maxCells: null }, boss);
      expect((await answerOf(await link({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null))).result?.tools?.map((tool) => tool.name)).toEqual(['CRM_THING', 'COMPOSIO_SEARCH_TOOLS']);
      await saveCodeJobLimits(LIMITS, boss);
      setAdapterForTests({ ...bridge, workbench: undefined } as ReadyMadeAdapter);
      expect((await answerOf(await link({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null))).result?.tools?.map((tool) => tool.name)).toEqual(['CRM_THING', 'COMPOSIO_SEARCH_TOOLS']);
    });

    it('refuses the provider’s own sandbox tools, alone, in another case and inside a batch: nothing is sent, nothing is counted', async () => {
      for (const msg of [
        message('COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: 'import os' }),
        message('composio_remote_bash_tool', { command: 'ls' }),
        message('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'CRM_THING', arguments: {} }, { tool_slug: ' composio_remote_workbench ', arguments: { code_to_execute: 'x' } }] }),
      ]) {
        const result = await toolResult(await link(msg));
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.body)).toContain('UNIVERSE_CODE_JOB_START');
      }
      expect(bridge.callLink).not.toHaveBeenCalled();
      expect(await prisma.meterEvent.count({ where: { personId: sara } })).toBe(0);
      // An ordinary batch still goes through, and is counted
      const ordinary = await link(message('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'CRM_THING', arguments: {} }] }));
      expect(ordinary.status).toBe('done');
      expect(bridge.callLink).toHaveBeenCalledTimes(1);
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
    });

    it('starts a job, answers at once, and gives the outcome when asked, with no call to the provider’s link', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/summary.txt', text('three rows'));
        return done('3 rows');
      });
      const started = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'print(3)', reads: [{ tool: `${KEYU}_LIST`, arguments: { n: 3 } }] })));
      expect(started.isError).toBe(false);
      expect(started.body).toMatchObject({ status: 'running', state: 'running' });
      const jobId = started.body.jobId as string;
      const result = await toolResult(await link(message('UNIVERSE_CODE_JOB_RESULT', { jobId })));
      expect(result.isError).toBe(false);
      expect(result.body).toMatchObject({ status: 'succeeded', jobId, runs: [{ n: 1, ok: true, printed: '3 rows' }], files: [{ name: 'summary.txt', preview: 'three rows' }] });
      expect(bridge.callLink).not.toHaveBeenCalled();
      // The read was the person's own App use, counted like any other, and Orbit ran it
      expect(bridge.use).toHaveBeenCalledWith(expect.objectContaining({ tool: `${KEYU}_LIST`, arguments: { n: 3 }, providerAccountId: `ca_${tag}` }));
      const events = await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' }, orderBy: { eventId: 'asc' } });
      expect(events.map((event) => event.eventId.startsWith('codejob:') || event.eventId.includes(':read:'))).toEqual([true, true]);
    });

    it('answers a refusal as a tool result that says why, never as an error that stops the Brick', async () => {
      const refused = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'x', bogus: true })));
      expect(refused).toMatchObject({ isError: true, body: { status: 'refused', reason: 'bad_request' } });
      const missing = await toolResult(await link(message('UNIVERSE_CODE_JOB_RESULT', {})));
      expect(missing).toMatchObject({ isError: true, body: { reason: 'bad_request' } });
      const nothing = await toolResult(await link(message('UNIVERSE_CODE_JOB_RESULT', { jobId: randomUUID() })));
      expect(nothing).toMatchObject({ isError: true, body: { reason: 'not_found' } });
    });

    describe('an App answer too big for a Brick', () => {
      const bigAnswer = (bytes: number) => provider200({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'x'.repeat(bytes) }], isError: false } });

      it('is never cut or half passed on: the Brick is told it ran, how big it was, and that a code job can read all of it', async () => {
        await saveCodeJobLimits({ maxAnswerBytes: 10_000 }, boss);
        bridge.callLink.mockResolvedValueOnce(bigAnswer(30_000));
        const result = await toolResult(await link(message('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'CRM_THING', arguments: {} }, { tool_slug: 'CRM_OTHER', arguments: {} }] })));
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ status: 'answer_too_large', ran: true, counted: 'once', tools: ['CRM_THING', 'CRM_OTHER'], limitBytes: 10_000 });
        expect(result.body.answerBytes as number).toBeGreaterThan(30_000);
        const words = String(result.body.message);
        expect(words).toContain('Nothing was cut and nothing was passed on');
        expect(words).toContain('UNIVERSE_CODE_JOB_START');
        expect(words).toContain('it already ran');
        expect(JSON.stringify(result.body)).not.toContain('xxxxxxxxxx');
        // The provider was asked once and the meter has one line: telling the Brick does not run it or count it again
        expect(bridge.callLink).toHaveBeenCalledTimes(1);
        expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
      });

      it('names the one tool, and offers no code job when code jobs cannot run', async () => {
        await saveCodeJobLimits({ maxAnswerBytes: 10_000, maxCells: null }, boss);
        bridge.callLink.mockResolvedValueOnce(bigAnswer(30_000));
        const result = await toolResult(await link(message('CRM_THING', {})));
        expect(result.body).toMatchObject({ status: 'answer_too_large', tools: ['CRM_THING'] });
        expect(String(result.body.message)).toContain('Ask for less');
        expect(String(result.body.message)).not.toContain('UNIVERSE_CODE_JOB_START');
      });

      it('passes on whole an answer inside the Limit, an error answer, and every answer while the Limit is empty', async () => {
        await saveCodeJobLimits({ maxAnswerBytes: 10_000 }, boss);
        bridge.callLink.mockResolvedValueOnce(bigAnswer(5_000));
        const small = await answerOf(await link(message('CRM_THING', {})));
        expect(small.result?.content?.[0].text).toHaveLength(5_000);
        bridge.callLink.mockResolvedValueOnce({ status: 500, contentType: 'text/plain', sessionId: null, body: 'e'.repeat(30_000) });
        const failed = await link(message('CRM_THING', {}));
        expect(failed).toMatchObject({ status: 'done', answer: { status: 500 } });
        await saveCodeJobLimits({ maxAnswerBytes: null }, boss);
        bridge.callLink.mockResolvedValueOnce(bigAnswer(300_000));
        const whole = await answerOf(await link(message('CRM_THING', {})));
        expect(whole.result?.content?.[0].text).toHaveLength(300_000);
      });
    });

    it('tells a Brick with no computer that it needs one when code jobs cannot run, and never sets one up', async () => {
      await prisma.appSetting.upsert({ where: { key: 'code-job-state' }, create: { key: 'code-job-state', value: { paused: true, reason: 'manual' } }, update: { value: { paused: true, reason: 'manual' } } });
      const none = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'print(1)' })));
      expect(none).toMatchObject({ isError: true, body: { status: 'refused', reason: 'paused' } });
      expect(String(none.body.next)).toContain('has no computer');
      expect(String(none.body.next)).toContain('they can give the Brick one');
      expect(await prisma.brickComputer.count({ where: { botId: saraBrick } })).toBe(0);
      // With a computer it is pointed to it, and a "wait a moment" refusal says nothing about computers
      await prisma.brickComputer.create({ data: { botId: saraBrick, enabled: true } });
      try {
        const has = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'print(1)' })));
        expect(String(has.body.next)).toContain('has a computer');
      } finally {
        await prisma.brickComputer.deleteMany({ where: { botId: saraBrick } });
      }
      await resumeCodeJobs(boss);
      const bad = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'x', bogus: true })));
      expect(bad.body.next).toBeUndefined();
    });

    it('lets only the Brick it was made for ask about a job, and cancels one that is running', async () => {
      provider.state.runs.push(provider.hang);
      const started = await toolResult(await link(message('UNIVERSE_CODE_JOB_START', { code: 'while True: pass' })));
      const jobId = started.body.jobId as string;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const otherBrick = (await createBrick({ ownerId: sara, name: 'Other' })).id;
      expect(await getCodeJob({ jobId, botId: otherBrick, personId: sara }, deps())).toMatchObject({ status: 'refused', reason: 'not_found' });
      const cancelled = await toolResult(await link(message('UNIVERSE_CODE_JOB_CANCEL', { jobId })));
      expect(cancelled.body).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(provider.sessions.size).toBe(0);
    });
  });

  describe('code jobs as an Apps line of the Budget', () => {
    it('adds up what is settled, held and owed while a workspace is unconfirmed, and looks ahead from this month with its sample', async () => {
      provider.state.runs.push(() => done());
      jobOf(await start({ code: 'print(1)' }));
      await finishAll();
      const line = await readCodeJobsBudget();
      expect(line).toMatchObject({ line: 'code_jobs', settledMicros: 200, heldMicros: 0, owedWhileUncertainMicros: 0, countedMicros: 200, runsThisMonth: 2, running: 0, runPriceMicros: 100, logsNotYetChecked: 0 });
      expect(line.forecast?.sample.jobs).toBe(1);
      expect(line.forecast?.monthMicros).toBeGreaterThanOrEqual(200);
      // Held while it goes
      provider.state.runs.push(provider.hang);
      const going = jobOf(await start({ code: 'while True: pass' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readCodeJobsBudget()).toMatchObject({ heldMicros: 200, running: 1, countedMicros: 400 });
      await cancelCodeJob({ jobId: going.jobId, botId: saraBrick, personId: sara }, deps());
      await finishAll();
    });
  });

  describe('races and retries: a run is never sent after the end, and nothing a failure left behind is forgotten', () => {
    const actualState = jest.requireActual('@/lib/workbench/state') as typeof stateModule;
    const pauseMock = stateModule.pauseCodeJobs as jest.MockedFunction<typeof stateModule.pauseCodeJobs>;
    const pauseReadMock = stateModule.getCodeJobPause as jest.MockedFunction<typeof stateModule.getCodeJobPause>;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    afterEach(() => {
      pauseMock.mockImplementation(actualState.pauseCodeJobs);
      pauseReadMock.mockImplementation(actualState.getCodeJobPause);
    });

    it('never sends a run when a cancel lands between the last look at the job and the claim of the run, and settles at nothing', async () => {
      let armed = false;
      const opening = provider.adapter.open.getMockImplementation() as NonNullable<ReturnType<typeof provider.adapter.open.getMockImplementation>>;
      provider.adapter.open.mockImplementation(async (call) => {
        const answer = await opening(call);
        armed = true;
        return answer;
      });
      const real = prisma.codeJob.findUnique.bind(prisma.codeJob);
      const spy = jest.spyOn(prisma.codeJob, 'findUnique').mockImplementation(((args: { where: { id: string } }) => {
        if (!armed) return real(args as never);
        armed = false;
        // The worker has just read "still going"; a cancel from another process (this process's own signal is not involved) lands before it claims its run
        return (async () => {
          const row = await real(args as never);
          await prisma.codeJob.updateMany({ where: { id: args.where.id }, data: { state: 'cancelled', reason: 'cancelled', finishedAt: new Date(), settledMicros: BigInt(0) } });
          return row;
        })();
      }) as never);
      try {
        const job = jobOf(await start({ code: 'print(1)' }));
        await finishAll();
        const row = await rowOf(job.jobId);
        expect(row).toMatchObject({ state: 'cancelled', cellsRun: 0, preparedRuns: 0, settledMicros: BigInt(0), providerState: 'closed' });
        expect(provider.state.prepared).toBe(0);
        expect(provider.state.codes).toHaveLength(0);
        expect(provider.adapter.run).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps a job open for the sweep when the pause for a run that was not ours could not be written, until it is', async () => {
      provider.state.nested = 2;
      pauseMock.mockRejectedValueOnce(new Error('settings table down'));
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      // Not marked as checked, and nothing paused yet
      expect(await rowOf(job.jobId)).toMatchObject({ nestedCalls: 2, nestedCheckedAt: null, providerState: 'closed' });
      expect((await getCodeJobPause()).paused).toBe(false);
      // The sweep reads the log again and this time the pause is written, and only then is it marked
      await sweepCodeJobs(deps());
      expect((await getCodeJobPause()).reason).toBe('provider_ran_tools');
      expect((await rowOf(job.jobId)).nestedCheckedAt).not.toBeNull();
    });

    it('says it failed when the pause could not be read inside its own transaction, instead of reading that as already paused', async () => {
      const realTransaction = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
        realTransaction((tx) =>
          fn(
            new Proxy(tx as object, {
              get: (target, prop) =>
                prop === 'appSetting'
                  ? { findUnique: async () => Promise.reject(new Error('canceling statement due to statement timeout')), upsert: (target as { appSetting: { upsert: (a: unknown) => unknown } }).appSetting.upsert }
                  : Reflect.get(target, prop),
            }),
          ),
        )) as never);
      try {
        await expect(actualState.pauseCodeJobs('provider_ran_tools')).rejects.toThrow('statement timeout');
      } finally {
        spy.mockRestore();
      }
      expect((await getCodeJobPause()).paused).toBe(false);
      // And with the read working it is written
      expect(await actualState.pauseCodeJobs('provider_ran_tools')).toMatchObject({ paused: true, reason: 'provider_ran_tools' });
    });

    it('does not let jobs whose log cannot be read keep a newer job out of the sweep: those tried go behind the ones not tried yet', async () => {
      // A batch of the oldest jobs whose provider log keeps failing, and one newer job whose log reads fine
      const base = Date.now() - 60 * 60_000;
      const row = (name: string, at: Date) => ({
        jobKey: `${name}-${tag}`,
        botId: saraBrick,
        personId: sara,
        state: 'cancelled',
        reason: 'cancelled',
        capabilities: {},
        limits: LIMITS as unknown as object,
        reservedMicros: BigInt(0),
        settledMicros: BigInt(0),
        codeHash: 'x',
        steps: 1,
        providerUserId: `codejob-${name}-${tag}`,
        providerSessionId: `${name}-session-${tag}`,
        providerState: 'closed',
        deadlineAt: at,
        heartbeatAt: at,
        finishedAt: at,
        meteredAt: at,
        createdAt: at,
      });
      await prisma.codeJob.createMany({ data: Array.from({ length: 60 }, (_, index) => row(`bad${index}`, new Date(base + index * 1000))) });
      await prisma.codeJob.create({ data: row('good', new Date(base + 3_600_000)) });
      const failing = provider.adapter.nestedRuns.getMockImplementation() as NonNullable<ReturnType<typeof provider.adapter.nestedRuns.getMockImplementation>>;
      provider.adapter.nestedRuns.mockImplementation((async (call: { sessionId: string }) => {
        if (call.sessionId.startsWith('bad')) throw new Error('provider log unavailable');
        return 0;
      }) as never);
      try {
        const goodId = (await prisma.codeJob.findFirstOrThrow({ where: { jobKey: `good-${tag}` } })).id;
        // The first sweep takes the oldest batch (all failing); the second takes the ones not tried yet first, and reaches the newer job
        await sweepCodeJobs(deps());
        await sweepCodeJobs(deps());
        expect((await rowOf(goodId)).nestedCheckedAt).not.toBeNull();
      } finally {
        provider.adapter.nestedRuns.mockImplementation(failing);
      }
    });

    it('keeps the workspace id of a job that ended while the workspace was being made, when deleting it then fails, and the sweep deletes it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const opening = provider.adapter.open.getMockImplementation() as NonNullable<ReturnType<typeof provider.adapter.open.getMockImplementation>>;
      provider.adapter.open.mockImplementation(async (call) => {
        const answer = await opening(call);
        await gate;
        return answer;
      });
      provider.state.runs.push(() => done());
      const job = jobOf(await start({ code: 'x' }));
      await wait(100);
      // Ended (no workspace id is written down yet), then the workspace appears and every delete fails
      await cancelCodeJob({ jobId: job.jobId, botId: saraBrick, personId: sara }, deps());
      provider.state.closeFails = 100;
      release();
      await finishAll();
      expect(await rowOf(job.jobId)).toMatchObject({ state: 'cancelled', providerState: 'unknown', providerSessionId: expect.stringMatching(/^trs_/) });
      expect(provider.sessions.size).toBe(1);
      provider.state.closeFails = 0;
      expect((await sweepCodeJobs(deps())).closed).toBe(1);
      expect(provider.sessions.size).toBe(0);
      expect(await rowOf(job.jobId)).toMatchObject({ providerState: 'closed' });
    });

    it('finds again the files of a cancelled job that could not be removed at the time, and removes them from the sweep', async () => {
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('aaaa'));
        return done('made files');
      });
      let jobId = '';
      const reading = provider.adapter.read.getMockImplementation() as NonNullable<ReturnType<typeof provider.adapter.read.getMockImplementation>>;
      provider.adapter.read.mockImplementation(async (call) => {
        const answer = await reading(call);
        if (provider.adapter.read.mock.calls.length === 1) await cancelCodeJob({ jobId, botId: saraBrick, personId: sara }, deps());
        return answer;
      });
      // The store will not remove anything for now
      const removing = kept.store.remove;
      kept.store.remove = async () => {
        throw new Error('store down');
      };
      jobId = jobOf(await start({ code: 'print(1)' })).jobId;
      await finishAll();
      expect((await rowOf(jobId)).state).toBe('cancelled');
      expect((await rowOf(jobId)).outputs).toHaveLength(1);
      // The store is back: the sweep removes what the cancel left, rows and files
      kept.store.remove = removing;
      expect((await sweepCodeJobs(deps())).outputsRemoved).toBe(1);
      expect((await rowOf(jobId)).outputs).toHaveLength(0);
      expect(kept.files.size).toBe(0);
      expect((await sweepCodeJobs(deps())).outputsRemoved).toBe(0);
    });

    it('refuses a job when a pause lands after admission first looked, as the same lock admission holds sees it', async () => {
      // The first look says "not paused", and a pause is written right after it
      pauseReadMock.mockImplementationOnce(async () => {
        await actualState.pauseCodeJobs('manual', boss);
        return { paused: false, reason: null, at: null };
      });
      expect(await start({ code: 'print(1)' })).toMatchObject({ status: 'refused', reason: 'paused' });
      expect(provider.adapter.open).not.toHaveBeenCalled();
      expect(await prisma.codeJob.count({ where: { personId: sara } })).toBe(0);
    });
  });

  describe('files kept by a job: the owner’s room is held by the read and by the insert, from the bytes really received', () => {
    it('does not read a file past the owner’s room even when the listing said it was small', async () => {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 10, maxOutputBytes: 1_000 }, boss);
      // The listing says 5 bytes, the file is 50
      provider.adapter.list.mockImplementationOnce(async () => [{ path: 'out/a.txt', bytes: 5 }]);
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('x'.repeat(50)));
        return done();
      });
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.outputs).toHaveLength(0);
      expect(provider.adapter.read.mock.calls[0][0]).toMatchObject({ maxBytes: 10 });
      expect((row.result as { notKept: { name: string; why: string }[] }).notKept[0]).toMatchObject({ name: 'a.txt', why: expect.stringMatching(/kept files are full/) });
    });

    it('does not keep a file whose bytes really received are past the owner’s room, whatever the provider answered', async () => {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 10, maxOutputBytes: 1_000 }, boss);
      provider.state.runs.push(({ files }) => {
        files.set('out/a.txt', text('12345'));
        return done();
      });
      // A provider that hands over more than it was allowed to
      provider.adapter.read.mockImplementationOnce(async () => ({ kind: 'ok' as const, bytes: text('x'.repeat(40)) }));
      const job = jobOf(await start({ code: 'x' }));
      await finishAll();
      const row = await rowOf(job.jobId);
      expect(row.outputs).toHaveLength(0);
      expect(kept.files.size).toBe(0);
      expect((row.result as { notKept: { why: string }[] }).notKept[0].why).toMatch(/kept files are full/);
    });

    it('lets only what fits in when several are kept at once for one owner, and leaves no stored file for the ones that did not', async () => {
      const keep = (name: string) => keepResult({ ownerId: sara, sourceKind: 'code_job', sourceId: randomUUID(), makerBotId: saraBrick, makerName: 'Brick', name, contentType: 'text/plain', bytes: text('12345678'), limitBytes: 10 }, kept.store);
      const outcomes = await Promise.all([keep('a'), keep('b'), keep('c'), keep('d')]);
      expect(outcomes.filter((outcome) => outcome.status === 'kept')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'over_limit')).toEqual(Array(3).fill({ status: 'over_limit', keptBytes: 8, limitBytes: 10 }));
      expect(await prisma.ownedResult.count({ where: { ownerId: sara } })).toBe(1);
      expect(kept.files.size).toBe(1);
      // No limit given: nothing is checked
      expect((await keepResult({ ownerId: sara, sourceKind: 'code_job', sourceId: randomUUID(), makerBotId: saraBrick, makerName: 'Brick', name: 'e', contentType: 'text/plain', bytes: text('12345678') }, kept.store)).status).toBe('kept');
    });

    it('removes the results of one job by the ids it chose, so one made while it was removing keeps its row and its file', async () => {
      const sourceId = randomUUID();
      const make = (name: string) => keepResult({ ownerId: sara, sourceKind: 'code_job', sourceId, makerBotId: saraBrick, makerName: 'Brick', name, contentType: 'text/plain', bytes: text(name) }, kept.store);
      await make('old');
      const removing = kept.store.remove;
      kept.store.remove = async (keys) => {
        await removing(keys);
        // A result for the same source arrives while the files are being removed
        await make('new');
      };
      try {
        await removeResultsOf('code_job', sourceId, kept.store);
      } finally {
        kept.store.remove = removing;
      }
      const left = await prisma.ownedResult.findMany({ where: { ownerId: sara, sourceKind: 'code_job', sourceId } });
      expect(left.map((row) => row.name)).toEqual(['new']);
      expect(await kept.store.get(left[0].storageKey)).toEqual(text('new'));
    });

    it('lists results made at the same moment across pages without losing or repeating one', async () => {
      const at = new Date('2026-11-17T10:00:00.000Z');
      const ids: string[] = [];
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        const made = await keepResult({ ownerId: sara, sourceKind: 'code_job', sourceId: randomUUID(), makerBotId: saraBrick, makerName: 'Brick', name, contentType: 'text/plain', bytes: text(name) }, kept.store);
        if (made.status !== 'kept') throw new Error('not kept');
        ids.push(made.row.id);
      }
      await prisma.ownedResult.updateMany({ where: { ownerId: sara }, data: { createdAt: at } });
      const seen: string[] = [];
      let before: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const listed: Awaited<ReturnType<typeof listResults>> = await listResults(sara, { limit: 2, before });
        seen.push(...listed.results.map((result) => result.id));
        if (!listed.next) break;
        before = listed.next;
      }
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('an App answer that is too big', () => {
    const big = (body: unknown) => ({ status: 200, contentType: 'application/json', sessionId: null, body: JSON.stringify(body) });
    const padded = { content: [{ type: 'text', text: 'x'.repeat(30_000) }] };

    it('is said plainly when it ran fine, and passed on as it is when it was an error of any kind', async () => {
      await saveCodeJobLimits({ maxAnswerBytes: 10_000 }, boss);
      const fine = await boundAppAnswer(big({ jsonrpc: '2.0', id: 1, result: { ...padded, isError: false } }), 1, 'CRM_LIST', {});
      expect(JSON.parse(fine.body).result.content[0].text).toContain('answer_too_large');
      // A failure is never turned into "it ran"
      const failed = big({ jsonrpc: '2.0', id: 1, result: { ...padded, isError: true } });
      expect(await boundAppAnswer(failed, 1, 'CRM_LIST', {})).toBe(failed);
      const rpcError = big({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x'.repeat(30_000) } });
      expect(await boundAppAnswer(rpcError, 1, 'CRM_LIST', {})).toBe(rpcError);
    });
  });

  describe('the Limits screen’s own route', () => {
    const patch = (body: unknown) => adminPatch(new NextRequest('http://localhost/api/admin/workbench', { method: 'PATCH', body: JSON.stringify(body) }));

    it('is for a super admin only, shows every Limit with its words and range, and saves inside the ranges', async () => {
      mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
      expect((await adminGet(new NextRequest('http://localhost/api/admin/workbench'))).status).toBe(403);
      expect((await patch({ maxSeconds: 20 })).status).toBe(403);
      mockUser.current = { id: boss, email: 'boss@example.test' };
      const shown = await (await adminGet(new NextRequest('http://localhost/api/admin/workbench'))).json();
      expect(Object.keys(shown.limits).sort()).toEqual(Object.keys(CODE_JOB_LIMITS_RECOMMENDED).sort());
      expect(shown.limits.maxSeconds).toMatchObject({ value: 10, recommended: 300, unit: 'seconds', required: true });
      expect(shown.limits.keepDays.required).toBe(false);
      expect(shown.missing).toEqual([]);
      // The third Apps line of the Budget page, under the Limits' own keys: the ceiling, jobs at once, and what is counted against the ceiling
      expect(shown.budget).toMatchObject({ line: 'code_jobs', budgetMicros: LIMITS.exposureCeilingMicros, atOnceAll: LIMITS.atOnceAll, atOncePerPerson: LIMITS.atOncePerPerson, countedMicros: 0, owedWhileUncertainMicros: 0, paused: false, forecast: null });
      expect((await patch({ maxSeconds: 5 })).status).toBe(400);
      expect((await patch({ waitSeconds: 60 })).status).toBe(400);
      expect((await patch({ madeUp: 1 })).status).toBe(400);
      const saved = await (await patch({ maxSeconds: 20, keepDays: null })).json();
      expect(saved.limits.maxSeconds.value).toBe(20);
      expect(saved.limits.keepDays.value).toBeNull();
      const emptied = await (await patch({ maxCells: null })).json();
      expect(emptied.missing).toEqual(['maxCells']);
    });
  });
});
