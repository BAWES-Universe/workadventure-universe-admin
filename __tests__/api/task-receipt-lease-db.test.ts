/**
 * Receipts that always settle (0.5.0 money fixes, O1), against a real database, a FAKE credit source and a FAKE provider. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database. Composio is never called.
 *
 * GPT's five cases are each a test here, and none of them starts another outside action (the provider's `run` is counted):
 *   1. the bot process is lost mid-turn;
 *   2. a close is taken but its answer is lost;
 *   3. a real slow run is still active;
 *   4. a mixed task;
 *   5. a task with no run but with unrelated model usage.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { setAdapterForTests, type InstantAdapter, type InstantCall, type InstantLog, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { instantRunKey, reconcileRun, runInstant, setInstantHooks } from '@/lib/instant/executor';
import { setInstantFunds, type InstantFunds } from '@/lib/instant/funds';
import { resumeInstant, saveInstantLimits } from '@/lib/instant/state';
import { forgetDriftClock, sweepInstant } from '@/lib/instant/sweep';
import { instantRulesAndReceipts } from '@/lib/instant/rules-and-receipts';
import { activityFor, closeReceipt, openReceipt, RECEIPT_LEASE_MS, renewReceipt, settleCheckingReceipts, settleReceipt, touchLeaseForRun, UNWATCHED_CHECKING_WAIT_MS } from '@/lib/task-receipts';
import { HOLD_BEING_RELEASED, HOLD_RELEASED, NOTHING_TAKEN, OUTCOME_WORDS, actionWords, outcomeNote } from '@/lib/task-receipt-words';
import { POST as postReceipt } from '@/app/api/bots/[id]/task-receipts/route';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const MIN = 60 * 1000;
// A day ahead of the real clock: the sweeps here are told a time past every row's own (database-clock) updated_at and Orbit's real-clock lease, whenever the suite runs
const START = new Date(Date.now() + 24 * 60 * MIN);
const at = (minutes: number) => new Date(START.getTime() + minutes * MIN);

/** A pretend credit source: a balance, holds by key, and the same idempotence the real books promise. */
function fakeFunds(balance: number) {
  const holds = new Map<string, { amount: number; state: 'held' | 'charged' | 'released'; charged: number }>();
  const funds = {
    reserve: jest.fn(async (input: { key: string; amountMicros: number }): ReturnType<InstantFunds['reserve']> => {
      if (holds.has(input.key)) return { ok: true as const, created: false };
      holds.set(input.key, { amount: input.amountMicros, state: 'held', charged: 0 });
      return { ok: true as const, created: true };
    }),
    settle: jest.fn(async (input: { key: string; chargeMicros: number }): Promise<{ ok: true; chargedMicros: number } | { ok: false }> => {
      const hold = holds.get(input.key);
      if (!hold) return { ok: false };
      if (hold.state === 'held') {
        hold.state = 'charged';
        hold.charged = input.chargeMicros;
      }
      return { ok: true, chargedMicros: hold.charged };
    }),
    release: jest.fn(async (input: { key: string }) => {
      const hold = holds.get(input.key);
      if (hold && hold.state === 'held') hold.state = 'released';
      return { ok: !!hold };
    }),
    refund: jest.fn(async (input: { amountMicros: number }) => ({ ok: true, refundedMicros: input.amountMicros })),
    // Read only: these tests never give anything back, so the books never hold a give-back under a key
    refundLookup: jest.fn(async (): ReturnType<InstantFunds['refundLookup']> => ({ status: 'none' as const })),
  } satisfies InstantFunds;
  void balance;
  return { funds, holds };
}

type Script = { runs: (InstantCall | Error)[]; byUser: Map<string, InstantLog[]> };
function fakeProvider() {
  const script: Script = { runs: [], byUser: new Map() };
  const instant = {
    run: jest.fn(async () => {
      const next = script.runs.shift();
      if (next instanceof Error) throw next;
      return next ?? ({ kind: 'done', successful: true, data: { hits: 1 }, error: null, logId: `log-${randomUUID().slice(0, 6)}`, chargeMicros: 7_000 } as InstantCall);
    }),
    log: jest.fn(async () => null),
    findLogs: jest.fn(async (input: { userId: string }) => script.byUser.get(input.userId) ?? []),
    tool: jest.fn(async () => null),
    sessionInstant: jest.fn(async () => 'allowed' as const),
    denySessionInstant: jest.fn(async () => 'denied' as const),
  } satisfies InstantAdapter;
  const adapter = { instant } as unknown as ReadyMadeAdapter;
  const line = (userId: string, status: InstantLog['status'], chargeMicros: number | null): InstantLog => ({ id: `line-${randomUUID().slice(0, 6)}`, status, chargeMicros, credentialSource: 'instant', tool: 'EXA_SEARCH', userId, atMs: Date.now() });
  return { adapter, instant, script, line };
}

let sara = '';
let omar = '';
let brick = '';
const callId = () => `call-${randomUUID()}`;
const json = (body: unknown) => new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** An Instant run as the executor's own records would hold it, for tests that need a state the executor takes time to reach. */
const makeRun = (taskKey: string | null, state: string, over: Record<string, unknown> = {}) =>
  prisma.instantRun.create({
    data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, taskKey, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state, customerState: state === 'succeeded' ? 'charged' : 'none', providerUserId: `u-${randomUUID().slice(0, 6)}`, ...over } as never,
  });
const receipt = (taskKey: string) => prisma.taskReceipt.findFirstOrThrow({ where: { botId: brick, taskKey } });
const open = (taskKey: string, over: Record<string, unknown> = {}, now = START) => openReceipt({ botId: brick, personId: sara, taskKey, title: 'Find the weather', category: 'apps', ...over }, now);
const setLimits = () => saveInstantLimits({ maxRunMicros: 50_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 5_000, pauseMinRuns: 10 }, sara);
async function giveApp(botId: string, ownerId: string, toolkit: string) {
  const connection = await prisma.appConnection.create({ data: { ownerId, name: `${toolkit}-${tag}`, serverUrl: `https://backend.composio.dev/tool_router/trs_${toolkit}_${randomUUID().slice(0, 6)}/mcp`, authType: 'none', source: 'ready_made', providerToolkit: toolkit } as never });
  await prisma.botMcpServer.create({ data: { botId, name: toolkit, serverUrl: connection.serverUrl, connectionId: connection.id, enabled: true } as never });
}

run('receipts that always settle (O1)', () => {
  beforeAll(async () => {
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    brick = (await prisma.bot.create({ data: { name: `Brick ${tag}`, ownerId: sara, roomId: null } as never })).id;
  });
  beforeEach(async () => {
    setAdapterForTests(null);
    setInstantFunds(undefined);
    setInstantHooks(instantRulesAndReceipts);
    forgetDriftClock();
    await resumeInstant(sara);
    await giveApp(brick, sara, 'exa');
  });
  afterEach(async () => {
    setInstantHooks(undefined);
    setAdapterForTests(undefined);
    setInstantFunds(undefined);
    await prisma.instantRun.deleteMany({ where: { personId: sara } });
    await prisma.meterEvent.deleteMany({ where: { personId: sara } });
    await prisma.taskReceipt.deleteMany({ where: { personId: sara } });
    await prisma.computerJob.deleteMany({ where: { personId: sara } });
    await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
  });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: ['instant-limits', 'instant-state'] } } });
    await prisma.bot.deleteMany({ where: { id: brick } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.$disconnect();
  });

  describe('the lease', () => {
    it('opening sets a lease and the first generation; opening or renewing again extends it and never changes anything else', async () => {
      const opened = await open('lease-1');
      expect(opened).toMatchObject({ created: true, generation: 1, leaseUntil: at(10) });
      expect(RECEIPT_LEASE_MS).toBe(10 * MIN);
      // Opened again later: the first title stands, the lease is extended, nothing else moves
      const again = await open('lease-1', { title: 'Another name' }, at(4));
      expect(again).toMatchObject({ created: false, generation: 1, leaseUntil: at(14) });
      expect((await receipt('lease-1')).title).toBe('Find the weather');
      // Renewed: extended, never shortened
      expect(await renewReceipt({ botId: brick, personId: sara, taskKey: 'lease-1', generation: 1 }, at(6))).toMatchObject({ ok: true, state: 'running', generation: 1, leaseUntil: at(16), renewed: true });
      expect(await renewReceipt({ botId: brick, personId: sara, taskKey: 'lease-1' }, at(1))).toMatchObject({ renewed: true, leaseUntil: at(16) });
    });

    it('a renewal of a task that is not there, or is another person’s, finds nothing', async () => {
      await open('lease-2');
      expect(await renewReceipt({ botId: brick, personId: sara, taskKey: 'nope' })).toEqual({ ok: false, reason: 'not_found' });
      expect(await renewReceipt({ botId: brick, personId: omar, taskKey: 'lease-2' })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('a computer’s receipt is on no lease: the sweep waits for its job, and ends it with the job, whether or not the bot server ever closes it', async () => {
      const opened = await open('no-job-key', { category: 'computer' });
      expect(opened.leaseUntil).toBeNull();
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Weekly report', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      expect((await renewReceipt({ botId: brick, personId: sara, taskKey: job.id }))).toMatchObject({ ok: true, renewed: false });
      // While the job runs, the receipt is never swept, however late. One whose key is no job at all waits a lease, then ends refunded.
      expect(await settleCheckingReceipts(50, at(9))).toBe(0);
      expect(await settleCheckingReceipts(50, at(600))).toBe(1);
      expect(await receipt('no-job-key')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
      expect((await receipt(job.id)).state).toBe('running');
      // Closed as checking by the bot server: still not ended while the job runs, however long it waits
      await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'checking' }, at(1));
      expect(await settleCheckingReceipts(50, at(600))).toBe(0);
      expect((await receipt(job.id)).state).toBe('checking');
      // The job is over: the receipt ends with it, from its job (never from a meter row)
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(30) } });
      expect(await settleCheckingReceipts(50, at(600))).toBeGreaterThanOrEqual(1);
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done' });
    });

    it('a running computer receipt whose bot server never closed it ends as soon as its job is over', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Never closed', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      expect(await settleCheckingReceipts(50, at(2))).toBe(0);
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'failed', endedBy: 'error', endedAt: at(3) } });
      expect(await settleCheckingReceipts(50, at(4))).toBe(1);
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done', leaseUntil: null });
    });
  });

  describe('a computer receipt that also has Instant runs', () => {
    it('is not settled while its job runs, and ends from its runs once the job is over, whether or not the bot server ever closes it', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Job with an App', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      await makeRun(job.id, 'succeeded', { customerMicros: BigInt(9_000) });
      await makeRun(job.id, 'failed', { reason: 'provider_failed' });
      expect(await settleCheckingReceipts(50, at(600))).toBe(0);
      expect((await receipt(job.id)).state).toBe('running');
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(700) } });
      expect(await settleCheckingReceipts(50, at(701))).toBe(1);
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'partial' });
    });
  });

  describe('a computer job’s receipt opened with no category', () => {
    it('is never ended while its job runs, however long its lease has been out, and ends with its job', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Long job', status: 'running', startedAt: START } });
      expect((await open(job.id, { category: null })).leaseUntil).toEqual(at(10));
      expect(await settleCheckingReceipts(50, at(600))).toBe(0);
      expect(await settleReceipt({ botId: brick, personId: sara, taskKey: job.id }, at(600))).toBe('running');
      expect((await receipt(job.id)).state).toBe('running');
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(700) } });
      expect(await settleCheckingReceipts(50, at(701))).toBe(1);
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done' });
    });
  });

  describe('a computer job’s Instant runs end, but the job is still running', () => {
    const after = (taskKey: string, runId: string) => instantRulesAndReceipts.afterRun?.({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: {}, callId: 'c', taskKey }, { status: 'done', runId, ok: true, data: {}, chargedMicros: 1, pending: false });

    it('a checking receipt of a job is not ended by its run ending (afterRun) while the job runs; it ends from the runs once the job is over', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Job in checking', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      const unsure = await makeRun(job.id, 'ambiguous');
      expect(await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'done' }, at(3))).toMatchObject({ state: 'checking' });
      await prisma.instantRun.update({ where: { id: unsure.id }, data: { state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000) } });
      await after(job.id, unsure.id);
      expect((await receipt(job.id)).state).toBe('checking');
      expect(await settleReceipt({ botId: brick, personId: sara, taskKey: job.id }, at(900))).toBe('checking');
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(950) } });
      expect(await settleCheckingReceipts(50, at(951))).toBe(1);
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done', actions: [{ run: unsure.id, outcome: 'worked' }] });
    });

    it('a lapsed receipt of a job opened with no category is not ended by a completed run while the job runs', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Job, no category', status: 'running', startedAt: START } });
      await open(job.id, { category: null });
      const ran = await makeRun(job.id, 'succeeded', { customerMicros: BigInt(9_000) });
      await after(job.id, ran.id);
      expect(await settleReceipt({ botId: brick, personId: sara, taskKey: job.id }, at(600))).toBe('running');
      expect((await receipt(job.id)).state).toBe('running');
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(700) } });
      expect(await settleReceipt({ botId: brick, personId: sara, taskKey: job.id }, at(701))).toBe('done');
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done' });
    });

    it('a receipt whose runs were all refused, while its job runs, is not picked again and again by the sweep: a receipt behind it is settled', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Job, refused runs', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      await makeRun(job.id, 'refused', { reason: 'rule' });
      await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'checking' }, at(1));
      await open('behind-1');
      const behind = await makeRun('behind-1', 'ambiguous');
      await closeReceipt({ botId: brick, taskKey: 'behind-1', personId: sara, state: 'done' }, at(1));
      await prisma.instantRun.update({ where: { id: behind.id }, data: { state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000) } });
      // Only one receipt fits in the pass: it must be the one that can be settled
      expect(await settleCheckingReceipts(1, at(30))).toBe(1);
      expect((await receipt('behind-1')).state).toBe('done');
      expect((await receipt(job.id)).state).toBe('checking');
    });
  });

  describe('a run that landed after the word, whose recording did not finish', () => {
    it('the sweep puts the ended receipt right from the run records, once, and never picks it again', async () => {
      await open('late-1');
      await closeReceipt({ botId: brick, taskKey: 'late-1', personId: sara, state: 'refunded' }, at(1));
      expect(await receipt('late-1')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
      // The run succeeded and was charged, but the hook that tells the receipt never ran (it failed and was caught)
      const ran = await makeRun('late-1', 'succeeded', { customerMicros: BigInt(9_000), toolkit: 'gmail' });
      expect(await settleCheckingReceipts(50, at(2))).toBe(1);
      expect(await receipt('late-1')).toMatchObject({ state: 'done', outcome: 'done', actions: [{ run: ran.id, label: 'gmail', outcome: 'worked' }] });
      // It is not selected again: with one place in the pass, a receipt that does need settling is the one that is
      await open('late-2');
      const unsure = await makeRun('late-2', 'ambiguous');
      await closeReceipt({ botId: brick, taskKey: 'late-2', personId: sara, state: 'done' }, at(1));
      await prisma.instantRun.update({ where: { id: unsure.id }, data: { state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000) } });
      expect(await settleCheckingReceipts(1, at(3))).toBe(1);
      expect((await receipt('late-2')).state).toBe('done');
    });

    it('a refused run, or a run already recorded, never makes an ended receipt be picked', async () => {
      await open('late-3');
      await makeRun('late-3', 'refused', { reason: 'rule' });
      await closeReceipt({ botId: brick, taskKey: 'late-3', personId: sara, state: 'done', chargedMicros: 4_000 }, at(1));
      expect(await settleCheckingReceipts(50, at(2))).toBe(0);
      expect(await receipt('late-3')).toMatchObject({ state: 'done', chargedMicros: BigInt(4_000) });
    });
  });

  describe('a close that arrives while the task’s computer job still runs', () => {
    it('waits in checking, whatever the word, and ends when the job is over: by the bot server’s close once it is over, or by the sweep', async () => {
      for (const word of ['done', 'refunded'] as const) {
        const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: `Early ${word}`, status: 'running', startedAt: START } });
        await open(job.id, { category: 'computer' });
        expect(await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: word }, at(2))).toMatchObject({ ok: true, state: 'checking', generation: 1 });
        expect((await receipt(job.id)).state).toBe('checking');
        // Sent again while it runs: still waiting
        expect(await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: word }, at(3))).toMatchObject({ state: 'checking' });
        await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'failed', endedBy: 'error', endedAt: at(5) } });
        // The close that follows the job's end settles it at once
        expect(await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: word }, at(6))).toMatchObject({ state: word });
        expect(await receipt(job.id)).toMatchObject({ state: word, outcome: word, leaseUntil: null });
      }
      // With no word after, the sweep ends it
      const quiet = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Early done, no second close', status: 'running', startedAt: START } });
      await open(quiet.id, { category: 'computer' });
      await closeReceipt({ botId: brick, taskKey: quiet.id, personId: sara, state: 'done' }, at(2));
      await prisma.computerJob.update({ where: { id: quiet.id }, data: { status: 'done', endedAt: at(5) } });
      expect(await settleCheckingReceipts(50, new Date(at(5).getTime() + UNWATCHED_CHECKING_WAIT_MS + MIN))).toBeGreaterThanOrEqual(1);
      expect(await receipt(quiet.id)).toMatchObject({ state: 'done', outcome: 'done' });
    });
  });

  describe('receipts from before this existed, and computer jobs whose Apps all failed', () => {
    it('a receipt that ended before actions were written down is left as it ended: the sweep never picks it, and a repeat of its close changes nothing', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Old job', status: 'done', startedAt: START, endedAt: at(5) } });
      await prisma.taskReceipt.create({ data: { botId: brick, personId: sara, taskKey: job.id, title: 'Old job', category: 'computer', state: 'done', outcome: 'done', chargedMicros: BigInt(50_000), startedAt: START, endedAt: at(5), payerKind: 'person', payerPersonId: sara } as never });
      await makeRun(job.id, 'failed', { reason: 'provider_failed' });
      expect(await settleCheckingReceipts(50, at(900))).toBe(0);
      expect(await settleReceipt({ botId: brick, personId: sara, taskKey: job.id }, at(900))).toBe('done');
      expect(await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'done' }, at(901))).toMatchObject({ ok: true, state: 'done' });
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'done', chargedMicros: BigInt(50_000) });
    });

    it('a computer job that ran does not come out refunded because its Apps all failed: the job is the task’s work', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Job whose App failed', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer' });
      const failed = await makeRun(job.id, 'failed', { reason: 'provider_failed', toolkit: 'gmail' });
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'done', endedAt: at(5) } });
      expect(await settleCheckingReceipts(50, at(6))).toBe(1);
      // The job finished and its App did not: partly done (the computer's work is a step that worked), never plain Done and never refunded
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'partial', actions: [{ run: failed.id, outcome: 'failed' }] });
      // A job that never ran (refused by a rule before it started) or failed on our side did nothing for the person: its Apps all failing is refunded, nothing taken
      const never = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Never ran', status: 'stopped', endedBy: 'rule', endedAt: at(1) } });
      await open(never.id, { category: 'computer' });
      await makeRun(never.id, 'failed', { reason: 'provider_failed' });
      await closeReceipt({ botId: brick, taskKey: never.id, personId: sara, state: 'done' }, at(3));
      expect(await receipt(never.id)).toMatchObject({ state: 'refunded', outcome: 'refunded' });
      const broke = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Failed on our side', status: 'failed', endedBy: 'error', startedAt: START, endedAt: at(2) } });
      await open(broke.id, { category: 'computer' });
      await makeRun(broke.id, 'failed', { reason: 'provider_failed' });
      await closeReceipt({ botId: brick, taskKey: broke.id, personId: sara, state: 'done' }, at(3));
      expect(await receipt(broke.id)).toMatchObject({ state: 'refunded', outcome: 'refunded' });
      // A task with no job still ends refunded when none of its actions worked
      await open('no-job-all-failed');
      await makeRun('no-job-all-failed', 'failed', { reason: 'provider_failed' });
      await closeReceipt({ botId: brick, taskKey: 'no-job-all-failed', personId: sara, state: 'done' }, at(3));
      expect(await receipt('no-job-all-failed')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
    });
  });

  describe('the migration', () => {
    it('amend O4: the outcome column holds every outcome (failed and unconfirmed fit), and still refuses anything else; rows written before keep their outcome', async () => {
      for (const outcome of ['done', 'partial', 'refunded', 'failed', 'unconfirmed']) {
        await open(`outcome-${outcome}`);
        await prisma.taskReceipt.updateMany({ where: { botId: brick, taskKey: `outcome-${outcome}` }, data: { outcome } });
        expect((await receipt(`outcome-${outcome}`)).outcome).toBe(outcome);
      }
      await open('outcome-bad');
      await expect(prisma.taskReceipt.updateMany({ where: { botId: brick, taskKey: 'outcome-bad' }, data: { outcome: 'lost' } })).rejects.toThrow();
    });

    it('gives a receipt still running when it lands a fresh lease, not an already-lapsed one; a computer’s receipt stays on none', async () => {
      const { readFileSync } = await import('node:fs');
      const sql = readFileSync('prisma/migrations/20261119100000_task_receipt_lease/migration.sql', 'utf8');
      const statement = sql.split('\n').find((line) => line.startsWith('UPDATE "task_receipts" SET "lease_until"'));
      expect(statement).toBeDefined();
      await open('mig-1', {}, new Date(Date.now() - 3 * 60 * MIN));
      await prisma.taskReceipt.updateMany({ where: { botId: brick, taskKey: 'mig-1' }, data: { leaseUntil: null } });
      await open('mig-2', { category: 'computer' });
      await prisma.$executeRawUnsafe(statement as string);
      const lease = (await receipt('mig-1')).leaseUntil;
      expect(lease && lease.getTime()).toBeGreaterThan(Date.now() + 9 * MIN);
      expect(lease && lease.getTime()).toBeLessThan(Date.now() + 11 * MIN);
      expect((await receipt('mig-2')).leaseUntil).toBeNull();
      // So a live task is not ended by the first sweep after the migration
      expect(await settleCheckingReceipts(50, new Date())).toBe(0);
      expect((await receipt('mig-1')).state).toBe('running');
    });
  });

  describe('a lease extension and a settlement of the same task never overlap', () => {
    it('a run about to go out, at the same moment the lease is read as run out: the receipt ends up whole either way (running with a live lease, or ended with none)', async () => {
      const keys = Array.from({ length: 8 }, (_, i) => `race-${i}`);
      // Real clock: each lease ran out a minute ago
      for (const key of keys) await open(key, {}, new Date(Date.now() - 11 * MIN));
      const settleAt = new Date();
      await Promise.all(keys.flatMap((key) => [touchLeaseForRun({ botId: brick, personId: sara, taskKey: key }, new Date()), settleReceipt({ botId: brick, personId: sara, taskKey: key }, settleAt)]));
      for (const key of keys) {
        const row = await receipt(key);
        if (row.state === 'running') expect(row.leaseUntil && row.leaseUntil.getTime()).toBeGreaterThan(Date.now());
        else expect(row).toMatchObject({ state: 'refunded', leaseUntil: null });
      }
    });

    it('a repeat of the open, at the same moment, is no different', async () => {
      await open('race-open', {}, new Date(Date.now() - 11 * MIN));
      const settleAt = new Date();
      await Promise.all([open('race-open', {}, new Date()), settleReceipt({ botId: brick, personId: sara, taskKey: 'race-open' }, settleAt)]);
      const row = await receipt('race-open');
      if (row.state === 'running') expect(row.leaseUntil && row.leaseUntil.getTime()).toBeGreaterThan(Date.now());
      else expect(row).toMatchObject({ leaseUntil: null });
    });
  });

  describe('case 1: the bot process is lost mid-turn (no close ever arrives, and nobody writes again)', () => {
    it('a task that never ran anything ends as refunded, nothing taken, by the sweep once its lease has run out; and not before', async () => {
      const p = fakeProvider();
      await open('lost-1');
      expect(await settleCheckingReceipts(50, at(9))).toBe(0);
      expect((await receipt('lost-1')).state).toBe('running');
      expect(await settleCheckingReceipts(50, at(11))).toBe(1);
      expect(await receipt('lost-1')).toMatchObject({ state: 'refunded', outcome: 'refunded', leaseUntil: null, chargedMicros: BigInt(0) });
      expect((await receipt('lost-1')).endedAt).toEqual(at(11));
      // Said again any number of times: the same, and nothing was ever sent
      expect(await settleCheckingReceipts(50, at(60))).toBe(0);
      expect(p.instant.run).not.toHaveBeenCalled();
      // Nothing happened, so it is not listed
      expect((await activityFor(sara)).map((item) => item.title)).not.toContain('Find the weather');
    });

    it('a task whose run worked before the bot server was lost ends as done, from the run record', async () => {
      await open('lost-2');
      const worked = await makeRun('lost-2', 'succeeded', { customerMicros: BigInt(9_000) });
      await prisma.meterEvent.create({ data: { eventId: `lost-2-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(7_000), basis: 'measured', detail: { instant: true, taskKey: 'lost-2', app: 'exa', customerMicros: 9_000 } } });
      await settleCheckingReceipts(50, at(11));
      expect(await receipt('lost-2')).toMatchObject({ state: 'done', outcome: 'done', actions: [{ run: worked.id, label: 'exa', outcome: 'worked' }] });
      const [item] = await activityFor(sara);
      expect(item).toMatchObject({ state: 'done', outcome: 'done', outcomeText: OUTCOME_WORDS.done, spentMicros: 9_000, actions: [{ label: 'exa', outcome: 'worked', text: actionWords('exa', 'worked'), takenText: null }] });
    });

    it('a task whose run failed before the bot server was lost ends as refunded', async () => {
      await open('lost-3');
      await makeRun('lost-3', 'failed', { reason: 'provider_failed' });
      await settleCheckingReceipts(50, at(11));
      expect(await receipt('lost-3')).toMatchObject({ state: 'refunded', outcome: 'refunded', actions: [{ label: 'exa', outcome: 'failed' }] });
    });

    it('a task the bot server closed as checking and then went away is ended the same way, after its grace', async () => {
      await open('lost-4');
      await closeReceipt({ botId: brick, taskKey: 'lost-4', personId: sara, state: 'checking' });
      // The request may still arrive: young is left alone (the row's own clock is the database's, so the sweep's clock is read from now)
      expect(await settleCheckingReceipts(50, new Date(Date.now() + MIN))).toBe(0);
      expect(await settleCheckingReceipts(50, new Date(Date.now() + UNWATCHED_CHECKING_WAIT_MS + MIN))).toBe(1);
      expect(await receipt('lost-4')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
    });

    it('the sweep is part of Instant’s own sweep, so nothing more is needed from the bot server', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await open('lost-5');
      const swept = await sweepInstant({ funds: f.funds, adapter: p.adapter, now: at(11) });
      expect(swept.receipts).toBe(1);
      expect((await receipt('lost-5')).state).toBe('refunded');
      expect(p.instant.run).not.toHaveBeenCalled();
    });
  });

  describe('case 2: a close is taken but its answer is lost (so it is sent again, any number of times)', () => {
    it('a close sent again changes nothing, even with a different word', async () => {
      await open('again-1');
      await makeRun('again-1', 'succeeded', { customerMicros: BigInt(9_000) });
      const first = await closeReceipt({ botId: brick, taskKey: 'again-1', personId: sara, state: 'done', generation: 1 }, at(2));
      const before = await receipt('again-1');
      for (const state of ['done', 'refunded', 'checking'] as const) {
        expect(await closeReceipt({ botId: brick, taskKey: 'again-1', personId: sara, state, generation: 1 }, at(5))).toEqual(first);
      }
      const after = await receipt('again-1');
      expect(after).toMatchObject({ state: 'done', outcome: 'done', generation: 1 });
      expect(after.endedAt).toEqual(before.endedAt);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it('a close for an older generation never ends a newer, active turn', async () => {
      await open('again-2');
      // The first turn ended with nothing run (lease ran out), then a run turned up under the same task: a newer turn
      await settleCheckingReceipts(50, at(11));
      expect((await receipt('again-2')).state).toBe('refunded');
      const slow = await makeRun('again-2', 'sent', { sentAt: at(12) });
      expect(await settleCheckingReceipts(50, at(12))).toBe(0);
      expect(await receipt('again-2')).toMatchObject({ state: 'checking', outcome: null, generation: 2, endedAt: null });
      // The repeat of the first turn's close arrives late, with generation 1: nothing moves, and it learns the generation the receipt is on
      expect(await closeReceipt({ botId: brick, taskKey: 'again-2', personId: sara, state: 'refunded', generation: 1 }, at(13))).toMatchObject({ ok: true, state: 'checking', generation: 2, stale: true });
      expect(await renewReceipt({ botId: brick, personId: sara, taskKey: 'again-2', generation: 1 }, at(13))).toMatchObject({ ok: true, state: 'checking', generation: 2, renewed: false, stale: true });
      expect(await receipt('again-2')).toMatchObject({ state: 'checking', generation: 2 });
      // The run ends: the receipt follows the record, not the stale word
      await prisma.instantRun.update({ where: { id: slow.id }, data: { state: 'succeeded', customerState: 'charged', customerMicros: BigInt(5_000), finishedAt: at(14) } });
      await settleReceipt({ botId: brick, personId: sara, taskKey: 'again-2' }, at(14));
      expect(await receipt('again-2')).toMatchObject({ state: 'done', outcome: 'done', generation: 2 });
      // The newer turn's own close, with the generation it learned, is taken as ever (and changes nothing: it has ended)
      expect(await closeReceipt({ botId: brick, taskKey: 'again-2', personId: sara, state: 'done', generation: 2 }, at(15))).toMatchObject({ ok: true, state: 'done', generation: 2 });
    });

    it('a close without a generation (a bot server from before this) is for the turn the receipt is on', async () => {
      await open('again-3');
      expect(await closeReceipt({ botId: brick, taskKey: 'again-3', personId: sara, state: 'refunded' }, at(1))).toMatchObject({ ok: true, state: 'refunded', generation: 1 });
    });

    it('a close for a task that is not there, or is another person’s, finds nothing; a wrong amount is refused', async () => {
      await open('again-4');
      expect(await closeReceipt({ botId: brick, taskKey: 'again-4', personId: omar, state: 'done' })).toEqual({ ok: false, reason: 'not_found' });
      await expect(closeReceipt({ botId: brick, taskKey: 'again-4', personId: sara, state: 'done', chargedMicros: -1 })).rejects.toThrow(RangeError);
    });

    it('a close that was taken but reported lost, then a run that landed under the ended receipt, is put right from the run records', async () => {
      await open('again-5');
      // The bot server's close says refunded (it saw nothing work), and Orbit takes it: no run yet
      expect(await closeReceipt({ botId: brick, taskKey: 'again-5', personId: sara, state: 'refunded', generation: 1 }, at(1))).toMatchObject({ state: 'refunded' });
      // A run of the task lands later and worked: books charged; the receipt must not say "nothing taken"
      const worked = await makeRun('again-5', 'succeeded', { customerMicros: BigInt(9_000) });
      await instantRulesAndReceipts.afterRun?.({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: {}, callId: 'c', taskKey: 'again-5' }, { status: 'done', runId: worked.id, ok: true, data: {}, chargedMicros: 9_000, pending: false });
      expect(await receipt('again-5')).toMatchObject({ state: 'done', outcome: 'done', actions: [{ outcome: 'worked' }] });
    });
  });

  describe('case 3: a real slow run is still active', () => {
    it('a lapsed lease with a run still open never ends the receipt: it waits in checking until the run ends, and nothing is sent again', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await setLimits();
      await open('slow-1');
      // The run's answer did not come back: the executor leaves it unclear
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null } as InstantCall);
      const id = callId();
      expect(await runInstant({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: { query: 'weather' }, callId: id, taskKey: 'slow-1' }, { adapter: p.adapter, funds: f.funds, now: START })).toMatchObject({ status: 'checking' });
      const row = await prisma.instantRun.findUniqueOrThrow({ where: { runKey: instantRunKey(brick, id) } });
      expect(row.state).toBe('ambiguous');
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      // The lease runs out while the run is still being looked for: the receipt waits, hidden from Activity
      await settleCheckingReceipts(50, at(11));
      expect((await receipt('slow-1')).state).toBe('checking');
      expect((await activityFor(sara)).map((item) => item.title)).not.toContain('Find the weather');
      // The lookup finds that it worked: the run settles, and the receipt follows without any word from the bot server
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', 7_000)]);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await receipt('slow-1')).toMatchObject({ state: 'done', outcome: 'done', actions: [{ run: row.id, outcome: 'worked' }] });
      // Never asked outside again: the one send is all there was
      expect(p.instant.run).toHaveBeenCalledTimes(1);
    });

    it('Orbit’s own sign of life: a run about to go out extends the lease, whether or not the bot server renews it', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await setLimits();
      // Opened on the real clock (the hook's own), eight minutes ago: its lease has two minutes left, so only the run's own extension can make it longer
      await open('slow-2', {}, new Date(Date.now() - 8 * MIN));
      const before = (await receipt('slow-2')).leaseUntil;
      expect(before && before.getTime()).toBeLessThan(Date.now() + 3 * MIN);
      await runInstant({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: { query: 'x' }, callId: callId(), taskKey: 'slow-2' }, { adapter: p.adapter, funds: f.funds });
      const leased = (await receipt('slow-2')).leaseUntil;
      expect(leased && before && leased.getTime()).toBeGreaterThan((before as Date).getTime() + 5 * MIN);
      expect(leased && leased.getTime()).toBeGreaterThan(Date.now() + RECEIPT_LEASE_MS - MIN);
      // Still running and not swept while its lease is on, even though its run has ended
      expect(await settleCheckingReceipts(50, new Date())).toBe(0);
      expect((await receipt('slow-2')).state).toBe('running');
    });

    it('the lease running out with a run still open moves the receipt to checking; a renewed lease keeps it running', async () => {
      await open('slow-3');
      await open('slow-4');
      await makeRun('slow-3', 'sent', { sentAt: START });
      await makeRun('slow-4', 'sent', { sentAt: START });
      await renewReceipt({ botId: brick, personId: sara, taskKey: 'slow-4', generation: 1 }, at(8));
      await settleCheckingReceipts(50, at(11));
      expect((await receipt('slow-3')).state).toBe('checking');
      expect((await receipt('slow-4')).state).toBe('running');
    });
  });

  describe('a long pause between runs of one task (the lease runs out between them)', () => {
    const after = (taskKey: string, runId: string) => instantRulesAndReceipts.afterRun?.({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: {}, callId: 'c', taskKey }, { status: 'done', runId, ok: true, data: {}, chargedMicros: 1, pending: false });

    it('the receipt is ended from the first run alone, then follows the second run when it lands: money and outcome always agree with the run records, and the bot server’s late close is a harmless no-op', async () => {
      await open('gap-1');
      const first = await makeRun('gap-1', 'succeeded', { customerMicros: BigInt(9_000), sentAt: START });
      expect(await settleCheckingReceipts(50, at(30))).toBe(1);
      expect(await receipt('gap-1')).toMatchObject({ state: 'done', outcome: 'done', actions: [{ run: first.id, outcome: 'worked' }] });
      // The task goes on: a second run goes out and fails; the receipt is put right from the records
      const second = await makeRun('gap-1', 'failed', { reason: 'provider_failed' });
      await after('gap-1', second.id);
      expect(await receipt('gap-1')).toMatchObject({ state: 'done', outcome: 'partial', generation: 1 });
      expect((await receipt('gap-1')).actions).toEqual([
        { run: first.id, label: 'exa', outcome: 'worked' },
        { run: second.id, label: 'exa', outcome: 'failed' },
      ]);
      // The bot server's own close (any generation it holds) changes nothing: the records already say it all
      expect(await closeReceipt({ botId: brick, taskKey: 'gap-1', personId: sara, state: 'done', generation: 1 }, at(31))).toMatchObject({ ok: true, state: 'done', generation: 1 });
      expect(await receipt('gap-1')).toMatchObject({ state: 'done', outcome: 'partial' });
    });

    it('a task with nothing yet that is ended by its lease and then runs: refunded first, then done from the run, never hidden money', async () => {
      await open('gap-2');
      await settleCheckingReceipts(50, at(30));
      expect((await receipt('gap-2')).state).toBe('refunded');
      const late = await makeRun('gap-2', 'succeeded', { customerMicros: BigInt(9_000) });
      await after('gap-2', late.id);
      expect(await receipt('gap-2')).toMatchObject({ state: 'done', outcome: 'done' });
    });
  });

  describe('case 4: a mixed task', () => {
    it('one action worked and one failed: partly done, with each action’s own line; the bot server saying done does not make it plain done', async () => {
      await open('mixed-1');
      const worked = await makeRun('mixed-1', 'succeeded', { customerMicros: BigInt(9_000), toolkit: 'gmail' });
      const failed = await makeRun('mixed-1', 'failed', { reason: 'provider_failed', toolkit: 'exa' });
      const closed = await closeReceipt({ botId: brick, taskKey: 'mixed-1', personId: sara, state: 'done', chargedMicros: 9_000, generation: 1 }, at(3));
      expect(closed).toMatchObject({ ok: true, state: 'done' });
      expect(await receipt('mixed-1')).toMatchObject({ state: 'done', outcome: 'partial', chargedMicros: BigInt(9_000) });
      await prisma.meterEvent.create({ data: { eventId: `mixed-1-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(7_000), basis: 'measured', detail: { instant: true, taskKey: 'mixed-1', app: 'gmail', customerMicros: 9_000 } } });
      const [item] = await activityFor(sara);
      expect(item).toMatchObject({ state: 'done', outcome: 'partial', outcomeText: OUTCOME_WORDS.partial, spentMicros: 9_000 });
      expect(item.actions).toEqual([
        { label: 'gmail', outcome: 'worked', text: actionWords('gmail', 'worked'), takenText: null },
        { label: 'exa', outcome: 'failed', text: actionWords('exa', 'failed'), takenText: NOTHING_TAKEN },
      ]);
      expect(item.outcomeNote).toBe(outcomeNote('partial', item.actions));
      expect((await receipt('mixed-1')).actions).toEqual([
        { run: worked.id, label: 'gmail', outcome: 'worked' },
        { run: failed.id, label: 'exa', outcome: 'failed' },
      ]);
    });

    it('a failed action and an action nobody could vouch for count as not worked; a refused one never went out and is not an action', async () => {
      await open('mixed-2');
      await makeRun('mixed-2', 'succeeded', { customerMicros: BigInt(9_000) });
      await makeRun('mixed-2', 'refused', { reason: 'rule' });
      await closeReceipt({ botId: brick, taskKey: 'mixed-2', personId: sara, state: 'done' }, at(3));
      // The refused one is not an action: everything that went out worked
      expect(await receipt('mixed-2')).toMatchObject({ outcome: 'done', actions: [{ outcome: 'worked' }] });
      await open('mixed-3');
      await makeRun('mixed-3', 'succeeded', { customerMicros: BigInt(9_000) });
      await makeRun('mixed-3', 'failed', { reason: 'unclear' });
      await closeReceipt({ botId: brick, taskKey: 'mixed-3', personId: sara, state: 'done' }, at(3));
      expect(await receipt('mixed-3')).toMatchObject({ state: 'done', outcome: 'partial' });
    });

    it('a task whose every run was refused before it ran is not an action: the bot server’s word and its charge stand, and only a lease that ran out with no word ends it refunded', async () => {
      await open('refused-1');
      await makeRun('refused-1', 'refused', { reason: 'rule' });
      expect(await closeReceipt({ botId: brick, taskKey: 'refused-1', personId: sara, state: 'done', chargedMicros: 4_000 }, at(3))).toMatchObject({ ok: true, state: 'done' });
      expect(await receipt('refused-1')).toMatchObject({ state: 'done', outcome: 'done', chargedMicros: BigInt(4_000), actions: [] });
      // Later looks at it (a run hook, or a repeat of the close) leave it as it ended
      await instantRulesAndReceipts.afterRun?.({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: {}, callId: 'c', taskKey: 'refused-1' }, { status: 'refused', reason: 'rule', runId: (await prisma.instantRun.findFirstOrThrow({ where: { taskKey: 'refused-1' } })).id });
      expect(await closeReceipt({ botId: brick, taskKey: 'refused-1', personId: sara, state: 'done', chargedMicros: 4_000 }, at(4))).toMatchObject({ state: 'done' });
      expect(await receipt('refused-1')).toMatchObject({ state: 'done', chargedMicros: BigInt(4_000) });
      await open('refused-2');
      await makeRun('refused-2', 'refused', { reason: 'rule' });
      await settleCheckingReceipts(50, at(30));
      expect(await receipt('refused-2')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
    });

    it('none worked is refunded whatever the word was, and all worked is done whatever the word was', async () => {
      await open('mixed-4');
      await makeRun('mixed-4', 'failed', { reason: 'provider_failed' });
      await makeRun('mixed-4', 'failed', { reason: 'invalid_request' });
      expect(await closeReceipt({ botId: brick, taskKey: 'mixed-4', personId: sara, state: 'done', chargedMicros: 500 }, at(3))).toMatchObject({ state: 'refunded' });
      expect(await receipt('mixed-4')).toMatchObject({ state: 'refunded', outcome: 'refunded', chargedMicros: BigInt(0) });
      await open('mixed-5');
      await makeRun('mixed-5', 'succeeded', { customerMicros: BigInt(9_000) });
      expect(await closeReceipt({ botId: brick, taskKey: 'mixed-5', personId: sara, state: 'refunded' }, at(3))).toMatchObject({ state: 'done' });
      expect(await receipt('mixed-5')).toMatchObject({ state: 'done', outcome: 'done' });
    });

    it('a close that arrives while a run is open waits in checking; when the runs end the receipt says what they came to, partly done included', async () => {
      await open('mixed-6');
      await makeRun('mixed-6', 'succeeded', { customerMicros: BigInt(9_000) });
      const unsure = await makeRun('mixed-6', 'ambiguous');
      expect(await closeReceipt({ botId: brick, taskKey: 'mixed-6', personId: sara, state: 'done' }, at(3))).toMatchObject({ state: 'checking' });
      await prisma.instantRun.update({ where: { id: unsure.id }, data: { state: 'failed', reason: 'unclear', customerState: 'released' } });
      await settleCheckingReceipts(50, at(4));
      expect(await receipt('mixed-6')).toMatchObject({ state: 'done', outcome: 'partial' });
    });
  });

  describe('what each action took (amountMicros)', () => {
    const instantEvent = (taskKey: string, runId: string, customerMicros: number | null) =>
      prisma.meterEvent.create({ data: { eventId: `instant:${runId}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(5_000), basis: 'measured', detail: { instant: true, taskKey, runId, customerMicros } } as never });

    it('every worked action carries what it took, they add up to the receipt’s total, and a failed one has none', async () => {
      await open('amount-1');
      const gmail = await makeRun('amount-1', 'succeeded', { customerMicros: BigInt(20_000), toolkit: 'gmail' });
      const calendar = await makeRun('amount-1', 'succeeded', { customerMicros: BigInt(13_000), toolkit: 'googlecalendar' });
      const failed = await makeRun('amount-1', 'failed', { reason: 'provider_failed', toolkit: 'exa' });
      await closeReceipt({ botId: brick, taskKey: 'amount-1', personId: sara, state: 'done' }, at(3));
      await instantEvent('amount-1', gmail.id, 20_000);
      await instantEvent('amount-1', calendar.id, 13_000);
      await instantEvent('amount-1', failed.id, 0);
      const [item] = await activityFor(sara);
      expect(item).toMatchObject({ outcome: 'partial', spentMicros: 33_000 });
      expect(item.actions.map((action) => action.amountMicros)).toEqual([20_000, 13_000, undefined]);
      expect(item.actions[2]).not.toHaveProperty('amountMicros');
      const worked = item.actions.filter((action) => action.outcome === 'worked');
      expect(worked.reduce((sum, action) => sum + (action.amountMicros ?? 0), 0)).toBe(item.spentMicros);
      // Existing fields are as they were
      expect(item.actions[2]).toMatchObject({ label: 'exa', outcome: 'failed', text: actionWords('exa', 'failed'), takenText: NOTHING_TAKEN });
      expect(item.actions[0]).toMatchObject({ label: 'gmail', outcome: 'worked', text: actionWords('gmail', 'worked'), takenText: null });
    });

    it('a worked action whose charge the books have not acknowledged has no amount, and the receipt says "Settlement pending" (it may already have been debited) with no total made up', async () => {
      await open('amount-2');
      const known = await makeRun('amount-2', 'succeeded', { customerMicros: BigInt(20_000), toolkit: 'gmail' });
      const unknown = await makeRun('amount-2', 'succeeded', { customerMicros: null, customerState: 'held', toolkit: 'exa' });
      await closeReceipt({ botId: brick, taskKey: 'amount-2', personId: sara, state: 'done' }, at(3));
      await instantEvent('amount-2', known.id, 20_000);
      await instantEvent('amount-2', unknown.id, null);
      const [item] = await activityFor(sara);
      expect(item.actions[0]).toMatchObject({ outcome: 'worked', amountMicros: 20_000 });
      expect(item.actions[1]).toMatchObject({ outcome: 'worked' });
      expect(item.actions[1]).not.toHaveProperty('amountMicros');
      expect(item.lines.some((line) => line.note === 'Settlement pending')).toBe(true);
      expect(item.spentMicros).toBeNull();
    });

    it('a worked action with no record in the books yet has no amount (nothing is guessed)', async () => {
      await open('amount-3');
      await makeRun('amount-3', 'succeeded', { customerMicros: BigInt(9_000), toolkit: 'gmail' });
      await closeReceipt({ botId: brick, taskKey: 'amount-3', personId: sara, state: 'done' }, at(3));
      const [item] = await activityFor(sara);
      expect(item.actions).toHaveLength(1);
      expect(item.actions[0]).not.toHaveProperty('amountMicros');
    });

    it('another task’s run with the same toolkit never lends its amount', async () => {
      await open('amount-4a');
      await open('amount-4b');
      const a = await makeRun('amount-4a', 'succeeded', { customerMicros: BigInt(11_000), toolkit: 'gmail' });
      const b = await makeRun('amount-4b', 'succeeded', { customerMicros: BigInt(22_000), toolkit: 'gmail' });
      await closeReceipt({ botId: brick, taskKey: 'amount-4a', personId: sara, state: 'done' }, at(3));
      await closeReceipt({ botId: brick, taskKey: 'amount-4b', personId: sara, state: 'done' }, at(3));
      await instantEvent('amount-4a', a.id, 11_000);
      await instantEvent('amount-4b', b.id, 22_000);
      const items = await activityFor(sara);
      const byTotal = new Map(items.map((item) => [item.spentMicros, item.actions.map((action) => action.amountMicros)]));
      expect(byTotal.get(11_000)).toEqual([11_000]);
      expect(byTotal.get(22_000)).toEqual([22_000]);
    });
  });

  describe('amend O4: a failed computer and a failed or unconfirmed action are never Done', () => {
    const computerTime = (jobId: string, costMicros: number) =>
      prisma.meterEvent.create({ data: { eventId: `ct-${jobId}`, kind: 'computer_time', pool: 'computer', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'person', route: null, jobId, quantity: BigInt(300), unit: 'second', costMicros: BigInt(costMicros), basis: 'measured', detail: {} } as never });
    const instantEvent = (taskKey: string, runId: string, customerMicros: number) =>
      prisma.meterEvent.create({ data: { eventId: `instant:${runId}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(0), basis: 'measured', detail: { instant: true, taskKey, runId, app: 'gmail', customerMicros } } as never });

    it('GPT’s case: a computer job that failed and a Gmail that failed is not Done: it says it did not finish, what the computer took, and that Gmail took nothing', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Send a message', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer', title: 'Send a message' });
      const gmail = await makeRun(job.id, 'failed', { reason: 'provider_failed', toolkit: 'gmail' });
      await computerTime(job.id, 30_000);
      await instantEvent(job.id, gmail.id, 0);
      // The agent gave up: the job failed with no word from us (the person's time, chargeable); the bot server still says done
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'failed', endedAt: at(5) } });
      await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'done' }, at(6));
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'failed', actions: [{ run: gmail.id, outcome: 'failed' }] });
      const item = (await activityFor(sara)).find((candidate) => candidate.title === 'Send a message');
      expect(item).toMatchObject({ state: 'done', outcome: 'failed', outcomeText: OUTCOME_WORDS.failed, spentMicros: 30_000 });
      expect(item?.outcomeText).not.toBe(OUTCOME_WORDS.done);
      expect(item?.outcomeNote).toBe('It didn’t finish. Computer time used $0.03. Gmail charged $0.');
      expect(item?.actions).toEqual([{ label: 'gmail', outcome: 'failed', text: actionWords('gmail', 'failed'), takenText: NOTHING_TAKEN }]);
    });

    it('a failed computer job with an action nobody could confirm is failed, not unconfirmed: the job ran and took the person’s time, so the receipt is never stored as refunded and its time is counted', async () => {
      const job = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Send and confirm', status: 'running', startedAt: START } });
      await open(job.id, { category: 'computer', title: 'Send and confirm' });
      const gmail = await makeRun(job.id, 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', customerMicros: BigInt(0), detail: { releasedUnconfirmed: true } });
      await computerTime(job.id, 30_000);
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'failed', endedAt: at(5) } });
      // Ended by the close
      await closeReceipt({ botId: brick, taskKey: job.id, personId: sara, state: 'refunded' }, at(6));
      expect(await receipt(job.id)).toMatchObject({ state: 'done', outcome: 'failed', actions: [{ run: gmail.id, outcome: 'unknown' }] });
      const item = (await activityFor(sara)).find((candidate) => candidate.title === 'Send and confirm');
      expect(item).toMatchObject({ state: 'done', outcome: 'failed', spentMicros: 30_000 });
      // The App that could not be confirmed still says so on its own line
      expect(item?.actions).toEqual([expect.objectContaining({ label: 'gmail', outcome: 'unknown' })]);
      // The same job ended by the sweep, and a receipt that was stored the old way (refunded + unconfirmed) is read as failed
      const swept = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Swept and confirm', status: 'running', startedAt: START } });
      await open(swept.id, { category: 'computer', title: 'Swept and confirm' });
      await makeRun(swept.id, 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', customerMicros: BigInt(0), detail: { releasedUnconfirmed: true } });
      await prisma.computerJob.update({ where: { id: swept.id }, data: { status: 'failed', endedAt: at(5) } });
      await settleCheckingReceipts(50, at(6));
      expect(await receipt(swept.id)).toMatchObject({ state: 'done', outcome: 'failed' });
    });

    it('a failed computer job with no Instant action at all is failed too, whether the close or the sweep ends it; and from Activity alone when it has no receipt', async () => {
      const closed = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Gave up, closed', status: 'failed', startedAt: START, endedAt: at(5) } });
      await open(closed.id, { category: 'computer', title: 'Gave up, closed' });
      await closeReceipt({ botId: brick, taskKey: closed.id, personId: sara, state: 'done' }, at(6));
      expect(await receipt(closed.id)).toMatchObject({ state: 'done', outcome: 'failed' });
      const swept = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Gave up, swept', status: 'running', startedAt: START } });
      await open(swept.id, { category: 'computer', title: 'Gave up, swept' });
      await prisma.computerJob.update({ where: { id: swept.id }, data: { status: 'failed', endedAt: at(5) } });
      await settleCheckingReceipts(50, at(6));
      expect(await receipt(swept.id)).toMatchObject({ state: 'done', outcome: 'failed' });
      // No receipt row at all: the job's own record is what Activity reads
      const bare = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Gave up, no receipt', status: 'failed', startedAt: START, endedAt: at(5) } });
      await computerTime(bare.id, 20_000);
      const item = (await activityFor(sara)).find((candidate) => candidate.title === 'Gave up, no receipt');
      expect(item).toMatchObject({ outcome: 'failed', outcomeText: OUTCOME_WORDS.failed, state: 'done' });
      expect(item?.outcomeNote).toBe('It didn’t finish. Computer time used $0.02.');
    });

    it('a failed job reads failed even from a receipt settled as done before this existed; a finished job with a failed App is partly done; a job that failed on our side is unchanged (refunded)', async () => {
      const old = await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Old failed job', status: 'failed', startedAt: START, endedAt: at(5) } });
      await prisma.taskReceipt.create({ data: { botId: brick, personId: sara, taskKey: old.id, title: 'Old failed job', category: 'computer', state: 'done', outcome: 'done', startedAt: START, endedAt: at(5), payerKind: 'person', payerPersonId: sara } as never });
      await computerTime(old.id, 10_000);
      expect((await activityFor(sara)).find((candidate) => candidate.title === 'Old failed job')).toMatchObject({ outcome: 'failed', outcomeText: OUTCOME_WORDS.failed });
      await prisma.computerJob.create({ data: { botId: brick, personId: sara, title: 'Failed on our side O4', status: 'failed', endedBy: 'error', startedAt: START, endedAt: at(5) } });
      expect((await activityFor(sara)).find((candidate) => candidate.title === 'Failed on our side O4')).toMatchObject({ outcome: 'refunded', state: 'refunded' });
    });

    it('an action nobody could confirm is never "didn’t work": worked plus unknown is partly done; unknown alone is unconfirmed; each says it could not be confirmed', async () => {
      await open('unk-1');
      const worked = await makeRun('unk-1', 'succeeded', { customerMicros: BigInt(9_000), toolkit: 'exa' });
      const unclear = await makeRun('unk-1', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', detail: { releasedUnconfirmed: true } });
      await closeReceipt({ botId: brick, taskKey: 'unk-1', personId: sara, state: 'done' }, at(3));
      expect(await receipt('unk-1')).toMatchObject({ state: 'done', outcome: 'partial', actions: [{ run: worked.id, outcome: 'worked' }, { run: unclear.id, outcome: 'unknown' }] });
      const [partly] = (await activityFor(sara)).filter((candidate) => candidate.title === 'Find the weather');
      expect(partly.actions[1]).toEqual({ label: 'gmail', outcome: 'unknown', text: actionWords('gmail', 'unknown'), takenText: HOLD_RELEASED, releasedMicros: 10_000 });
      expect(partly.actions[1].text).not.toContain("didn't");
      expect(partly.outcomeNote).toBe('One step worked and one couldn’t be confirmed. Your hold of $0.01 was released.');

      await open('unk-2');
      const only = await makeRun('unk-2', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', detail: { releasedUnconfirmed: true } });
      await closeReceipt({ botId: brick, taskKey: 'unk-2', personId: sara, state: 'refunded' }, at(3));
      // Nothing was taken (its hold was given back), so the money state is refunded; the words say it could not be confirmed, never that it failed
      expect(await receipt('unk-2')).toMatchObject({ state: 'refunded', outcome: 'unconfirmed', actions: [{ run: only.id, outcome: 'unknown' }] });
      expect((await activityFor(sara)).find((candidate) => candidate.outcome === 'unconfirmed' && candidate.actions[0]?.label === 'gmail')).toMatchObject({ state: 'refunded', outcomeText: OUTCOME_WORDS.unconfirmed, spentMicros: null });
    });

    it('while the credit of an unconfirmed action is still on hold it says the hold is being released; after, the released amount is shown', async () => {
      await open('unk-hold');
      const held = await makeRun('unk-hold', 'failed', { reason: 'unclear', toolkit: 'exa', customerState: 'held', detail: { releasedUnconfirmed: true } });
      await closeReceipt({ botId: brick, taskKey: 'unk-hold', personId: sara, state: 'refunded' }, at(3));
      const find = async () => (await activityFor(sara)).find((candidate) => candidate.actions.some((action) => action.label === 'exa' && candidate.outcome === 'unconfirmed'));
      const before = await find();
      // Not shown as refunded while the credit is still reserved
      expect(before).toMatchObject({ state: 'done', outcome: 'unconfirmed' });
      expect(before?.actions[0]).toMatchObject({ outcome: 'unknown', takenText: HOLD_BEING_RELEASED });
      expect(before?.outcomeNote).toContain('We’re releasing your hold.');
      await prisma.instantRun.update({ where: { id: held.id }, data: { customerState: 'released', customerMicros: BigInt(0) } });
      const after = await find();
      expect(after).toMatchObject({ state: 'refunded', outcome: 'unconfirmed' });
      expect(after?.actions[0]).toMatchObject({ outcome: 'unknown', takenText: HOLD_RELEASED, releasedMicros: 10_000 });
      expect(after?.outcomeNote).not.toContain('releasing');
    });

    it('late evidence that confirms a failure keeps the release wording until the books release the hold: not "refunded", not "nothing taken", while the release is still refused', async () => {
      await open('late-held', { title: 'Late held task' });
      const run = await makeRun('late-held', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'held', detail: { noLog: true, releasedUnconfirmed: true } });
      await closeReceipt({ botId: brick, taskKey: 'late-held', personId: sara, state: 'refunded' }, at(3));
      const find = async () => (await activityFor(sara)).find((candidate) => candidate.title === 'Late held task');
      // The provider's log turns up and says it failed; the books still refuse to release the hold (twice)
      await prisma.instantRun.update({ where: { id: run.id }, data: { detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'failed' } } } });
      await settleCheckingReceipts(50, at(401));
      await settleCheckingReceipts(50, at(402));
      expect(await receipt('late-held')).toMatchObject({ actions: [{ run: run.id, outcome: 'failed' }] });
      const before = await find();
      expect(before?.state).not.toBe('refunded');
      expect(before?.actions[0]).toMatchObject({ outcome: 'failed', takenText: HOLD_BEING_RELEASED });
      expect(before?.outcomeNote).toContain('We’re releasing your hold.');
      expect(before?.outcomeNote).not.toContain('Nothing was taken');
      // The books acknowledge the release: now nothing was taken and it is refunded
      await prisma.instantRun.update({ where: { id: run.id }, data: { customerState: 'released', customerMicros: BigInt(0) } });
      const after = await find();
      expect(after).toMatchObject({ state: 'refunded' });
      expect(after?.actions[0]).toMatchObject({ outcome: 'failed', takenText: NOTHING_TAKEN });
      expect(after?.outcomeNote ?? '').not.toContain('releasing');
    });

    it('a run let go unconfirmed that late evidence says WORKED keeps the hold wording from the run’s own state (being released, then released) and shows no amount taken: it is never charged', async () => {
      await open('late-worked-held', { title: 'Late worked held task' });
      const run = await makeRun('late-worked-held', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'held', detail: { noLog: true, releasedUnconfirmed: true } });
      await closeReceipt({ botId: brick, taskKey: 'late-worked-held', personId: sara, state: 'refunded' }, at(3));
      const find = async () => (await activityFor(sara)).find((candidate) => candidate.title === 'Late worked held task');
      expect((await find())?.actions[0]).toMatchObject({ outcome: 'unknown', takenText: HOLD_BEING_RELEASED });
      // The provider's log turns up and says it went out; the books have not released the hold yet
      await prisma.instantRun.update({ where: { id: run.id }, data: { detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'success' } } } });
      await settleCheckingReceipts(50, at(401));
      // A stray settle event for the run (a charge recorded against it): the receipt still shows no amount taken for a run that was let go, so the guard is what holds it
      await prisma.meterEvent.create({ data: { eventId: `instant:${run.id}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(5_000), basis: 'measured', detail: { instant: true, taskKey: 'late-worked-held', runId: run.id, app: 'gmail', customerMicros: 7_000 } } as never });
      expect(await receipt('late-worked-held')).toMatchObject({ actions: [{ run: run.id, outcome: 'worked' }] });
      const held = await find();
      expect(held?.actions[0]).toMatchObject({ outcome: 'worked', takenText: HOLD_BEING_RELEASED });
      expect(held?.actions[0]).not.toHaveProperty('amountMicros');
      // The books acknowledge the release: released, still no amount taken
      await prisma.instantRun.update({ where: { id: run.id }, data: { customerState: 'released', customerMicros: BigInt(0) } });
      const released = await find();
      expect(released?.actions[0]).toMatchObject({ outcome: 'worked', takenText: HOLD_RELEASED });
      expect(released?.actions[0]).not.toHaveProperty('amountMicros');
    });

    it('a later confirmed success updates the ORIGINAL receipt (the same row, the same id) and the charge stays what the books recorded; a later confirmed failure is a failure, never unknown', async () => {
      await open('late-1');
      const run = await makeRun('late-1', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', customerMicros: BigInt(0), detail: { noLog: true } });
      await closeReceipt({ botId: brick, taskKey: 'late-1', personId: sara, state: 'refunded' }, at(3));
      const first = await receipt('late-1');
      expect(first).toMatchObject({ outcome: 'unconfirmed', actions: [{ run: run.id, outcome: 'unknown' }] });
      // Nothing new: the sweep leaves it
      expect(await settleCheckingReceipts(50, at(400))).toBe(0);
      expect(await receipt('late-1')).toMatchObject({ outcome: 'unconfirmed' });
      // The provider's log turns up and says it went out
      await prisma.instantRun.update({ where: { id: run.id }, data: { detail: { noLog: true, lateEvidence: { status: 'success' } } } });
      await settleCheckingReceipts(50, at(401));
      const second = await receipt('late-1');
      // What the person was charged stays what the books say (the run's hold was given back: nothing), the receipt is the same row, now done
      expect(second).toMatchObject({ id: first.id, state: 'done', outcome: 'done', chargedMicros: BigInt(0), actions: [{ run: run.id, outcome: 'worked' }] });
      // Said again, nothing moves
      expect(await settleCheckingReceipts(50, at(402))).toBe(0);
      // A log that says it failed settles to a failure
      await open('late-2');
      const gone = await makeRun('late-2', 'failed', { reason: 'unclear', toolkit: 'gmail', customerState: 'released', detail: { noLog: true } });
      await closeReceipt({ botId: brick, taskKey: 'late-2', personId: sara, state: 'refunded' }, at(3));
      await prisma.instantRun.update({ where: { id: gone.id }, data: { detail: { noLog: true, lateEvidence: { status: 'failed' } } } });
      await settleCheckingReceipts(50, at(403));
      expect(await receipt('late-2')).toMatchObject({ state: 'refunded', outcome: 'refunded', actions: [{ run: gone.id, outcome: 'failed' }] });
    });
  });

  describe('case 5: a task with no run but with unrelated model usage', () => {
    it('a model call’s meter row for the task’s key never makes it done: it ends as refunded', async () => {
      const p = fakeProvider();
      await open('model-1');
      await closeReceipt({ botId: brick, taskKey: 'model-1', personId: sara, state: 'checking' }, at(1));
      for (const [jobId, detail] of [[null, { taskKey: 'model-1' }], ['model-1', null]] as const) {
        await prisma.meterEvent.create({ data: { eventId: `model-1-${jobId ?? 'x'}-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'universe-ai', jobId, quantity: BigInt(1), unit: 'call', costMicros: BigInt(0), basis: 'measured', ...(detail ? { detail } : {}) } as never });
      }
      await settleCheckingReceipts(50, new Date(at(1).getTime() + UNWATCHED_CHECKING_WAIT_MS + MIN));
      expect(await receipt('model-1')).toMatchObject({ state: 'refunded', outcome: 'refunded', actions: [] });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('the same for a lease that ran out with unrelated model usage under the task’s key', async () => {
      await open('model-2');
      await prisma.meterEvent.create({ data: { eventId: `model-2-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'universe-ai', jobId: null, quantity: BigInt(1), unit: 'call', costMicros: BigInt(0), basis: 'measured', detail: { taskKey: 'model-2' } } as never });
      await settleCheckingReceipts(50, at(11));
      expect(await receipt('model-2')).toMatchObject({ state: 'refunded', outcome: 'refunded' });
    });
  });

  describe('the route', () => {
    it('open answers the generation and the lease; renew and close carry the generation and answer where the receipt stands', async () => {
      const sara$ = `sara-${tag}`;
      const opened = await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'open', title: 'Welcome video', category: 'apps' }), ctx(brick));
      expect(opened.status).toBe(201);
      const body = await opened.json();
      expect(body).toMatchObject({ created: true, generation: 1, leaseUntil: expect.any(String), link: expect.stringContaining('#usage=act_') });
      const renewed = await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'renew', generation: 1 }), ctx(brick))).json();
      expect(renewed).toMatchObject({ ok: true, state: 'running', generation: 1, renewed: true, leaseUntil: expect.any(String) });
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'renew', generation: 0 }), ctx(brick))).status).toBe(400);
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'renew', generation: 1, extra: true }), ctx(brick))).status).toBe(400);
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'nope', action: 'renew' }), ctx(brick))).json()).toEqual({ ok: false, reason: 'not_found' });
      const closed = await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'close', state: 'refunded', generation: 1 }), ctx(brick))).json();
      expect(closed).toEqual({ ok: true, id: body.id, state: 'refunded', generation: 1 });
      // Said again, the same; for an older generation than the receipt's it answers stale
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'close', state: 'refunded', generation: 1 }), ctx(brick))).json()).toEqual(closed);
      await prisma.taskReceipt.updateMany({ where: { botId: brick, taskKey: 'route-1' }, data: { generation: 3 } });
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'close', state: 'done', generation: 1 }), ctx(brick))).json()).toMatchObject({ ok: true, state: 'refunded', generation: 3, stale: true });
      // A renewal of an ended receipt does not bring it back
      expect(await (await postReceipt(json({ userId: sara$, taskKey: 'route-1', action: 'renew', generation: 3 }), ctx(brick))).json()).toMatchObject({ ok: true, state: 'refunded', renewed: false, leaseUntil: null });
    });
  });
});
