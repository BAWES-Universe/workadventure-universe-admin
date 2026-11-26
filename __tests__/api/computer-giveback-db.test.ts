/**
 * What a computer job that ended on our side is given back, against a real database (the bound on give-backs). Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-giveback-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

jest.mock('@/lib/computer-token', () => {
  const actual = jest.requireActual('@/lib/computer-token');
  return { ...actual, revokeJobTokens: jest.fn(actual.revokeJobTokens) };
});
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { databaseTimezone } from '../helpers/db-timezone';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { saveInstantLimits } from '@/lib/instant/state';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, planEffect, renewJob, settleEffect, startJob, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { OWN_KEY_CALL_MARK, authorizeOwnKeyCall, hasOwnKeyCall, lockRelayReach, readFaultRows, recordFaults, recordRelayUnreachable, type FaultInput } from '@/lib/computer-faults';
import { afterArrival, afterLateEvidence, decidePendingForPurge, decideRunnerFinish, lockPerson, resolveDecision, sweepGiveBackDecisions, sweepLateEvidence } from '@/lib/computer-giveback';
import { correctRouteTogether, giveBackOverview, giveBackReadiness, routeIsPaused } from '@/lib/computer-fault-ops';
import { mintJobToken, revokeJobTokens } from '@/lib/computer-token';
import { WorkerDied, afterWorkerDied } from '../helpers/worker-died';
import { activityFor } from '@/lib/task-receipts';
import { OUTCOME_WORDS, REACHED_WORDS, UNREACHABLE_WORDS } from '@/lib/task-receipt-words';
import { reportsToTell } from '@/lib/computer-report';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

/** A transaction that holds a lock while the test looks at who is waiting for it: its own timeout is longer than the wait the test allows (5 s), so it never ends before the thing it holds a lock for. */
const HOLDER = { timeout: 15_000, maxWait: 15_000 };

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
/** The 15th, noon UTC, of last month: jobs made from it (a few hours of them at most) never cross a UTC month, whenever the suite runs. */
const MIDMONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 12));
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id };
}

/** A pretend minute costs 6,000 millionths. */
const setUp = () =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

/** The numbers Instant is launched with: its pause rule only (the give-back numbers are empty). */
const LAUNCH = { maxRunMicros: 30_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 2000, pauseMinRuns: 10 };

async function limitsAre(set: Record<string, number>) {
  await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
  await saveInstantLimits(set, 'admin');
}

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerGiveBackDecision.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'instant-limits'] } } });
};

let clock = 0;
/** A job that starts and then is ended as the runner says; every job in these tests runs 5 minutes. */
async function job(p: { id: string; brickId: string }, ending: { outcome: 'done' | 'failed'; cause?: 'ours' | 'agent'; turns?: number[]; run?: string }, before?: (jobId: string) => Promise<void>, origin: Date = NOW) {
  const at = clock;
  clock += 10;
  const when = (n: number) => new Date(origin.getTime() + n * 60_000);
  const started = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, when(at));
  if (!started.ok) throw new Error('the job did not start');
  if (before) await before(started.job.id);
  await finishJob(started.job.id, ending.outcome, when(at + 5), null, ending.cause ?? null, ending.turns, ending.run);
  return prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } });
}
const ours = { outcome: 'failed' as const, cause: 'ours' as const };
const timeOf = (jobId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } });
const givenBack = async (jobId: string) => (await timeOf(jobId)).personKey === 'unknown';
const decisionOf = (jobId: string) => prisma.computerGiveBackDecision.findUnique({ where: { jobId } });

/** What the game relay writes for a job's model calls: one row per call (or turn), BEFORE the job finishes. */
let callNo = 0;
/** The kind the game relay sends with each reason (confirmed ours: fault; the person's, with evidence: not_ours; the rest: uncertain). */
const KIND_OF: Record<string, FaultInput['kind']> = { relay_down: 'fault', pool_busy: 'fault', route_unknown: 'fault', authorize_failed: 'fault', key_decrypt_failed: 'fault', provider_key_ours: 'fault', allowance: 'not_ours', rule: 'not_ours', own_provider: 'not_ours', field_job_set: 'not_ours' };
const fault = (turn: number | null, reason: string, extra: Partial<FaultInput> = {}): FaultInput => ({ turn, callId: `c${++callNo}`, kind: KIND_OF[reason] ?? 'uncertain', reason, source: 'universe-ai', route: 'universe-ai/model-a', at: new Date(), ...extra });
const withFaults = (p: { brickId: string }, rows: FaultInput[]) => (jobId: string) => recordFaults(p.brickId, jobId, rows).then(() => undefined);

run('a computer job that failed on our side, and the bound on giving it back', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(new FakeComputerProvider());
    await setUp();
    await limitsAre(LAUNCH);
    clock = 0;
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('is given back once when it is inside the bound, time and model calls together', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (jobId) => {
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW);
      await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
    });
    expect(ended).toMatchObject({ status: 'failed', endedBy: 'error' });
    expect(await givenBack(ended.id)).toBe(true);
    expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${ended.id}:call:c1` } })).personKey).toBe('unknown');
    expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBe(1);
    // Said twice it is still one give-back: the sweep and a second finish change nothing
    await finishJob(ended.id, 'failed', minutes(7), null, 'ours');
    await sweepComputers(minutes(8));
    expect(await prisma.computerJob.count({ where: { personId: sara.id, endedBy: 'error' } })).toBe(1);
  });

  it('is not given back once the person has had what the bound lets pass in the month (the launch numbers: 2); the third is theirs', async () => {
    const sara = await person('sara');
    const first = await job(sara, ours);
    const second = await job(sara, ours);
    const third = await job(sara, ours, async (jobId) => {
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW);
      await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
    });
    expect(await givenBack(first.id)).toBe(true);
    expect(await givenBack(second.id)).toBe(true);
    // The third ended as a failure that is the person's: its time and its model calls are taken from their month like any run
    expect(third).toMatchObject({ status: 'failed', endedBy: null });
    expect(await timeOf(third.id)).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
    expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${third.id}:call:c1` } })).personKey).toBe(`person:${sara.id}`);
    expect((await computerView(sara.brickId, sara.id, minutes(40)))?.month?.leftFraction).toBeLessThan(1);
    // A sweep later does not turn it into a give-back
    await sweepComputers(minutes(50));
    expect(await givenBack(third.id)).toBe(false);
  });

  it('uses the number a super admin set for Instant give-backs when there is one, and one person’s give-backs are never another’s', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    const omar = await person('omar');
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
    expect(await givenBack((await job(sara, ours)).id)).toBe(false);
    expect(await givenBack((await job(omar, ours)).id)).toBe(true);
  });

  it('does not count a month against the next: give-backs are counted from the 1st (UTC)', async () => {
    const sara = await person('sara');
    const old = await job(sara, ours);
    const older = await job(sara, ours);
    await prisma.computerJob.updateMany({ where: { id: { in: [old.id, older.id] } }, data: { endedAt: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15)) } });
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
  });

  it('a decision that waited into the next month is counted in the month the JOB ended in, not the month it is decided in', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    const lastMonthEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 0, 23, 30));
    const first = await job(sara, ours);
    expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    await prisma.computerJob.update({ where: { id: first.id }, data: { endedAt: new Date(lastMonthEnd.getTime() - 3_600_000) } });
    // Finished on the last evening of last month, held for an effect, and decided in this month: last month's bound (one) is already used
    const held = await job(sara, ours, async (id) => {
      await planEffect(id, { key: 'month-1', kind: 'send' });
    });
    expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
    await prisma.computerJob.update({ where: { id: held.id }, data: { endedAt: lastMonthEnd } });
    await prisma.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { decidedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000) } });
    expect(await resolveDecision(held.id, minutes(30))).toBe('resolved');
    expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'cap' });
    expect(await givenBack(held.id)).toBe(false);
  });

  it('is not given back when the job already settled something outside its computer as done: it delivered', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (jobId) => {
      expect(await planEffect(jobId, { key: 'mail-1', kind: 'send', evidence: 'ali@example.test' })).toMatchObject({ ok: true });
      expect(await settleEffect(jobId, 'mail-1', 'done', 'ali@example.test')).toBe(true);
    });
    expect(ended).toMatchObject({ status: 'failed', endedBy: null });
    expect(await timeOf(ended.id)).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
    // It used none of the bound: the next failure with nothing delivered is still given back
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
  });

  it('is still given back when an effect was confirmed not done: nothing was delivered', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (jobId) => {
      await planEffect(jobId, { key: 'mail-1', kind: 'send' });
      await settleEffect(jobId, 'mail-1', 'failed');
    });
    expect(await givenBack(ended.id)).toBe(true);
  });

  it('holds the give-back while an effect is only planned: the person is charged provisionally, and it is decided when the effect settles (done: none; failed: given back)', async () => {
    const sara = await person('sara');
    let jobId = '';
    const ended = await job(sara, ours, async (id) => {
      jobId = id;
      await planEffect(id, { key: 'mail-1', kind: 'send' });
    });
    expect(ended).toMatchObject({ status: 'failed', endedBy: null });
    expect(await givenBack(ended.id)).toBe(false);
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
    // The effect settles as done: that is a delivery, so nothing is given back, and it says so
    expect(await settleEffect(jobId, 'mail-1', 'done', 'ali@example.test')).toBe(true);
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'delivered', nextAttemptAt: null });
    await sweepComputers(minutes(60));
    expect(await timeOf(ended.id)).toMatchObject({ personKey: `person:${sara.id}` });
  });

  it('gives the job back when the held effect settles as NOT done, and it was one of the goodwill gives', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (id) => {
      await planEffect(id, { key: 'mail-1', kind: 'send' });
    });
    expect(await givenBack(ended.id)).toBe(false);
    expect(await settleEffect(ended.id, 'mail-1', 'failed')).toBe(true);
    expect(await givenBack(ended.id)).toBe(true);
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ status: 'failed', endedBy: 'error', runnerFault: true });
  });

  it('closes a held effect after Instant’s wait for an unreachable log: it is given back, marked as possibly delivered, and a later "done" takes nothing back', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (id) => {
      await planEffect(id, { key: 'mail-1', kind: 'send' });
    });
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
    // Before the bound: still held (the sweep retries and it stays pending)
    await sweepComputers(minutes(60));
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending' });
    // Past the bound (the recommended 1440 minutes): decided without the effect
    const later = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000);
    await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { nextAttemptAt: new Date(NOW.getTime() - 1000), decidedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000) } });
    await sweepComputers(later);
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    expect(await givenBack(ended.id)).toBe(true);
    // The effect then settles as done: the give-back stays, and support is told it may have been delivered
    expect(await settleEffect(ended.id, 'mail-1', 'done', 'ali@example.test')).toBe(true);
    expect(await givenBack(ended.id)).toBe(true);
    expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', deliveredLate: true });
  });

  it('is not given back to a person who is paused: their give-backs are repeated as a share of the jobs that ended', async () => {
    // The bound is not the limit here (5): Instant's pause rule is, applied to their own month, 50% once 2 jobs ended
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5, pauseMinRuns: 2, pauseFailureRateBps: 5000 });
    const sara = await person('sara');
    await job(sara, { outcome: 'done' });
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
    // 2 ended, 1 given back: the pause is on, so this one is theirs
    const paused = await job(sara, ours);
    expect(await givenBack(paused.id)).toBe(false);
    // It lifts by itself as the share falls: jobs that ran well bring it under
    await job(sara, { outcome: 'done' });
    await job(sara, { outcome: 'done' });
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
  });

  it('does not count the jobs a person ended themselves, or the ones that never ran, towards that share', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5, pauseMinRuns: 2, pauseFailureRateBps: 5000 });
    const sara = await person('sara');
    const one = await job(sara, ours);
    // Two jobs the person stopped themselves: they say nothing about how the work goes
    await prisma.computerJob.createMany({
      data: [1, 2].map((n) => ({ botId: sara.brickId, personId: sara.id, title: `Stopped ${n}`, status: 'stopped', endedBy: 'person', startedAt: minutes(100), endedAt: minutes(105) })),
    });
    expect(await givenBack(one.id)).toBe(true);
    // 1 ended (one given back): fewer than 2 jobs ended, so no pause yet, and the bound (5) is not reached
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
  });

  it('always gives back a failure only our own servers cause (a room that lapsed), and it uses none of the person’s bound', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    // The bot server goes down: three running jobs on three Bricks lose their renewals and the sweep stops them. All three are given back.
    const lapsing = [] as string[];
    for (let n = 0; n < 3; n++) {
      const brickId = n === 0 ? sara.brickId : (await createBrick({ ownerId: sara.id, name: `Lapsing ${n}` })).id;
      if (n > 0) await giveComputer(brickId, sara.id);
      const started = await startJob({ botId: brickId, personId: sara.id, title: `Lapsing ${n}` }, minutes(100));
      if (!started.ok) throw new Error('no');
      lapsing.push(started.job.id);
    }
    expect(await sweepComputers(minutes(200))).toMatchObject({ stopped: 3 });
    for (const id of lapsing) {
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'stopped', endedBy: 'error', runnerFault: false });
      expect(await givenBack(id)).toBe(true);
    }
    // None of that used the bound (1): a later failure the runner reports is still given back, and only then is the bound used up
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
    const refused = await job(sara, ours);
    expect(refused).toMatchObject({ status: 'failed', endedBy: null });
    expect(await givenBack(refused.id)).toBe(false);
  });

  it('does not mark an Orbit-seen failure as the runner’s when the job also has an unproven first turn: the lapse is given back past the bound', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
    const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Unproven turn' }, minutes(100));
    if (!started.ok) throw new Error('no');
    // Its first turn was sent and never named, so the ending also writes the machine's turn hold in the same transaction
    await prisma.computerJob.update({ where: { id: started.job.id }, data: { firstTurnSentAt: minutes(101), agentResponseId: null } });
    expect(await sweepComputers(minutes(200))).toMatchObject({ stopped: 1 });
    expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'error', runnerFault: false });
    expect(await givenBack(started.job.id)).toBe(true);
    // The test's clock is ahead of the database's: the hold the ending wrote is dated in the test's future, and a hold lifts only on a stop proved after its date (Opus on #1040), so it is dated as the real clock would have
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId, NOT: { turnUnprovenSince: null } }, data: { turnUnprovenSince: new Date(Date.now() - 1000) } });
    // And it used none of the bound (1): the next runner give-back is refused only because of the first one
    const next = await job(sara, ours);
    expect(next).toMatchObject({ status: 'failed', endedBy: null });
  });

  it('always gives back a machine that would not start, and it uses none of the bound either', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    const provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    provider.failNext.create = true;
    expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'Broken start' }, minutes(0))).toEqual({ ok: false, reason: 'broken_start' });
    expect(await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id, title: 'Broken start' } })).toMatchObject({ status: 'failed', endedBy: 'error', runnerFault: false });
    clock = 10;
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
  });

  describe('when the Limits cannot be read', () => {
    /** Reading the Instant Limits fails this many times (every other read goes through). */
    const failLimitsReads = (times: number) => {
      const real = prisma.appSetting.findUnique.bind(prisma.appSetting);
      let left = times;
      return jest.spyOn(prisma.appSetting, 'findUnique').mockImplementation(((args: { where?: { key?: string } }) => {
        if (args?.where?.key === 'instant-limits' && left > 0) {
          left--;
          return Promise.reject(new Error('database blip'));
        }
        return real(args as never);
      }) as never);
    };
    afterEach(() => jest.restoreAllMocks());

    it('is read once more: a single failed read gives the same answer as a good one', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      failLimitsReads(1);
      // The bound (1) is used up: the second read is good and the answer is "not given back", not "unbounded"
      const second = await job(sara, ours);
      expect(second).toMatchObject({ status: 'failed', endedBy: null });
    });

    it('does not read as "no bound" when it fails twice, and is never a final charge: the decision is kept as pending and the sweep decides it when the Limits can be read', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      failLimitsReads(2);
      const ended = await job(sara, ours);
      expect(ended).toMatchObject({ status: 'failed', endedBy: null, runnerFault: false });
      expect(await givenBack(ended.id)).toBe(false);
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending', basis: 'limits_unreadable' });
      // It is told to Sentry, so the held give-back is not forgotten
      expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('Limits could not be read'), expect.objectContaining({ tags: expect.objectContaining({ step: 'giveback_limits_unreadable' }), extra: { jobId: ended.id } }));
      jest.restoreAllMocks();
      // Not due yet: it is still waiting. Due: decided with the Limits, and given back in full (time and calls)
      await sweepComputers(minutes(5));
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending' });
      await sweepComputers(new Date(NOW.getTime() + 3 * 60 * 60_000));
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', attempts: expect.any(Number) });
      expect(await givenBack(ended.id)).toBe(true);
    });

    it('stays bounded while it waits: a decision made with the Limits that come back is refused when the bound is spent', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      failLimitsReads(2);
      const held = await job(sara, ours);
      jest.restoreAllMocks();
      // Meanwhile the person gets their one goodwill give-back
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      await sweepComputers(new Date(NOW.getTime() + 3 * 60 * 60_000));
      expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await givenBack(held.id)).toBe(false);
    });

    it('does not tell Sentry anything when a read fails once and the retry works', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      (Sentry.captureMessage as jest.Mock).mockClear();
      failLimitsReads(1);
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('never touches a failure Orbit saw itself: it is given back even when the Limits cannot be read', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const lapsing = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Lapsing' }, minutes(100));
      if (!lapsing.ok) throw new Error('no');
      failLimitsReads(10);
      expect(await sweepComputers(minutes(200))).toMatchObject({ stopped: 1 });
      expect(await givenBack(lapsing.job.id)).toBe(true);
    });
  });

  it('leaves a model call on the person’s own key as it was: it is never limited, whatever the give-backs are', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    await job(sara, ours);
    const ended = await job(sara, ours, async (jobId) => {
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
      await settleModelCall(jobId, 'k1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
    });
    // The give-back is over the bound, and the call on their own key is exactly as it was written: theirs, paid by them
    expect(ended.endedBy).toBeNull();
    expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${ended.id}:call:k1` } })).toMatchObject({ payerKind: 'person', payerPersonId: sara.id, personKey: `person:${sara.id}` });
  });

  it('is not a final charge and not unbounded when Limits carry no pause numbers: it is held, and decided when they are set', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
    const sara = await person('sara');
    const held = [] as string[];
    for (let n = 0; n < 3; n++) held.push((await job(sara, ours)).id);
    for (const id of held) {
      expect(await givenBack(id)).toBe(false);
      expect(await decisionOf(id)).toMatchObject({ state: 'pending', basis: expect.stringMatching(/^limits_(missing|unreadable)$/) });
    }
    // Operations see why in the check and the overview
    expect((await giveBackReadiness()).ok).toBe(false);
    expect((await giveBackOverview()).pending.jobs).toBe(3);
    // The numbers are set: the sweep decides them with the bound (2): two are given back, the third is the person's
    await limitsAre(LAUNCH);
    await sweepComputers(new Date(NOW.getTime() + 3 * 60 * 60_000));
    const states = await Promise.all(held.map(async (id) => (await decisionOf(id))?.state));
    expect(states.filter((state) => state === 'given')).toHaveLength(2);
    expect(states.filter((state) => state === 'refused')).toHaveLength(1);
    expect((await giveBackReadiness()).ok).toBe(true);
  });

  it('never gives back what the agent gave up on, or a job that was not reported as ours: the person pays for those whatever the bound', async () => {
    const sara = await person('sara');
    expect(await givenBack((await job(sara, { outcome: 'failed', cause: 'agent' })).id)).toBe(false);
    expect(await givenBack((await job(sara, { outcome: 'failed' })).id)).toBe(false);
  });

  it('is decided once under the person’s lock: two jobs of one person ending at the same moment cannot both take the last give-back', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, minutes(0));
    if (!a.ok) throw new Error('no');
    // A second brick for the same person, so two jobs hold machines at once
    const second = await createBrick({ ownerId: sara.id, name: 'Second' });
    await giveComputer(second.id, sara.id);
    const b = await startJob({ botId: second.id, personId: sara.id, title: 'B' }, minutes(0));
    if (!b.ok) throw new Error('no');
    await Promise.all([finishJob(a.job.id, 'failed', minutes(5), null, 'ours'), finishJob(b.job.id, 'failed', minutes(5), null, 'ours')]);
    expect(await prisma.computerJob.count({ where: { personId: sara.id, endedBy: 'error' } })).toBe(1);
    expect(await prisma.computerJob.count({ where: { personId: sara.id, status: 'failed', endedBy: null } })).toBe(1);
  });

  describe('what the relay saw decides the class of a failure (durable fault rows, judged by Orbit)', () => {
    it('always gives back a confirmed fault of ours, and it uses none of the bound, even when the bound is spent', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      // The bound (1) is spent now. Our own key out of credit is ours all the same, and never counted
      for (const reason of ['provider_key_ours', 'relay_down', 'route_unknown', 'authorize_failed', 'key_decrypt_failed', 'pool_busy']) {
        const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, reason)]));
        expect(await givenBack(ended.id)).toBe(true);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      }
      // Because none of them counted, the next unresolved one is refused only because of the first goodwill one
      const refused = await job(sara, ours);
      expect(await decisionOf(refused.id)).toMatchObject({ state: 'refused', basis: 'cap' });
    });

    it('makes the ending ours when ANY bad turn of the streak had a confirmed fault of ours (a silent turn and two faults on our key)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      const ended = await job(sara, { ...ours, turns: [3, 4, 5] }, withFaults(sara, [fault(3, 'turn:silent', { kind: 'answered', callId: 'turn:3' }), fault(4, 'provider_key_ours', { providerStatus: 402 }), fault(5, 'provider_key_ours', { providerStatus: 402 })]));
      expect(await givenBack(ended.id)).toBe(true);
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', judgedTurns: [3, 4, 5] });
    });

    it('reads only the turns the runner judged failed: a fault of ours on another turn changes nothing', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      const ended = await job(sara, { ...ours, turns: [8] }, withFaults(sara, [fault(2, 'provider_key_ours')]));
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
    });

    it('charges a failure the person caused, with evidence: their allowance, a rule, their own key, a field their job set', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      for (const reason of ['allowance', 'rule', 'field_job_set']) {
        const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, reason)]));
        expect(await givenBack(ended.id)).toBe(false);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'person_caused', reason });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ status: 'failed', endedBy: null });
      }
      // Their own provider REFUSING their key is theirs
      const own = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'own_provider', { source: 'own-key' })]));
      expect(await decisionOf(own.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
    });

    it('does not charge the owner for their own provider failing: a 5xx, a cut stream or a plain 403 on their own key (sent uncertain) is bounded goodwill, while a credential rejection and a resting key stay theirs', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
      const sara = await person('sara');
      for (const [reason, providerStatus] of [['provider_5xx', 500], ['stream_cut', null], ['provider_403', 403]] as const) {
        const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, reason, { source: 'own-key', route: 'own-key', kind: 'uncertain', providerStatus })]));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason });
      }
      for (const providerStatus of [401, 503, null]) {
        const theirs = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'own_provider', { source: 'own-key', route: 'own-key', providerStatus })]));
        expect(await decisionOf(theirs.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
      }
    });

    it('does not charge by source alone: an own-key call with a relay_down row (our relay, kind fault) is given back and not counted, even with the bound spent', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'relay_down', { source: 'own-key', route: 'own-key' })]));
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_down' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      // An own-key timeout the relay was unsure about is unresolved: goodwill, bounded (the bound is spent here)
      const unsure = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'timeout_after_output', { source: 'own-key', route: 'own-key' })]));
      expect(await decisionOf(unsure.id)).toMatchObject({ state: 'refused', basis: 'cap' });
    });

    it('counts a provider 5xx, a 429, a timeout, a fieldless 400, a field only the relay sets and a reason Orbit does not know as unresolved: goodwill, bounded, counted', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 10, pauseMinRuns: 1000 });
      const sara = await person('sara');
      for (const reason of ['provider_5xx', 'provider_429', 'stream_cut', 'timeout_no_output', 'timeout_after_output', 'fieldless_400', 'field_relay_set', 'something_new']) {
        const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, reason)]));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: true });
      }
      // They are the counted ones: the bound reads them
      expect(await prisma.computerJob.count({ where: { personId: sara.id, runnerFault: true } })).toBe(8);
    });

    it('does not take person evidence over a provider failure that may be ours: person evidence next to an unresolved row is goodwill', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const ended = await job(sara, { ...ours, turns: [1, 2] }, withFaults(sara, [fault(1, 'field_job_set'), fault(2, 'provider_5xx')]));
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    });

    it('judges by kind and reason together: a reason of ours the relay did not confirm, or a confirmed kind on another reason, is unresolved, never ours or the person’s', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      // The relay says "uncertain" about a reason Orbit would call ours: not given back past the bound
      const notConfirmed = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_key_ours', { kind: 'uncertain' })]));
      expect(await decisionOf(notConfirmed.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      // A provider failure sent as confirmed is not ours either
      const overConfirmed = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { kind: 'fault' })]));
      expect(await decisionOf(overConfirmed.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      // A person reason the relay did not mark as theirs is not evidence against them
      const unmarked = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'allowance', { kind: 'uncertain' })]));
      expect(await decisionOf(unmarked.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await prisma.computerJob.count({ where: { personId: sara.id, endedBy: 'error' } })).toBe(1);
    });

    it('treats a turn the runner named that has no row as unresolved, never the person’s: one documented person fault and a crash is goodwill', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      // Turn 4 left no row (a crash, a stream that broke): the person's allowance on turn 3 does not make it theirs
      const mixed = await job(sara, { ...ours, turns: [3, 4] }, withFaults(sara, [fault(3, 'allowance')]));
      expect(await decisionOf(mixed.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'no_row' });
      // Every named turn documented as the person's is theirs
      const theirs = await job(sara, { ...ours, turns: [3, 4] }, withFaults(sara, [fault(3, 'allowance'), fault(4, 'rule')]));
      expect(await decisionOf(theirs.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
      // And a streak with a confirmed fault of ours on any turn is ours whatever else it had
      const confirmed = await job(sara, { ...ours, turns: [3, 4, 5] }, withFaults(sara, [fault(4, 'provider_key_ours')]));
      expect(await decisionOf(confirmed.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
    });

    it('ignores answered calls: a row that says a call was answered is never a failure', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'relay_down', { kind: 'answered' })]));
      // No class 1 row: it is an unresolved failure, and goodwill gives it
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    });

    it('lets a fault row that arrives after the job is over change the decision: a late confirmed fault of ours gives back what the bound had refused, uncounted', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const late = await job(sara, { ...ours, turns: [1] });
      expect(await decisionOf(late.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await givenBack(late.id)).toBe(false);
      await recordFaults(sara.brickId, late.id, [fault(1, 'provider_key_ours', { providerStatus: 401 })]);
      await afterLateEvidence(late.id);
      expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      expect(await givenBack(late.id)).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      // Said twice it changes nothing more
      await afterLateEvidence(late.id);
      expect(await prisma.computerJob.count({ where: { personId: sara.id, endedBy: 'error' } })).toBe(2);
    });

    describe('a refusal for our capacity that capacity recovered from (Opus: the refused turn is still ours, with the relay’s own row, on time or late)', () => {
      /** A job whose first call (turn 1) was refused with the pool full, whose later call was authorized (capacity back), and which then failed naming turn 1. `relayRow`: the relay's own fault row for the refused call. */
      const refusedThenRecovered = async (relayRow: 'before' | 'after' | 'never', recovery: 'funded' | 'own_key' = 'funded') => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        // The bound is spent: only a confirmed fault of ours can give this job back (so goodwill can never be what gives it)
        await job(sara, ours);
        let jobId = '';
        const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
          jobId = id;
          const { token } = (await mintJobToken(id, 'model', NOW)) as { token: string };
          await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 60_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
          expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'pool', full: true });
          if (relayRow === 'before') await recordFaults(sara.brickId, id, [fault(1, 'pool_busy', { callId: 'c1' })]);
          // Capacity is back: a later call is authorized, and Orbit's own turnless refusal row is retired. The call may be a funded one or one on the person's own key (CodeRabbit on #1025, 14c4e407 pass, N1): both show the job carried on
          await setUp();
          if (recovery === 'own_key') expect(await authorizeOwnKeyCall(id, NOW)).toBe(true);
          else expect((await authorizeModelCall({ token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW)).ok).toBe(true);
          expect(await prisma.computerJobFault.findMany({ where: { jobId: id, callId: { startsWith: 'orbit:pool:' } }, select: { kind: true, reason: true } })).toEqual([{ kind: 'answered', reason: 'pool_recovered' }]);
        });
        if (relayRow === 'after') {
          expect(await decisionOf(jobId)).toMatchObject({ state: 'refused', basis: 'cap' });
          await recordFaults(sara.brickId, jobId, [fault(1, 'pool_busy', { callId: 'c1' })]);
          await afterLateEvidence(jobId);
        }
        return ended;
      };

      it('a failed finish naming the refused turn is given back as ours, uncounted, when the relay’s row for that turn came first', async () => {
        const ended = await refusedThenRecovered('before');
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'pool_busy' });
        expect(await givenBack(ended.id)).toBe(true);
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      });

      it('the same result when the relay’s row arrives AFTER the finish (the late sweep)', async () => {
        const ended = await refusedThenRecovered('after');
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'pool_busy' });
        expect(await givenBack(ended.id)).toBe(true);
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      });

      it('with no relay row for the refused turn at all, the retired refusal decides nothing: the finish is judged as a turn with no row (here refused at the spent bound), never a flat give-back as ours', async () => {
        const ended = await refusedThenRecovered('never');
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        expect(await givenBack(ended.id)).toBe(false);
      });

      it('CodeRabbit on #1025 (14c4e407 pass, N1): a call admitted on the person’s OWN key retires the earlier pool refusal too, so a later unrelated agent failure is never given back as ours from it', async () => {
        const ended = await refusedThenRecovered('never', 'own_key');
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        expect(await givenBack(ended.id)).toBe(false);
      });

      it('N1 CONTROL: with no admission at all after the refusal, the row stays a fault and the finish reads it (given back as ours)', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        await job(sara, ours);
        const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
          const { token } = (await mintJobToken(id, 'model', NOW)) as { token: string };
          await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 60_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
          expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'pool', full: true });
          await recordFaults(sara.brickId, id, [fault(1, 'pool_busy', { callId: 'c1' })]);
        });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'pool_busy' });
      });

      it('N1: a retirement that cannot be written refuses the own-key call: no own-key marker and no turn admission are kept', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
        if (!started.ok) throw new Error('the job did not start');
        const id = started.job.id;
        const { token } = (await mintJobToken(id, 'model', NOW)) as { token: string };
        await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 60_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'pool', full: true });
        await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION n1_fail_retire() RETURNS trigger AS $$ BEGIN IF NEW."reason" = 'pool_recovered' THEN RAISE EXCEPTION 'cannot retire'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe('CREATE TRIGGER n1_fail_retire BEFORE UPDATE ON "computer_job_faults" FOR EACH ROW EXECUTE FUNCTION n1_fail_retire()');
        try {
          await expect(authorizeOwnKeyCall(id, NOW, undefined, { turn: 1, run: 'r1' })).rejects.toThrow();
        } finally {
          await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS n1_fail_retire ON "computer_job_faults"');
          await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS n1_fail_retire()');
        }
        expect(await hasOwnKeyCall(prisma, id)).toBe(false);
        expect(await prisma.computerJobFault.count({ where: { jobId: id, callId: { startsWith: 'orbit:pool:' }, kind: 'fault' } })).toBe(1);
      });
    });

    it('a confirmed fault stored while the finish was being committed is not lost: the sweep looks again at every decision it is newer than, and marks what it looked at', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      // The finish read no evidence and refused (the bound is used); the fault was stored by a write that overlapped it, so the route's own look found no decision and did nothing
      const late = await job(sara, { ...ours, turns: [1] });
      expect(await decisionOf(late.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      await prisma.computerJobFault.create({ data: { jobId: late.id, callId: 'overlap-1', turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
      expect(await decisionOf(late.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      // (the computer sweep does it)
      await sweepComputers(new Date());
      expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      expect(await givenBack(late.id)).toBe(true);
      // Goodwill that was counted is freed the same way when a confirmed fault of ours turns up (a refusal by delivery stays: the same verdict as on time, see below)
      const counted = await job(sara, { ...ours, turns: [1], run: 'runz' }, withFaults(sara, [fault(1, 'provider_5xx', { run: 'runz' })]));
      await prisma.computerJob.update({ where: { id: counted.id }, data: { runnerFault: true } });
      await prisma.computerGiveBackDecision.update({ where: { jobId: counted.id }, data: { state: 'given', basis: 'goodwill' } });
      await prisma.computerJobFault.create({ data: { jobId: counted.id, callId: 'overlap-2', turn: 1, run: 'runz', kind: 'fault', reason: 'relay_down', source: 'universe-ai', route: null, at: new Date() } });
      await sweepLateEvidence(new Date());
      expect(await decisionOf(counted.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: counted.id } })).runnerFault).toBe(false);
      // Looked at: with its rows older than the margin it is not looked at again, and nothing about it moves
      await prisma.computerJobFault.updateMany({ where: { jobId: { in: [late.id, counted.id] } }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
      expect((await sweepLateEvidence(new Date(), 500)).looked).toBe(0);
    });

    it('a late-evidence look that throws is marked all the same, so the decisions behind it are looked at', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const first = await job(sara, { ...ours, turns: [1] });
      const second = await job(sara, { ...ours, turns: [1] });
      for (const [one, call] of [[first, 'throws-1'], [second, 'throws-2']] as const) {
        expect(await decisionOf(one.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        await prisma.computerJobFault.create({ data: { jobId: one.id, callId: call, turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
      }
      // Only the first one's look throws (its decision cannot be read this time)
      const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const spy = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => (args?.where?.jobId === first.id ? Promise.reject(new Error('blip')) : realFind(args as never))) as never);
      try {
        // One slot: the first (oldest) is looked at and throws; it is marked, so the next sweep reaches the one behind it
        await sweepLateEvidence(new Date(), 1);
        await sweepLateEvidence(new Date(), 1);
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }
      expect(await decisionOf(second.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      expect(await decisionOf(first.id)).toMatchObject({ state: 'refused' });
    });

    describe('a late look that keeps throwing is never dropped', () => {
      const failing = async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        await job(sara, ours);
        const refused = await job(sara, { ...ours, turns: [1] });
        expect(await peek(refused.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        await prisma.computerJobFault.create({ data: { jobId: refused.id, callId: `keep-${refused.id}`, turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
        return refused;
      };
      // The look's own read of the decision fails for this job; the test's reads (peek) are never the look's
      let looking = true;
      const throwFor = (jobId: string) => {
        const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
        return jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => (looking && args?.where?.jobId === jobId ? Promise.reject(new Error('blip')) : realFind(args as never))) as never);
      };
      const peek = async (id: string) => {
        looking = false;
        try {
          return await decisionOf(id);
        } finally {
          looking = true;
        }
      };

      it('is looked at again on its own retry time, however old its rows are, and gives the job back once it stops throwing (a refused row with a retry time is never treated as pending)', async () => {
        const refused = await failing();
        const t0 = new Date();
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const spy = throwFor(refused.id);
        try {
          await sweepLateEvidence(t0);
          expect(await peek(refused.id)).toMatchObject({ state: 'refused', attempts: 1, lastError: expect.stringMatching(/^late_look:/) });
          const retry = (await peek(refused.id))?.nextAttemptAt as Date;
          expect(retry.getTime()).toBeGreaterThan(t0.getTime());
          // Not before its time (its row is still inside the margin, which is no reason to look sooner)
          expect((await sweepLateEvidence(new Date(t0.getTime() + 30_000))).looked).toBe(0);
          // On its time it is looked at, throws again, and waits longer
          expect((await sweepLateEvidence(new Date(retry.getTime() + 1000))).looked).toBe(1);
          expect(await peek(refused.id)).toMatchObject({ state: 'refused', attempts: 2 });
          expect(((await peek(refused.id))?.nextAttemptAt as Date).getTime()).toBeGreaterThan(retry.getTime() + 60_000);
          // The pending sweep and the purge never take it for a pending decision
          expect(await sweepGiveBackDecisions(new Date(t0.getTime() + 24 * 3_600_000))).toMatchObject({ looked: 0 });
          expect(await peek(refused.id)).toMatchObject({ state: 'refused', attempts: 2 });
        } finally {
          spy.mockRestore();
          quiet.mockRestore();
        }
        // Long after the margin (its row is an hour old), and it has stopped throwing: it is looked at by its retry time and the job is given back
        await prisma.computerJobFault.updateMany({ where: { jobId: refused.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
        const later = new Date(t0.getTime() + 2 * 3_600_000);
        expect((await sweepLateEvidence(later)).looked).toBe(1);
        expect(await peek(refused.id)).toMatchObject({ state: 'given', basis: 'universe_fault', nextAttemptAt: null, lastError: null });
        expect(await givenBack(refused.id)).toBe(true);
        expect((await sweepLateEvidence(new Date(later.getTime() + 3_600_000))).looked).toBe(0);
      });

      it('tells Sentry once when a look has been failing for an hour (the alert is claimed; a capture that throws is told again by the next sweep)', async () => {
        const refused = await failing();
        const captured = Sentry.captureMessage as jest.Mock;
        captured.mockClear();
        const t0 = new Date();
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const spy = throwFor(refused.id);
        try {
          await sweepLateEvidence(t0);
          expect(captured).not.toHaveBeenCalled();
          captured.mockImplementationOnce(() => {
            throw new Error('sentry down');
          });
          // An hour after the first failure: told (the capture throws, so the claim is given back), and told again by the next failing sweep, then never again
          for (const hours of [1.02, 2.04, 3.06, 4.08]) await sweepLateEvidence(new Date(t0.getTime() + hours * 3_600_000));
          expect(captured).toHaveBeenCalledTimes(2);
          expect(await peek(refused.id)).toMatchObject({ lastError: expect.stringMatching(/^late_look_told:/) });
        } finally {
          spy.mockRestore();
          quiet.mockRestore();
        }
      });

      it('flushes the alert inside the claim: a flush that does not confirm leaves the look unmarked as told, and the next failing look tells it', async () => {
        const refused = await failing();
        const captured = Sentry.captureMessage as jest.Mock;
        const getClient = Sentry.getClient as jest.Mock;
        const flush = Sentry.flush as jest.Mock;
        captured.mockClear();
        flush.mockClear();
        const t0 = new Date();
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const spy = throwFor(refused.id);
        try {
          getClient.mockReturnValue({});
          await sweepLateEvidence(t0);
          flush.mockResolvedValueOnce(false);
          await sweepLateEvidence(new Date(t0.getTime() + 1.02 * 3_600_000));
          expect(flush).toHaveBeenCalledWith(2_000);
          expect(await peek(refused.id)).toMatchObject({ lastError: expect.stringMatching(/^late_look:/) });
          await sweepLateEvidence(new Date(t0.getTime() + 2.04 * 3_600_000));
          expect(captured).toHaveBeenCalledTimes(2);
          expect(await peek(refused.id)).toMatchObject({ lastError: expect.stringMatching(/^late_look_told:/) });
        } finally {
          getClient.mockReturnValue(undefined);
          spy.mockRestore();
          quiet.mockRestore();
        }
      });
    });

    it('a late look that failed never writes an older marker over another sweep’s: the reschedule is made only over the marker it read, so the alert is not told twice', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const refused = await job(sara, { ...ours, turns: [1] });
      await prisma.computerJobFault.create({ data: { jobId: refused.id, callId: `keep-${refused.id}`, turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let looking = true;
      const peek = async () => {
        looking = false;
        try {
          return await decisionOf(refused.id);
        } finally {
          looking = true;
        }
      };
      const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
      const find = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => (looking && args?.where?.jobId === refused.id ? Promise.reject(new Error('blip')) : realFind(args as never))) as never);
      try {
        const t0 = new Date();
        await sweepLateEvidence(t0);
        const first = await peek();
        expect(first).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/^late_look:/) });
        // Another sweep tells Sentry between this look's read of the marker and its write of the new one
        const told = `late_look_told:${first?.lastError?.split(':')[1]}`;
        const realExec = prisma.$executeRaw.bind(prisma) as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
        const exec = jest.spyOn(prisma, '$executeRaw').mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('?').includes('"attempts" + 1')) {
            exec.mockRestore();
            await prisma.computerGiveBackDecision.updateMany({ where: { jobId: refused.id }, data: { lastError: told } });
          }
          return realExec(strings, ...values);
        }) as never);
        try {
          await sweepLateEvidence(new Date((first?.nextAttemptAt as Date).getTime() + 1000));
        } finally {
          exec.mockRestore();
        }
        expect(await peek()).toMatchObject({ lastError: told, attempts: 1 });
      } finally {
        find.mockRestore();
        quiet.mockRestore();
      }
    });

    describe('late evidence is judged by the age of the NEW row, not of the decision', () => {
      const DAY = 24 * 3_600_000;
      /** A refused decision (the bound is spent) for a job whose turn 1 has the given fault row, all of it long ago. */
      const oldRefused = async (rows: FaultInput[]) => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        await job(sara, ours);
        const refused = await job(sara, { ...ours, turns: [1] }, withFaults(sara, rows));
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        const long = new Date(Date.now() - 40 * DAY);
        await prisma.computerGiveBackDecision.update({ where: { jobId: refused.id }, data: { updatedAt: long } });
        await prisma.computerJobFault.updateMany({ where: { jobId: refused.id }, data: { createdAt: long } });
        return { sara, refused };
      };

      it('a fault row that arrives for a decision older than 30 days is looked at: the horizon is the new row’s age', async () => {
        const { sara, refused } = await oldRefused([fault(1, 'provider_5xx')]);
        // Nothing new: the old decision is not looked at
        expect((await sweepLateEvidence(new Date())).looked).toBe(0);
        await recordFaults(sara.brickId, refused.id, [fault(1, 'provider_key_ours')]);
        expect((await sweepLateEvidence(new Date())).looked).toBe(1);
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(refused.id)).toBe(true);
      });

      it('a confirmation of an old uncertain row is new evidence: settling it sets when Orbit learned it, so the sweep sees it', async () => {
        const row = fault(1, 'timeout_after_output');
        const { sara, refused } = await oldRefused([row]);
        expect((await sweepLateEvidence(new Date())).looked).toBe(0);
        // The same call, now known to be ours
        expect(await recordFaults(sara.brickId, refused.id, [{ ...row, kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 1, conflicts: 0 });
        expect((await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: refused.id } })).createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect((await sweepLateEvidence(new Date())).looked).toBe(1);
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });

      it('a row older than 30 days is no new evidence, and a look that threw is retried however old the decision is', async () => {
        const { refused } = await oldRefused([fault(1, 'provider_5xx')]);
        await prisma.computerJobFault.create({ data: { jobId: refused.id, callId: 'ancient', turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: null, at: new Date(), createdAt: new Date(Date.now() - 35 * DAY) } });
        await prisma.computerGiveBackDecision.update({ where: { jobId: refused.id }, data: { updatedAt: new Date(Date.now() - 50 * DAY) } });
        expect((await sweepLateEvidence(new Date())).looked).toBe(0);
        // A look that threw is marked for its retry time: that alone brings it back, however old it is
        await prisma.computerGiveBackDecision.update({ where: { jobId: refused.id }, data: { lastError: `late_look:${Date.now()}`, nextAttemptAt: new Date(Date.now() - 1000), attempts: 1, updatedAt: new Date(Date.now() - 50 * DAY) } });
        expect((await sweepLateEvidence(new Date())).looked).toBe(1);
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'given', basis: 'universe_fault', lastError: null, nextAttemptAt: null });
      });
    });

    describe('an effect settled while a decision is made again (the person’s lock orders them)', () => {
      const heldForEffect = async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-1', kind: 'send' });
        });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        return held;
      };

      it('settlement first: the retry sees the effect done, and done means none (unresolved rows only: refused, delivered)', async () => {
        const held = await heldForEffect();
        expect(await settleEffect(held.id, 'mail-1', 'done', 'ali@example.test')).toBe(true);
        // The settlement decides the held decision itself; a retry that comes after finds nothing pending and changes nothing
        expect(await resolveDecision(held.id, minutes(30))).toBe('none');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'delivered', deliveredLate: false });
        expect(await givenBack(held.id)).toBe(false);
      });

      it('grant first: the settlement that comes after flags the give-back as delivered late, and the give-back stays', async () => {
        const held = await heldForEffect();
        // The wait for the effect is over: the retry grants goodwill with the effect still planned
        await prisma.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { decidedAt: new Date(Date.now() - 3 * 24 * 3_600_000) } });
        expect(await resolveDecision(held.id, new Date())).toBe('resolved');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'goodwill', deliveredLate: false });
        expect(await settleEffect(held.id, 'mail-1', 'done', 'ali@example.test')).toBe(true);
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'goodwill', deliveredLate: true });
        expect(await givenBack(held.id)).toBe(true);
      });

      it('a settlement waits for the person’s lock before it touches the effect, so it can never land between a retry’s read of the effect and its grant', async () => {
        const held = await heldForEffect();
        let finished = false;
        let settled: Promise<boolean> = Promise.resolve(false);
        let fixtureError: { error: unknown } | null = null;
        const fixture = async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
          await lockPerson(tx, held.personId);
          // The lock this fixture holds, read from its own granted row in the lock table, and the fixture's own backend
          const mine = (await tx.$queryRaw<Array<{ pid: number; classid: number; objid: number; objsubid: number }>>`
            SELECT pg_backend_pid() AS pid, classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)[0];
          settled = settleEffect(held.id, 'mail-1', 'done', 'ali@example.test').finally(() => {
            finished = true;
          });
          settled.catch(() => undefined);
          // A backend OTHER than the fixture's is waiting for that very lock (a barrier on the database's own lock table, no timer): polled for a bounded time, never past the
          // settlement finishing (it would then have gone round the lock, which is the failure)
          const waiting = async () =>
            (await prisma.$queryRaw<Array<{ n: number }>>`
              SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::int = ${mine.classid} AND objid::int = ${mine.objid} AND objsubid::int = ${mine.objsubid} AND pid <> ${mine.pid}`)[0].n;
          const deadline = Date.now() + 5_000;
          while (!finished && (await waiting()) === 0) {
            if (Date.now() > deadline) throw new Error('the settlement never waited for the person’s lock');
            await new Promise((resolve) => setImmediate(resolve));
          }
          expect(finished).toBe(false);
          // ...and the effect has not moved
          expect((await tx.computerEffect.findFirstOrThrow({ where: { jobId: held.id } })).state).toBe('planned');
        };
        try {
          await prisma.$transaction(fixture, HOLDER);
        } catch (error) {
          fixtureError = { error };
        }
        // The person's lock is released (the fixture's transaction is over, committed or rolled back): the settlement can finish, and it is always awaited, so no settlement is left
        // dangling whatever happened above. The fixture's own error, when there is one, is the one the test fails with
        const outcome = await settled.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (fixtureError) throw (fixtureError as { error: unknown }).error;
        expect(outcome).toEqual({ value: true });
        expect((await prisma.computerEffect.findFirstOrThrow({ where: { jobId: held.id } })).state).toBe('done');
      });
    });

    it('an older successful look never clears a NEWER failed look’s retry: only the retry the look read is cleared', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const refused = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(refused.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      const t0 = new Date();
      // A look that threw earlier left a retry that is due now
      await prisma.computerGiveBackDecision.update({ where: { jobId: refused.id }, data: { lastError: `late_look:${t0.getTime() - 1000}`, attempts: 1, nextAttemptAt: new Date(t0.getTime() - 1000) } });
      const newer = new Date(t0.getTime() + 3_600_000);
      // Sweep A has read the row as due; before its look ends, sweep B's look fails and records a newer retry
      const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
      let injected = false;
      const spy = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => {
        if (!injected && args?.where?.jobId === refused.id) {
          injected = true;
          return prisma.computerGiveBackDecision.updateMany({ where: { jobId: refused.id }, data: { lastError: `late_look:${t0.getTime() - 1000}`, attempts: 2, nextAttemptAt: newer } }).then(() => realFind(args as never));
        }
        return realFind(args as never);
      }) as never);
      try {
        expect((await sweepLateEvidence(t0)).looked).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      // B's retry stands, so the next sweep at its time looks again
      expect(await decisionOf(refused.id)).toMatchObject({ attempts: 2, nextAttemptAt: newer, lastError: expect.stringMatching(/^late_look:/) });
      expect((await sweepLateEvidence(new Date(newer.getTime() + 1000))).looked).toBe(1);
      // ...and that look, uncontested, ends its own retry
      expect(await decisionOf(refused.id)).toMatchObject({ nextAttemptAt: null, lastError: null });
    });

    it('two failing looks over the same marker: the one that read the older state never moves the deadline back (the reschedule is also made only over the attempts it read)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const refused = await job(sara, { ...ours, turns: [1] });
      await prisma.computerJobFault.create({ data: { jobId: refused.id, callId: `keep-${refused.id}`, turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let looking = true;
      const peek = async () => {
        looking = false;
        try {
          return await decisionOf(refused.id);
        } finally {
          looking = true;
        }
      };
      const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
      const find = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => (looking && args?.where?.jobId === refused.id ? Promise.reject(new Error('blip')) : realFind(args as never))) as never);
      try {
        const t0 = new Date();
        await sweepLateEvidence(t0);
        const first = await peek();
        expect(first).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/^late_look:/) });
        // Another sweep, over the same marker, fails after this one read the row and writes a LATER deadline
        const later = new Date(Date.now() + 24 * 3_600_000);
        const realExec = prisma.$executeRaw.bind(prisma) as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
        const exec = jest.spyOn(prisma, '$executeRaw').mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('?').includes('"attempts" + 1')) {
            exec.mockRestore();
            await prisma.computerGiveBackDecision.updateMany({ where: { jobId: refused.id }, data: { attempts: 2, nextAttemptAt: later } });
          }
          return realExec(strings, ...values);
        }) as never);
        try {
          await sweepLateEvidence(new Date((first?.nextAttemptAt as Date).getTime() + 1000));
        } finally {
          exec.mockRestore();
        }
        expect(await peek()).toMatchObject({ attempts: 2, nextAttemptAt: later });
      } finally {
        find.mockRestore();
        quiet.mockRestore();
      }
    });

    it('the pending-age alert is claimed by a row lock: a sweep that finds the row locked by another skips it, a worker that dies leaves it for the next sweep, and the mark is set in the same transaction that tells Sentry', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
      const sara = await person('sara');
      const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await planEffect(id, { key: 'lock-1', kind: 'send' });
      });
      await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { decidedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000), nextAttemptAt: new Date(NOW.getTime() + 24 * 60 * 60_000) } });
      const captured = Sentry.captureMessage as jest.Mock;
      captured.mockClear();
      // Another sweep holds the row; the assertions made while it is held reach the test, and only the worker's own death is swallowed
      await afterWorkerDied(
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "job_id" FROM "computer_give_back_decisions" WHERE "job_id" = ${ended.id} FOR UPDATE`;
          expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 0 });
          expect(captured).not.toHaveBeenCalled();
          throw new WorkerDied();
        }, HOLDER),
      );
      expect((await decisionOf(ended.id))?.alertedAt).toBeNull();
      expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 1 });
      expect(captured).toHaveBeenCalledTimes(1);
      expect((await decisionOf(ended.id))?.alertedAt).not.toBeNull();
    });

    it('the pending-age alert is flushed inside the claim: a flush that does not confirm leaves it unmarked for the next sweep, and with no Sentry client it commits at once', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
      const sara = await person('sara');
      const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await planEffect(id, { key: 'flush-1', kind: 'send' });
      });
      await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { decidedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000), nextAttemptAt: new Date(NOW.getTime() + 24 * 60 * 60_000) } });
      const captured = Sentry.captureMessage as jest.Mock;
      const getClient = Sentry.getClient as jest.Mock;
      const flush = Sentry.flush as jest.Mock;
      captured.mockClear();
      flush.mockClear();
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        getClient.mockReturnValue({});
        flush.mockResolvedValueOnce(false);
        expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 0 });
        expect(flush).toHaveBeenCalledWith(2_000);
        expect((await decisionOf(ended.id))?.alertedAt).toBeNull();
        expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 1 });
        expect(captured).toHaveBeenCalledTimes(2);
        expect((await decisionOf(ended.id))?.alertedAt).not.toBeNull();
        await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { alertedAt: null } });
        getClient.mockReturnValue(undefined);
        flush.mockClear();
        expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 1 });
        expect(flush).not.toHaveBeenCalled();
      } finally {
        getClient.mockReturnValue(undefined);
        quiet.mockRestore();
      }
    });

    it('the late-look alert is claimed by a row lock: a failing look that finds the row locked by another skips the alert, and the next failing look tells it', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, ours);
      const refused = await job(sara, { ...ours, turns: [1] });
      await prisma.computerJobFault.create({ data: { jobId: refused.id, callId: `keep-${refused.id}`, turn: 1, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() } });
      const captured = Sentry.captureMessage as jest.Mock;
      captured.mockClear();
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let looking = true;
      const peek = async () => {
        looking = false;
        try {
          return await decisionOf(refused.id);
        } finally {
          looking = true;
        }
      };
      const realFind = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
      const find = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => (looking && args?.where?.jobId === refused.id ? Promise.reject(new Error('blip')) : realFind(args as never))) as never);
      try {
        const t0 = new Date();
        await sweepLateEvidence(t0);
        // An hour later the look fails again and would tell Sentry; another sweep holds the row at that moment (taken right after this look wrote its marker)
        const realExec = prisma.$executeRaw.bind(prisma) as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
        let release: () => void = () => undefined;
        let holderDone: Promise<void> = Promise.resolve();
        const exec = jest.spyOn(prisma, '$executeRaw').mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const done = await realExec(strings, ...values);
          if (strings.join('?').includes('"attempts" + 1')) {
            exec.mockRestore();
            let locked: () => void = () => undefined;
            const holding = new Promise<void>((resolve) => {
              locked = resolve;
            });
            // Only the worker's own death after it took the lock is swallowed: a fixture that fails BEFORE the lock rejects the wait below and reaches the test
            holderDone = afterWorkerDied(
              prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT "job_id" FROM "computer_give_back_decisions" WHERE "job_id" = ${refused.id} FOR UPDATE`;
                locked();
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
                throw new WorkerDied();
              }, HOLDER),
            );
            await Promise.race([holding, holderDone]);
          }
          return done;
        }) as never);
        try {
          await sweepLateEvidence(new Date(t0.getTime() + 61 * 60_000 + 5_000));
        } finally {
          exec.mockRestore();
          release();
          await holderDone;
        }
        expect(captured).not.toHaveBeenCalled();
        expect(await peek()).toMatchObject({ lastError: expect.stringMatching(/^late_look:/) });
        // The worker died: the next failing look tells it
        await sweepLateEvidence(new Date(t0.getTime() + 3 * 3_600_000));
        expect(captured).toHaveBeenCalledTimes(1);
        expect(await peek()).toMatchObject({ lastError: expect.stringMatching(/^late_look_told:/) });
      } finally {
        find.mockRestore();
        quiet.mockRestore();
      }
    });

    it('late evidence gives the same verdict as evidence on time: a confirmed fault of ours is given back even where the work was delivered, on the sweep as on the first look (both paths agree)', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      // On time: delivered work and a confirmed fault of ours in what was judged
      const onTime = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await recordFaults(sara.brickId, id, [fault(1, 'relay_down')]);
        await planEffect(id, { key: 'same-1', kind: 'send' });
        await settleEffect(id, 'same-1', 'done', 'ali@example.test');
      });
      // Late: the same, the fault row arriving after the finish judged the delivery
      const late = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await planEffect(id, { key: 'same-2', kind: 'send' });
        await settleEffect(id, 'same-2', 'done', 'ali@example.test');
      });
      expect(await decisionOf(late.id)).toMatchObject({ state: 'refused', basis: 'delivered' });
      await prisma.computerJobFault.create({ data: { jobId: late.id, callId: 'same-late', turn: 1, kind: 'fault', reason: 'relay_down', source: 'universe-ai', route: null, at: new Date() } });
      await sweepLateEvidence(new Date());
      // What the late path decides is pinned to what the on-time path decided
      const onTimeDecision = await decisionOf(onTime.id);
      expect(onTimeDecision).toMatchObject({ state: 'given', basis: 'universe_fault' });
      const lateDecision = await decisionOf(late.id);
      expect({ state: lateDecision?.state, basis: lateDecision?.basis }).toEqual({ state: onTimeDecision?.state, basis: onTimeDecision?.basis });
    });

    it('a give-back decided while the end is writing the job’s time never leaves that time on the person: the end looks again after writing it, and the sweep detaches what it could not', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      // (1) The race itself: the end committed with its decision pending; the effect is confirmed not done (the decision gives the job back, and no time event exists yet to detach)
      // while the end is still revoking the job's keys, and the end then writes the time with the ending it read before
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!started.ok) throw new Error('no');
      const jobId = started.job.id;
      await planEffect(jobId, { key: 'race-1', kind: 'send' });
      const revoke = revokeJobTokens as jest.Mock;
      const real = revoke.getMockImplementation();
      revoke.mockImplementationOnce(async (...args: unknown[]) => {
        expect(await decisionOf(jobId)).toMatchObject({ state: 'pending' });
        expect(await settleEffect(jobId, 'race-1', 'failed')).toBe(true);
        expect(await decisionOf(jobId)).toMatchObject({ state: 'given' });
        expect(await prisma.meterEvent.findUnique({ where: { eventId: `computer:${jobId}:time` } })).toBeNull();
        return (real as (...a: unknown[]) => Promise<unknown>)(...args);
      });
      await finishJob(jobId, 'failed', minutes(5), null, 'ours', [1]);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'failed', endedBy: 'error' });
      expect(await givenBack(jobId)).toBe(true);
      // (2) The same with the end that could not look again (its read failed): the sweep finds the time still on the person and detaches it
      const stuck = await job(sara, { ...ours, turns: [1] });
      expect(await decisionOf(stuck.id)).toMatchObject({ state: 'given' });
      await prisma.$executeRaw`UPDATE meter_events SET "person_key" = ${`person:${sara.id}`}, "person_id" = ${sara.id}, "detail" = "detail" - 'givenBack' - 'forPersonId' WHERE "event_id" = ${`computer:${stuck.id}:time`}`;
      expect(await givenBack(stuck.id)).toBe(false);
      await sweepComputers(minutes(60));
      expect(await givenBack(stuck.id)).toBe(true);
      expect((await timeOf(stuck.id)).detail).toMatchObject({ givenBack: true, forPersonId: sara.id });
    });

    it('a give-back pending for a long time is told to Sentry once: the alert is claimed by a write only one sweep wins, a capture that throws is told again by the next sweep, and one failing row does not end the loop', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const waiting = async (key: string) => {
        const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await planEffect(id, { key, kind: 'send' });
        });
        // Pending for days, and not due for a new decision (so only the age alert looks at it)
        await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { decidedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000), nextAttemptAt: new Date(NOW.getTime() + 24 * 60 * 60_000) } });
        return ended.id;
      };
      const one = await waiting('age-1');
      const alertedAt = async (id: string) => (await prisma.computerGiveBackDecision.findUniqueOrThrow({ where: { jobId: id } })).alertedAt;
      const captured = Sentry.captureMessage as jest.Mock;
      captured.mockClear();
      // Another sweep claims the alert between this one's read and its own claim: this one says nothing
      const realFindMany = prisma.computerGiveBackDecision.findMany.bind(prisma.computerGiveBackDecision);
      const spy = jest.spyOn(prisma.computerGiveBackDecision, 'findMany').mockImplementation(((args: { where?: { alertedAt?: null } }) => {
        const read = realFindMany(args as never);
        if (args?.where?.alertedAt !== null) return read;
        return read.then(async (rows) => {
          await prisma.computerGiveBackDecision.updateMany({ where: { jobId: one }, data: { alertedAt: minutes(1) } });
          return rows;
        });
      }) as never);
      try {
        expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 0 });
      } finally {
        spy.mockRestore();
      }
      expect(captured).not.toHaveBeenCalled();
      // Two sweeps together tell it once
      await prisma.computerGiveBackDecision.update({ where: { jobId: one }, data: { alertedAt: null } });
      const [a, b] = await Promise.all([sweepGiveBackDecisions(minutes(1)), sweepGiveBackDecisions(minutes(1))]);
      expect(a.alerted + b.alerted).toBe(1);
      expect(captured).toHaveBeenCalledTimes(1);
      // A capture that throws gives the claim back and does not stop the rows behind it; the next sweep tells both
      const two = await waiting('age-2');
      await prisma.computerGiveBackDecision.update({ where: { jobId: one }, data: { alertedAt: null } });
      captured.mockClear();
      captured.mockImplementationOnce(() => {
        throw new Error('sentry down');
      });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 1 });
      } finally {
        quiet.mockRestore();
      }
      expect(captured).toHaveBeenCalledTimes(2);
      const failed = [one, two];
      const states = await Promise.all(failed.map(alertedAt));
      expect(states.filter((value) => value === null)).toHaveLength(1);
      expect(await sweepGiveBackDecisions(minutes(1))).toMatchObject({ alerted: 1 });
      expect(await Promise.all(failed.map(alertedAt))).toEqual([expect.any(Date), expect.any(Date)]);
    });

    it('never lets a late row take a give-back back: a goodwill give-back stays given when a person’s row arrives after it', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const given = await job(sara, { ...ours, turns: [1] });
      expect(await givenBack(given.id)).toBe(true);
      await recordFaults(sara.brickId, given.id, [fault(1, 'allowance')]);
      await afterLateEvidence(given.id);
      expect(await givenBack(given.id)).toBe(true);
    });

    describe('every failed finish is judged by Orbit from the rows, whatever the runner said (the hint is evidence, never the verdict)', () => {
      /** What the person sees on their month bar for computers, and what is written against them for the job. */
      const seen = async (p: { id: string; brickId: string }, at: Date) => (await computerView(p.brickId, p.id, at))?.month?.leftFraction;
      const charged = async (jobId: string) => !(await givenBack(jobId));
      const row401 = (turn: number, extra: Partial<FaultInput> = {}) => fault(turn, 'provider_key_ours', { providerStatus: 401, ...extra });

      for (const hint of ['agent', null] as const) {
        const ending = (turns?: number[], runName?: string) => ({ outcome: 'failed' as const, ...(hint ? { cause: hint } : {}), ...(turns ? { turns } : {}), ...(runName ? { run: runName } : {}) });

        it(`evidence BEFORE the finish (hint ${hint ?? 'none'}): a confirmed 401 on Universe's key on the second of three named turns gives the job back, uncounted, time and model calls together`, async () => {
          await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
          const sara = await person('sara');
          const ended = await job(sara, ending([1, 2, 3], 'run1'), async (jobId) => {
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW);
            await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
            await recordFaults(sara.brickId, jobId, [fault(1, 'stream_cut', { run: 'run1' }), row401(2, { run: 'run1' }), fault(3, 'stream_cut', { run: 'run1' })]);
          });
          expect(ended).toMatchObject({ status: 'failed', endedBy: 'error', runnerFault: false });
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'provider_key_ours', causeHint: hint ?? 'none', judgedTurns: [1, 2, 3], judgedRun: 'run1' });
          expect(await givenBack(ended.id)).toBe(true);
          expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${ended.id}:call:c1` } })).personKey).toBe('unknown');
          expect(await seen(sara, minutes(6))).toBe(1);
          // It used none of the person's bound: the next unresolved failure still gets its goodwill
          const next = await job(sara, ending([1]), withFaults(sara, [fault(1, 'provider_5xx')]));
          expect(await decisionOf(next.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
        });

        it(`evidence AFTER the finish (hint ${hint ?? 'none'}): the same 401 arriving late corrects the charge ONCE, and said again changes nothing`, async () => {
          await limitsAre(LAUNCH);
          const sara = await person('sara');
          const ended = await job(sara, ending([1, 2, 3], 'run1'), async (jobId) => {
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW);
            await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
          });
          // The finish found nothing recorded: the agent ended on its own, and the person is charged for now
          expect(ended).toMatchObject({ status: 'failed', endedBy: null });
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'agent_ended', causeHint: hint ?? 'none' });
          expect(await charged(ended.id)).toBe(true);
          expect(await seen(sara, minutes(6))).toBeLessThan(1);
          // A late row of another run, or of a turn nobody judged, is not evidence: nothing changes
          await recordFaults(sara.brickId, ended.id, [row401(2, { run: 'other-run' }), row401(9, { run: 'run1' })]);
          await afterLateEvidence(ended.id);
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
          expect(await charged(ended.id)).toBe(true);
          // A late UNRESOLVED row for the judged turn is judged as it would have been on time: bounded goodwill, counted
          await recordFaults(sara.brickId, ended.id, [fault(2, 'provider_5xx', { run: 'run1' })]);
          await afterLateEvidence(ended.id);
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ endedBy: 'error', runnerFault: true });
          expect(await charged(ended.id)).toBe(false);
          // The confirmed 401 for the same job, run and second turn: the charge is corrected, once
          await recordFaults(sara.brickId, ended.id, [row401(2, { run: 'run1' })]);
          await afterLateEvidence(ended.id);
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'provider_key_ours' });
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({ status: 'failed', endedBy: 'error', runnerFault: false });
          expect(await givenBack(ended.id)).toBe(true);
          expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${ended.id}:call:c1` } })).personKey).toBe('unknown');
          expect(await seen(sara, minutes(6))).toBe(1);
          // Said again, by the late look and by the sweep: still one give-back, nothing taken back or done twice
          await afterLateEvidence(ended.id);
          await sweepLateEvidence(minutes(7));
          await sweepComputers(minutes(8));
          expect(await prisma.meterEvent.count({ where: { eventId: `computer:${ended.id}:time` } })).toBe(1);
          expect(await prisma.meterEvent.count({ where: { jobId: ended.id, personKey: `person:${sara.id}` } })).toBe(0);
          expect(await prisma.computerJob.count({ where: { personId: sara.id, endedBy: 'error' } })).toBe(1);
        });
      }

      it('the sweep finds the late row by itself (the route that stores a row may not reach afterLateEvidence), once, for a refused decision under a hint', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const ended = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1, 2] });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        await recordFaults(sara.brickId, ended.id, [row401(2)]);
        expect(await sweepLateEvidence(minutes(30))).toMatchObject({ looked: 1 });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await sweepLateEvidence(minutes(31))).toMatchObject({ looked: 0 });
      });

      it('a runner that names no turns is read at the last turn with a row: the finish and a late row both', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        // Turn 1 was only a hiccup of the provider; the last turn with a row is 3, which was ours
        const ours3 = await job(sara, { outcome: 'failed', cause: 'agent' }, withFaults(sara, [fault(1, 'provider_5xx'), row401(3)]));
        expect(await decisionOf(ours3.id)).toMatchObject({ state: 'given', basis: 'universe_fault', judgedTurns: [3] });
        // A confirmed fault of ours on an EARLIER turn, recovered from, is not why the job ended
        const earlier = await job(sara, { outcome: 'failed', cause: 'agent' }, withFaults(sara, [row401(1), fault(4, 'stream_cut')]));
        expect(await decisionOf(earlier.id)).toMatchObject({ state: 'given', basis: 'goodwill', judgedTurns: [4] });
        // Nothing recorded: the person's; the row that arrives later for the turn it ended on gives it back
        const none = await job(sara, { outcome: 'failed' });
        expect(await decisionOf(none.id)).toMatchObject({ state: 'refused', basis: 'agent_ended', judgedTurns: [] });
        await recordFaults(sara.brickId, none.id, [row401(1)]);
        await afterLateEvidence(none.id);
        expect(await decisionOf(none.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(none.id)).toBe(true);
      });

      it('the agent ending on its own with nothing recorded is the person’s and never counted; an unresolved row on a judged turn is bounded goodwill, counted; a turn with no row is not unresolved', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        const quiet = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1, 2] });
        expect(await decisionOf(quiet.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        expect(await charged(quiet.id)).toBe(true);
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: quiet.id } })).runnerFault).toBe(false);
        // A row on turn 1 only: turn 2 has none, which says nothing wrong happened there
        const goodwill = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1, 2] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decisionOf(goodwill.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'provider_5xx' });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: goodwill.id } })).toMatchObject({ endedBy: 'error', runnerFault: true });
        // The bound is spent: the next unresolved one under a hint is refused for it, like any
        const capped = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decisionOf(capped.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        // ...but a confirmed fault of ours is given back even then, uncounted, whatever the hint
        const confirmed = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [row401(1)]));
        expect(await decisionOf(confirmed.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: confirmed.id } })).runnerFault).toBe(false);
        // A person's own evidence under a hint is the person's
        const theirs = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'allowance')]));
        expect(await decisionOf(theirs.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
      });

      it('a confirmed fault of ours is given back when an App delivered, and the App’s own charge is not touched; a completed give-back is never taken back', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        let appRunId = '';
        const delivered = await job(sara, { outcome: 'failed', cause: 'agent', turns: [2] }, async (id) => {
          // The App that delivered was charged on its own run before the give-back: Instant's own record of it, and the books' line for it
          const appRun = await prisma.instantRun.create({
            data: { runKey: `k-${randomUUID()}`, botId: sara.brickId, personId: sara.id, taskKey: id, toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000), providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
          });
          appRunId = appRun.id;
          await prisma.meterEvent.create({
            data: { eventId: `instant:${appRun.id}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(7_000), basis: 'measured', detail: { instant: true, taskKey: id, runId: appRun.id, app: 'gmail', customerMicros: 9_000 } } as never,
          });
          await planEffect(id, { key: 'mail-1', kind: 'send' });
          await settleEffect(id, 'mail-1', 'done', 'ali@example.test');
          await recordFaults(sara.brickId, id, [row401(2)]);
        });
        expect(await decisionOf(delivered.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(delivered.id)).toBe(true);
        expect(await prisma.computerEffect.count({ where: { jobId: delivered.id, state: 'done' } })).toBe(1);
        // The App's own charge is untouched by the give-back of the computer
        const appCharge = async () => ({ run: await prisma.instantRun.findUniqueOrThrow({ where: { id: appRunId } }), event: await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${appRunId}` } }) });
        expect((await appCharge()).run).toMatchObject({ state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000) });
        expect((await appCharge()).event).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
        // Nothing that arrives later takes it back
        await recordFaults(sara.brickId, delivered.id, [fault(2, 'allowance', { callId: 'late-person' }), fault(2, 'provider_5xx', { callId: 'late-unresolved' })]);
        await afterLateEvidence(delivered.id);
        await sweepLateEvidence(minutes(40));
        expect(await decisionOf(delivered.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(delivered.id)).toBe(true);
        expect((await appCharge()).run).toMatchObject({ customerState: 'charged', customerMicros: BigInt(9_000) });
        expect((await appCharge()).event).toMatchObject({ personKey: `person:${sara.id}` });
      });

      it('an incident operations establishes gives back a job the runner called the agent’s own and nothing recorded (a provider row arrived late on its judged turn); one with person evidence is left alone', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const route = 'universe-ai/model-hint-incident';
        const ended = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1, 2] });
        const theirs = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'allowance', { route })]));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        // A late unresolved row on its judged turn is judged as on time: bounded goodwill, counted...
        await recordFaults(sara.brickId, ended.id, [fault(2, 'provider_5xx', { route })]);
        await afterLateEvidence(ended.id);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
        // ...and operations, once they establish that the incident on that route caused the failure, free it from the person's bound
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 0, uncounted: 1 });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'incident' });
        expect(await givenBack(ended.id)).toBe(true);
        expect(await decisionOf(theirs.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
        expect(await givenBack(theirs.id)).toBe(false);
      });

      it('a late fault of ours decides a PENDING decision too (held for an outside effect), under a hint', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const held = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-2', kind: 'send' });
        });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved', causeHint: 'agent' });
        await recordFaults(sara.brickId, held.id, [row401(1)]);
        await afterLateEvidence(held.id);
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(held.id)).toBe(true);
      });
    });

    it('a job our own pool cut off mid-run is OUR ending: kept as `pool`, given back in full, uncounted, with an orbit_fault decision that says why (a call refused for the same cause is pool_busy, ours)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Cut off' }, minutes(0));
      if (!started.ok) throw new Error('no');
      const id = started.job.id;
      // The pool has no room for what the job asks to go on
      await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      expect(await renewJob(id, minutes(5))).toEqual({ ok: false, reason: 'pool' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false });
      expect(await decisionOf(id)).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off', causeHint: null });
      expect(await givenBack(id)).toBe(true);
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBe(1);
      // It used none of the person's bound: their next unresolved failure still gets goodwill
      await setUp();
      const next = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(next.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    });

    it('records the endings Orbit saw itself as decisions, always given and never counted', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const lapsing = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Lapsing' }, minutes(100));
      if (!lapsing.ok) throw new Error('no');
      await sweepComputers(minutes(200));
      expect(await decisionOf(lapsing.job.id)).toMatchObject({ state: 'given', basis: 'orbit_fault' });
    });
  });

  describe('unresolved evidence that arrives after the finish is judged as it would have been on time (GPT round 3, finding 1: the same outage, the same bound, the same job, a different payer by arrival order)', () => {
    // A generic 500 on the person's OWN model provider for the named turn: unresolved evidence, so goodwill decides
    const own500 = (turn = 1) => fault(turn, 'provider_5xx', { source: 'own-key', run: 'r1' });
    const agentEnding = { outcome: 'failed' as const, cause: 'agent' as const, turns: [1], run: 'r1' };
    /** The person's bound is used up for the month by an earlier job that was given back as goodwill (the same earlier job for both people of a comparison). */
    const usedUp = async (p: { id: string; brickId: string }, origin: Date = MIDMONTH) => {
      const earlier = await job(p, { outcome: 'failed', cause: 'agent', turns: [1], run: 'r0' }, withFaults(p, [fault(1, 'provider_5xx', { run: 'r0' })]), origin);
      expect(await decisionOf(earlier.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    };
    const delivered = (id: string) => planEffect(id, { key: 'mail-1', kind: 'send' }).then(() => settleEffect(id, 'mail-1', 'done', 'ali@example.test')).then(() => undefined);
    const verdictOf = async (jobId: string) => {
      const row = await prisma.computerGiveBackDecision.findUniqueOrThrow({ where: { jobId } });
      const one = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      return { state: row.state, basis: row.basis, reason: row.reason, route: row.route, judgedTurns: row.judgedTurns, judgedRun: row.judgedRun, endedBy: one.endedBy, runnerFault: one.runnerFault, givenBack: await givenBack(jobId) };
    };
    /** The same job twice for two people: once with the row on time, once with the row after the finish (told to Orbit the way the route does: the late look). */
    const bothOrders = async (before: (p: { id: string; brickId: string }) => Promise<void>, step?: (jobId: string) => Promise<void>) => {
      // One fixed mid-month origin for every job of the comparison (a bound is per calendar month: a run across midnight of the month's last day would split them)
      const early = await person('early');
      const late = await person('late');
      await before(early);
      await before(late);
      const onTime = await job(early, agentEnding, async (id) => {
        await step?.(id);
        await recordFaults(early.brickId, id, [own500()]);
      }, MIDMONTH);
      const after = await job(late, agentEnding, async (id) => {
        await step?.(id);
      }, MIDMONTH);
      // No evidence yet: the agent ended on its own
      expect(await decisionOf(after.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      await recordFaults(late.brickId, after.id, [own500()]);
      await afterLateEvidence(after.id);
      return { onTime: await verdictOf(onTime.id), late: await verdictOf(after.id), lateId: after.id, latePerson: late };
    };

    it('goodwill available: the late row gives the computer time back as goodwill, counted, exactly as on time ($0.03 of five minutes)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const { onTime, late } = await bothOrders(async () => undefined);
      expect(onTime).toMatchObject({ state: 'given', basis: 'goodwill', endedBy: 'error', runnerFault: true, givenBack: true });
      expect(late).toEqual(onTime);
    });

    it('goodwill exhausted: refused for the cap in both orders, and the person is charged in both', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const { onTime, late } = await bothOrders(usedUp);
      expect(onTime).toMatchObject({ state: 'refused', basis: 'cap', givenBack: false });
      expect(late).toEqual(onTime);
    });

    it('a verified delivery: refused as delivered in both orders (unresolved evidence never gives back what an App delivered)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const { onTime, late } = await bothOrders(async () => undefined, delivered);
      expect(onTime).toMatchObject({ state: 'refused', basis: 'delivered', givenBack: false });
      expect(late).toEqual(onTime);
    });

    it('an effect still to be confirmed: held pending in both orders, the person charged provisionally, and the sweep decides it as it decides the on-time one', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const { onTime, late, lateId } = await bothOrders(async () => undefined, (id) => planEffect(id, { key: 'mail-1', kind: 'send' }).then(() => undefined));
      expect(onTime).toMatchObject({ state: 'pending', basis: 'effect_unresolved', givenBack: false });
      expect(late).toEqual(onTime);
      // The effect is never confirmed: after the wait the decision closes by the goodwill rules, and a late one reaches the same end
      await resolveDecision(lateId, new Date(Date.now() + 365 * 24 * 3_600_000));
      expect((await verdictOf(lateId)).state).toBe('given');
    });

    it('the person’s own evidence that arrives late is still theirs, and an unresolved row for a turn nobody judged changes nothing', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const theirs = await job(sara, agentEnding);
      await recordFaults(sara.brickId, theirs.id, [fault(1, 'allowance', { run: 'r1' })]);
      await afterLateEvidence(theirs.id);
      expect(await decisionOf(theirs.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
      expect(await givenBack(theirs.id)).toBe(false);
      const other = await job(sara, agentEnding);
      await recordFaults(sara.brickId, other.id, [own500(7)]);
      await afterLateEvidence(other.id);
      expect(await decisionOf(other.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await givenBack(other.id)).toBe(false);
    });

    it('the bound is read for the month the job ENDED in, whenever the late row arrives; the person’s lock is taken; saying it twice gives back once', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const october = new Date('2026-10-14T09:00:00Z');
      const used = await person('oct-used');
      const fresh = await person('oct-fresh');
      // Both jobs ended in October. The first person used October's bound already; the second had not (and has used none since)
      await usedUp(used, october);
      const capped = await job(used, agentEnding, undefined, october);
      const free = await job(fresh, agentEnding, undefined, october);
      // The late rows arrive now, in November: October's bound is the one that counts
      await recordFaults(used.brickId, capped.id, [own500()]);
      await recordFaults(fresh.brickId, free.id, [own500()]);
      await afterLateEvidence(capped.id);
      await afterLateEvidence(free.id);
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await decisionOf(free.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      // Said again (the route and the sweep both look): nothing changes and nothing is given back twice
      await afterLateEvidence(free.id);
      await sweepLateEvidence(new Date());
      expect(await decisionOf(free.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      expect(await prisma.computerJob.count({ where: { personId: fresh.id, runnerFault: true } })).toBe(1);
      expect(await givenBack(free.id)).toBe(true);
      // The look took the person's give-back lock: it waits for another holder of it
      const waiting = await job(fresh, agentEnding, undefined, october);
      await recordFaults(fresh.brickId, waiting.id, [own500()]);
      let finished = false;
      let look: Promise<void> = Promise.resolve();
      let fixtureError: { error: unknown } | null = null;
      const fixture = async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
        await lockPerson(tx, fresh.id);
        // The lock this fixture holds, read from its own granted row in the lock table, and the fixture's own backend
        const mine = (await tx.$queryRaw<Array<{ pid: number; classid: number; objid: number; objsubid: number }>>`
          SELECT pg_backend_pid() AS pid, classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)[0];
        look = afterLateEvidence(waiting.id).finally(() => {
          finished = true;
        });
        look.catch(() => undefined);
        // A backend OTHER than the fixture's is waiting for that very lock (a barrier on the database's own lock table, no timer), never past the look finishing (it would have gone round the lock)
        const waitingBackends = async () =>
          (await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::int = ${mine.classid} AND objid::int = ${mine.objid} AND objsubid::int = ${mine.objsubid} AND pid <> ${mine.pid}`)[0].n;
        const deadline = Date.now() + 5_000;
        while (!finished && (await waitingBackends()) === 0) {
          if (Date.now() > deadline) throw new Error('the late look never waited for the person’s lock');
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(finished).toBe(false);
      };
      try {
        await prisma.$transaction(fixture, HOLDER);
      } catch (error) {
        fixtureError = { error };
      }
      // The lock is released (the fixture's transaction is over, committed or rolled back): the look can finish, and it is always awaited, so none is left dangling whatever happened above
      await look;
      if (fixtureError) throw (fixtureError as { error: unknown }).error;
      expect(finished).toBe(true);
    });

    it('a late row found by the sweep (not the route) gives the same answer', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const ended = await job(sara, agentEnding);
      await recordFaults(sara.brickId, ended.id, [own500()]);
      await sweepLateEvidence(new Date());
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      expect(await givenBack(ended.id)).toBe(true);
    });
  });

  describe('a computer that could not reach our own model relay (dev staging: a relay address that answered a page that was not the relay)', () => {
    const readied = async (jobId: string) => {
      await mintJobToken(jobId, 'model', NOW);
    };
    const item = async (personId: string, jobId: string) => (await activityFor(personId)).find((one) => one.id === `act_job_${jobId}`);

    it('is a confirmed fault of ours whatever the runner said, given back at the cap too and never counted, with the money, the receipt and the report all saying so', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // The bound is used: one unresolved failure was given back as goodwill, and the next one is refused for the cap (what a job nobody could prove was ours gets)
      const used = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(used.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      const capped = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await givenBack(capped.id)).toBe(false);
      // The relay could not be reached: said at prepare (a run), under each thing the runner may say at the finish
      const unreachable = async (ending: { outcome: 'failed'; cause?: 'ours' | 'agent'; turns?: number[]; run?: string }) =>
        job(sara, ending, async (jobId) => {
          await readied(jobId);
          await recordRelayUnreachable(prisma, jobId, { run: ending.run ?? null, status: 404 });
        });
      const said = [await unreachable({ outcome: 'failed', cause: 'agent', run: 'r1' }), await unreachable({ outcome: 'failed', cause: 'ours', turns: [1, 2], run: 'r1' }), await unreachable({ outcome: 'failed', run: 'r1' }), await unreachable({ outcome: 'failed', cause: 'ours' })];
      for (const one of said) {
        expect(await decisionOf(one.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        // The money: the time written against nobody, and the job takes none of the person's bound
        expect(await givenBack(one.id)).toBe(true);
        expect(one.runnerFault).toBe(false);
      }
      // The bound is exactly as it was: one used, and the next unresolved failure is still refused for it
      const after = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(after.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      // The receipt: in the words of the approved sentence, as a job that came back to the person
      const seen = await item(sara.id, said[0].id);
      expect(seen?.outcomeNote).toContain(UNREACHABLE_WORDS);
      expect(seen?.outcomeNote).not.toContain('It didn’t finish.');
      expect((await item(sara.id, capped.id))?.outcomeNote).not.toContain(UNREACHABLE_WORDS);
      // The report the person is told in chat: the same sentence, never the computer's own words about a model that never answered
      const told = (await reportsToTell(50, minutes(60 * 24))).filter((report) => report.kind === 'failed');
      expect(told.find((report) => report.jobId === said[0].id)).toMatchObject({ givenBack: true, why: UNREACHABLE_WORDS });
      expect(told.find((report) => report.jobId === capped.id)?.why).not.toBe(UNREACHABLE_WORDS);
    });

    it('the relay’s own row for the same thing (relay_down, no route) beside Orbit’s: one give-back, named by Orbit’s reason; the relay’s row alone is given back as it always was', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const both = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { run: 'r1', route: 'unknown' })]);
        await recordRelayUnreachable(prisma, jobId, { run: 'r1' });
      });
      expect(await decisionOf(both.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      expect((await item(sara.id, both.id))?.outcomeNote).toContain(UNREACHABLE_WORDS);
      const relayOnly = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, withFaults(sara, [fault(1, 'relay_down', { run: 'r1', route: 'unknown' })]));
      expect(await decisionOf(relayOnly.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_down' });
      expect(await givenBack(relayOnly.id)).toBe(true);
      expect(relayOnly.runnerFault).toBe(false);
    });

    it('the runner’s own row of it (relay_down under its marker call id: its prepare could not, or no call reached the relay) names the same reason and the approved words; the relay’s own relay_down 503 does not (dev staging journey d)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // The shapes the runner writes: a marker for a prepare that could not reach the relay, and a turn in which no call reached it (route `unknown`, the relay's word `fault`)
      const markers = [
        { callId: 'relay_unreachable_r1_1', ending: { outcome: 'failed' as const, cause: 'ours' as const, turns: [1], run: 'r1' } },
        { callId: 'no_call_r1_1', ending: { outcome: 'failed' as const, cause: 'ours' as const, turns: [1], run: 'r1' } },
        // The runner named no turn and the hint was its own: the row with no turn is still the finding
        { callId: 'relay_unreachable_r1_0', ending: { outcome: 'failed' as const, cause: 'agent' as const, run: 'r1' } },
      ];
      for (const { callId, ending } of markers) {
        const one = await job(sara, ending, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [fault(ending.turns ? 1 : null, 'relay_down', { callId, run: 'r1', route: 'unknown' })]);
        });
        expect(await decisionOf(one.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable', route: null });
        // The money and the count are those of any fault of ours: given back, nothing counted against the person's bound
        expect(await givenBack(one.id)).toBe(true);
        expect(one.runnerFault).toBe(false);
        expect((await item(sara.id, one.id))?.outcomeNote).toContain(UNREACHABLE_WORDS);
      }
      // The relay's own relay_down (its 503 "service busy": the computer DID reach it) is under a real call's id: it keeps its reason and gets no such sentence
      const busy = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { callId: 'call-4f1e', run: 'r1', route: 'unknown', providerStatus: 503 })]);
      });
      expect(await decisionOf(busy.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_down' });
      expect(await givenBack(busy.id)).toBe(true);
      expect((await item(sara.id, busy.id))?.outcomeNote ?? '').not.toContain(UNREACHABLE_WORDS);
      // A marker id on a row that is not the relay's word `fault` is no finding of ours at all
      const unsure = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { callId: 'no_call_r1_1', kind: 'uncertain', run: 'r1' })]);
      });
      expect((await decisionOf(unsure.id))?.reason).not.toBe('relay_unreachable');
    });

    it('the runner’s marker row that arrives after the finish names the same reason as on time, past the cap', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      const rowed = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'stream_cut', { run: 'r1' })]);
      });
      expect(await decisionOf(rowed.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      await recordFaults(sara.brickId, rowed.id, [fault(null, 'relay_down', { callId: 'relay_unreachable_r1_0', run: 'r1', route: 'unknown' })]);
      await afterLateEvidence(rowed.id);
      expect(await decisionOf(rowed.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable', route: null });
      expect(await givenBack(rowed.id)).toBe(true);
      expect((await item(sara.id, rowed.id))?.outcomeNote).toContain(UNREACHABLE_WORDS);
    });

    it('a row that says so and arrives after the finish gives the job back the same way, past the cap', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      // The finish had a row of another kind on record (so it was not read as "no call at all"), and the bound is used: refused for the cap
      const rowed = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'stream_cut', { run: 'r1' })]);
      });
      expect(await decisionOf(rowed.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      // The runner's word that the relay could not be reached reaches Orbit late: the same decision as on time
      await recordRelayUnreachable(prisma, rowed.id, { run: 'r1' });
      await afterLateEvidence(rowed.id);
      expect(await decisionOf(rowed.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      expect(await givenBack(rowed.id)).toBe(true);
    });

    it('a failed finish with the computer readied and not one trace of a call is the same fault, kept as a row; any trace of a call, or a computer never readied, is judged as ever', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // Readied, nothing at all: ours, and Orbit keeps the fault row itself (so it is found again by every later reading)
      const silent = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
      expect(await decisionOf(silent.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      expect(await givenBack(silent.id)).toBe(true);
      expect(await prisma.computerJobFault.findMany({ where: { jobId: silent.id } })).toMatchObject([{ kind: 'fault', reason: 'relay_unreachable', run: 'r1', turn: null, route: null }]);
      // The runner named turns and said ours, and no turn has a row: the same
      const named = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1, 2], run: 'r1' }, readied);
      expect(await decisionOf(named.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      // Never readied (no key was ever made): nothing says the model was meant to be reached, so it is the agent's ending as before
      const never = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' });
      expect(await decisionOf(never.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await prisma.computerJobFault.count({ where: { jobId: never.id } })).toBe(0);
      // Any trace of a call is a call that reached us: an answered row, a row of any fault, a priced call or a room held for one
      const answered = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { kind: 'answered', run: 'r1' })]);
      });
      expect(await decisionOf(answered.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      const unresolved = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, async (jobId) => {
        await readied(jobId);
        await recordFaults(sara.brickId, jobId, [fault(1, 'provider_5xx')]);
      });
      expect(await decisionOf(unresolved.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      const roomHeld = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW);
      });
      expect(await decisionOf(roomHeld.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      const priced = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1, payer: 'own-key' }, NOW);
        await settleModelCall(jobId, 'c1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
      });
      expect(await decisionOf(priced.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
    });

    it('a call on the person’s own key that was authorized and whose report is not here yet is a call that was asked: a failed finish that comes first is never read as "no call at all", and a late row of theirs still decides it', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // Authorized on the person's own key (no room, no price, no row yet), then the failed finish arrives before the call's report
      const early = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await readied(jobId);
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        expect(await authorizeModelCall({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
        // Asked again (a retry): the same marker, not another
        await authorizeModelCall({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
        await authorizeModelCall({ token, callId: 'k2', estimateMicros: 1, payer: 'own-key' }, NOW);
      });
      expect(await decisionOf(early.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await givenBack(early.id)).toBe(false);
      // No fault of ours was written for it, and the one marker says nothing about any failure
      const rows = await prisma.computerJobFault.findMany({ where: { jobId: early.id } });
      // The marker and the admission for the call's turn (the relay named none): both answered rows of Orbit's own, neither says anything about a failure
      expect(rows.map((row) => ({ kind: row.kind, reason: row.reason, source: row.source, turn: row.turn, route: row.route })).sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
        { kind: 'answered', reason: 'own_key_call', source: 'orbit', turn: null, route: null },
        { kind: 'answered', reason: 'turn_admitted', source: 'orbit', turn: null, route: null },
      ]);
      expect(await readFaultRows(prisma, early.id, null, 'r1')).toEqual([]);
      // The call's own report arrives late and says it was their provider refusing their key: theirs, as ever (never given back as ours)
      await recordFaults(sara.brickId, early.id, [fault(1, 'own_provider', { source: 'own-key', route: 'own-key', run: 'r1' })]);
      await afterLateEvidence(early.id);
      expect(await givenBack(early.id)).toBe(false);
      expect(await decisionOf(early.id)).not.toMatchObject({ basis: 'universe_fault' });
    });

    it('a job whose control changed hands before any call (the person took the machine, or gave it back) is never read as "no call reached the relay": its keys ended, a later call was refused and left no row, and that is the takeover, not the relay', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // What taking the machine does (fenceControl): the control generation goes up and the agent's keys end; a call with the old key is then refused and leaves nothing
      const tookOver = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: { increment: 1 } } });
        await revokeJobTokens(jobId, NOW);
        expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'refused' });
      });
      expect(await decisionOf(tookOver.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await givenBack(tookOver.id)).toBe(false);
      expect(await prisma.computerJobFault.count({ where: { jobId: tookOver.id } })).toBe(0);
      // Given back to the agent, and taken again: the generation only goes up
      const backAgain = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await mintJobToken(jobId, 'model', NOW);
        await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 2 } });
      });
      expect(await decisionOf(backAgain.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      // The person holds the machine at the moment it fails
      const holding = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
        await mintJobToken(jobId, 'model', NOW);
        await prisma.computerJob.update({ where: { id: jobId }, data: { control: 'person', status: 'waiting', waitingFor: 'signin' } });
      });
      expect(await decisionOf(holding.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      // The same job that never changed hands, readied and never asked, is still the relay's
      const untouched = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
      expect(await decisionOf(untouched.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
    });

    describe('GPT round 3, finding 5: the relay says it was reached (the arrival row: answered / relay_reached, one per run and turn)', () => {
      const arrival = (run: string | null, turn: number | null): FaultInput => ({ turn, run, callId: `arrival_${run ?? ''}_${turn ?? ''}`, kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: new Date() });
      const inferredRows = (jobId: string) => prisma.computerJobFault.findMany({ where: { jobId, reason: 'relay_unreachable' }, select: { callId: true, run: true, kind: true } });

      it('a run with an arrival row is NEVER inferred unreachable from the absence of other rows: judged like any failed job; the genuine outage (no arrival) keeps its refund and its words', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        // The relay authenticated the run's key (a body it could not read, say) and nothing else is held for it
        const reached = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(reached.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        expect(await givenBack(reached.id)).toBe(false);
        expect(await inferredRows(reached.id)).toEqual([]);
        const seen = await item(sara.id, reached.id);
        expect(seen?.outcomeNote ?? '').not.toContain(UNREACHABLE_WORDS);
        expect(seen?.outcomeNote ?? '').not.toContain(REACHED_WORDS);
        // The arrival row is never a fault, and no hint can turn it into one: the runner naming a turn without a row is unresolved and goodwill, as for any failed job
        const named = await job(sara, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(named.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'no_row' });
        // No arrival at all, the same readied job: the genuine outage, as before, with its row and its words
        const outage = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        expect(await givenBack(outage.id)).toBe(true);
        expect((await item(sara.id, outage.id))?.outcomeNote).toContain(UNREACHABLE_WORDS);
        expect(await inferredRows(outage.id)).toMatchObject([{ kind: 'fault', run: 'r1' }]);
      });

      it('is scoped per RUN: an arrival of r1 never suppresses the inference for r2, and one that names no run counts for every run', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const other = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r2' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(other.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        const unnamed = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r2' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival(null, null)]);
        });
        expect(await decisionOf(unnamed.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        // An arrival whose source is not the relay's is no arrival
        const forged = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [{ ...arrival('r1', 1), source: 'own-key' }]);
        });
        expect(await decisionOf(forged.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      });

      it('CodeRabbit A: a finish the runner called ours, with a run and no turn, KEEPS the run it reported: a later arrival of another run never re-labels it, one of its own run does (the all-runs reading of the rows is a separate matter)', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        for (const way of ['route', 'sweep'] as const) {
          const outage = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, readied);
          expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable', causeHint: 'ours', judgedTurns: [], judgedRun: 'r2' });
          const look = () => (way === 'route' ? afterLateEvidence(outage.id) : sweepLateEvidence(new Date()).then(() => undefined));
          // r1 reached the relay: that says nothing of r2
          await recordFaults(sara.brickId, outage.id, [arrival('r1', 1)]);
          await afterArrival(outage.id);
          await look();
          expect((await decisionOf(outage.id))?.reason).toBe('relay_unreachable');
          // r2 reached it: only the reason moves
          await recordFaults(sara.brickId, outage.id, [arrival('r2', 1)]);
          await look();
          // The look itself moved the reason (checked BEFORE afterArrival runs, which could do it too and hide a look that did not); afterArrival then changes nothing (CodeRabbit 13)
          expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
          await afterArrival(outage.id);
          expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
          expect(await givenBack(outage.id)).toBe(true);
        }
        // The rows are still read on every run when no turn was named: a fault of ours of ANOTHER run is part of what a finish that named no turn judges
        const mixed = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [fault(1, 'provider_key_ours', { run: 'r1' })]);
        });
        expect(await decisionOf(mixed.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'provider_key_ours', judgedRun: 'r2' });
      });

      it('Opus on A: a finish scoped to r2 is never kept from the inference by an arrival of r1 (at the finish and on a later look); r2’s own arrival stops it; a finish that knows NO run counts only arrivals that name no run', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const moneyOf = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } });
        // hint ours, no turns, run r2, only an r1 arrival: the outage is inferred and given back
        const onlyR1 = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(onlyR1.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable', judgedRun: 'r2' });
        expect(await inferredRows(onlyR1.id)).toMatchObject([{ kind: 'fault', run: 'r2' }]);
        const money = await moneyOf(onlyR1.id);
        // A later look (route and sweep) keeps it exactly as it is
        await afterLateEvidence(onlyR1.id);
        await sweepLateEvidence(new Date());
        expect(await decisionOf(onlyR1.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        expect(await moneyOf(onlyR1.id)).toEqual(money);
        // the same finish with an arrival of r2: never inferred (no inferred row, no outage reason)
        const ownArrival = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r2', 1)]);
        });
        expect((await decisionOf(ownArrival.id))?.reason).not.toBe('relay_unreachable');
        expect(await inferredRows(ownArrival.id)).toEqual([]);
        // No run known at all (an older runner): another run's arrival never counts (what is not known favours the person); an arrival that names no run does
        const unknownR1 = await job(sara, { outcome: 'failed', cause: 'ours' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(unknownR1.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable', judgedRun: null });
        const unknownNone = await job(sara, { outcome: 'failed', cause: 'ours' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival(null, 1)]);
        });
        expect((await decisionOf(unknownNone.id))?.reason).not.toBe('relay_unreachable');
        expect(await inferredRows(unknownNone.id)).toEqual([]);
        // The same on a later look: r1's arrival never re-labels the decision of a finish that knew no run
        await recordFaults(sara.brickId, unknownR1.id, [arrival('r1', 2)]);
        await afterArrival(unknownR1.id);
        expect((await decisionOf(unknownR1.id))?.reason).toBe('relay_unreachable');
      });

      it('Opus on B: an arrival that was stored just before the decision committed (inside the margin), after Orbit inferred the outage, is found by the sweep: the reason becomes relay_reached and the wallet does not move', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const outage = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        const money = await prisma.meterEvent.findMany({ where: { jobId: outage.id }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } });
        const decided = (await decisionOf(outage.id))?.updatedAt as Date;
        // The write began before the decision committed and finished just after: its row is stamped one minute BEFORE the decision's last change, and no route ever looked at it
        await prisma.computerJobFault.create({ data: { jobId: outage.id, turn: 1, run: 'r1', callId: 'arrival_r1_1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: decided, createdAt: new Date(decided.getTime() - 60_000) } });
        expect((await decisionOf(outage.id))?.reason).toBe('relay_unreachable');
        expect((await sweepLateEvidence(new Date())).looked).toBeGreaterThanOrEqual(1);
        expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
        expect(await prisma.meterEvent.findMany({ where: { jobId: outage.id }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } })).toEqual(money);
        expect(await givenBack(outage.id)).toBe(true);
      });

      it('CodeRabbit B: the finish’s inference that the relay was never reached and the arrival row’s write are serialized by one lock: an arrival that commits while the finish waits is SEEN, and a run with no arrival still gets its give-back', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        /** Holds the arrival writers' lock in a transaction, starts the finish of a ready job, proves the finish is WAITING for that lock (a barrier on the lock table, no timer), then runs `inside` and commits. */
        const finishAgainstLock = async (inside: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], jobId: string) => Promise<void>) => {
          const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(clock));
          if (!started.ok) throw new Error('the job did not start');
          const jobId = started.job.id;
          await readied(jobId);
          let finish: Promise<unknown> = Promise.resolve();
          let finished = false;
          let fixtureError: { error: unknown } | null = null;
          try {
            await prisma.$transaction(async (tx) => {
              await lockRelayReach(tx, jobId);
              const mine = (await tx.$queryRaw<Array<{ pid: number; classid: number; objid: number; objsubid: number }>>`
                SELECT pg_backend_pid() AS pid, classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)[0];
              finish = finishJob(jobId, 'failed', minutes(clock + 5), null, 'agent', undefined, 'r1').finally(() => {
                finished = true;
              });
              finish.catch(() => undefined);
              const waiting = async () =>
                (await prisma.$queryRaw<Array<{ n: number }>>`
                  SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::int = ${mine.classid} AND objid::int = ${mine.objid} AND objsubid::int = ${mine.objsubid} AND pid <> ${mine.pid}`)[0].n;
              const deadline = Date.now() + 5_000;
              while (!finished && (await waiting()) === 0) {
                if (Date.now() > deadline) throw new Error('the finish never waited for the arrival writers’ lock');
                await new Promise((resolve) => setImmediate(resolve));
              }
              expect(finished).toBe(false);
              await inside(tx, jobId);
            }, HOLDER);
          } catch (error) {
            fixtureError = { error };
          }
          await finish;
          if (fixtureError) throw (fixtureError as { error: unknown }).error;
          clock += 10;
          return jobId;
        };
        // An arrival of run r1 commits while the finish of r1 is waiting: it is seen, and no outage is inferred (judged like any failed job: the agent ended on its own)
        const arrived = await finishAgainstLock(async (tx, jobId) => {
          await tx.computerJobFault.create({ data: { jobId, turn: 1, run: 'r1', callId: 'arrival_r1_1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: new Date() } });
        });
        expect(await decisionOf(arrived)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        expect(await givenBack(arrived)).toBe(false);
        expect(await inferredRows(arrived)).toEqual([]);
        // No arrival ever comes: the genuine outage still gets its give-back, once the lock is free
        const outage = await finishAgainstLock(async () => undefined);
        expect(await decisionOf(outage)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        expect(await givenBack(outage)).toBe(true);
        // And the arrival's own write (recordFaults) takes that lock: it waits for a holder of it
        const sample = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        let wrote: Promise<unknown> = Promise.resolve();
        let wroteDone = false;
        let writeError: { error: unknown } | null = null;
        try {
          await prisma.$transaction(async (tx) => {
            await lockRelayReach(tx, sample.id);
            const mine = (await tx.$queryRaw<Array<{ pid: number; classid: number; objid: number; objsubid: number }>>`
              SELECT pg_backend_pid() AS pid, classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)[0];
            wrote = recordFaults(sara.brickId, sample.id, [arrival('r1', 1)]).finally(() => {
              wroteDone = true;
            });
            wrote.catch(() => undefined);
            const deadline = Date.now() + 5_000;
            for (;;) {
              const n = (await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::int = ${mine.classid} AND objid::int = ${mine.objid} AND objsubid::int = ${mine.objsubid} AND pid <> ${mine.pid}`)[0].n;
              if (wroteDone || n > 0) break;
              if (Date.now() > deadline) throw new Error('the arrival write never waited for the lock');
              await new Promise((resolve) => setImmediate(resolve));
            }
            expect(wroteDone).toBe(false);
          }, HOLDER);
        } catch (error) {
          writeError = { error };
        }
        await wrote;
        if (writeError) throw (writeError as { error: unknown }).error;
        expect(await prisma.computerJobFault.count({ where: { jobId: sample.id, reason: 'relay_reached' } })).toBe(1);
      });

      /** Holds the relay-reach lock of a job in a transaction (with a timeout longer than the wait below), starts `start`, proves it is WAITING for that lock (a barrier on the lock table, no timer), then runs `inside` and commits. */
      const whileHoldingRelayReach = async <T,>(jobId: string, start: () => Promise<T>, inside: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void> = async () => undefined): Promise<T> => {
        let started: Promise<T> | null = null;
        let finished = false;
        let fixtureError: { error: unknown } | null = null;
        try {
          await prisma.$transaction(async (tx) => {
            await lockRelayReach(tx, jobId);
            const mine = (await tx.$queryRaw<Array<{ pid: number; classid: number; objid: number; objsubid: number }>>`
              SELECT pg_backend_pid() AS pid, classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)[0];
            started = start().finally(() => {
              finished = true;
            });
            started.catch(() => undefined);
            const deadline = Date.now() + 5_000;
            for (;;) {
              const n = (await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::int = ${mine.classid} AND objid::int = ${mine.objid} AND objsubid::int = ${mine.objsubid} AND pid <> ${mine.pid}`)[0].n;
              if (finished || n > 0) break;
              if (Date.now() > deadline) throw new Error('the writer never waited for the relay-reach lock');
              await new Promise((resolve) => setImmediate(resolve));
            }
            expect(finished).toBe(false);
            await inside(tx);
          }, HOLDER);
        } catch (error) {
          fixtureError = { error };
        }
        // Always joined, whatever went wrong above (and a failure here never hides that one)
        const result = started ? await (started as Promise<T>).then((value) => ({ value }), (error) => ({ error })) : null;
        if (fixtureError) throw (fixtureError as { error: unknown }).error;
        if (!result) throw new Error('the writer was never started');
        if ('error' in result) throw result.error;
        return result.value;
      };

      it('CodeRabbit 9: a runless arrival under a turn-only call id ("turn:1") takes the same lock as every arrival, and shares the unnamed-turn slots with the faults of unnamed runs: neither is lost', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const runless = (): FaultInput => ({ ...arrival(null, 1), callId: 'turn:1' });
        const sample = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        // It waits for a holder of the lock, and is kept once the lock is free
        expect(await whileHoldingRelayReach(sample.id, () => recordFaults(sara.brickId, sample.id, [runless()]))).toEqual({ stored: 1, conflicts: 0 });
        expect(await prisma.computerJobFault.count({ where: { jobId: sample.id, reason: 'relay_reached', callId: 'turn:1' } })).toBe(1);
        // Said again: the same slot, nothing more
        expect(await recordFaults(sara.brickId, sample.id, [runless()])).toEqual({ stored: 0, conflicts: 0 });
        // The key `turn:1` is already held by the fault of an unnamed run: the arrival takes the next slot instead of being dropped
        const other = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await recordFaults(sara.brickId, other.id, [{ turn: 1, callId: 'turn:1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/model-a', at: new Date() }, runless()])).toEqual({ stored: 2, conflicts: 0 });
        expect((await prisma.computerJobFault.findMany({ where: { jobId: other.id, callId: { startsWith: 'turn:' } }, select: { callId: true, kind: true }, orderBy: { callId: 'asc' } })).map((row) => `${row.callId}:${row.kind}`)).toEqual(['turn:1:uncertain', 'turn:1~2:answered']);
      });

      it('CodeRabbit 10: a valid arrival for a call that is kept as an UNCERTAIN row of the same run and turn settles that row under the lock and counts as stored; another run’s or another turn’s row under that call id is a conflict and is never touched', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const sample = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        await recordFaults(sara.brickId, sample.id, [fault(1, 'provider_5xx', { run: 'r1', callId: 'arrival_r1_1' })]);
        expect(await prisma.computerJobFault.findUniqueOrThrow({ where: { jobId_callId: { jobId: sample.id, callId: 'arrival_r1_1' } } })).toMatchObject({ kind: 'uncertain', reason: 'provider_5xx' });
        // The settling waits for the lock like every arrival write
        expect(await whileHoldingRelayReach(sample.id, () => recordFaults(sara.brickId, sample.id, [arrival('r1', 1)]))).toEqual({ stored: 1, conflicts: 0 });
        expect(await prisma.computerJobFault.findUniqueOrThrow({ where: { jobId_callId: { jobId: sample.id, callId: 'arrival_r1_1' } } })).toMatchObject({ kind: 'answered', reason: 'relay_reached' });
        // Said again: nothing more
        expect(await recordFaults(sara.brickId, sample.id, [arrival('r1', 1)])).toEqual({ stored: 0, conflicts: 0 });
        // Another run's uncertain row under the same call id is not this arrival's: counted as a conflict, left as it is
        const other = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        await recordFaults(sara.brickId, other.id, [fault(1, 'provider_5xx', { run: 'r2', callId: 'arrival_r1_1' })]);
        expect(await recordFaults(sara.brickId, other.id, [arrival('r1', 1)])).toEqual({ stored: 0, conflicts: 1 });
        expect(await prisma.computerJobFault.findUniqueOrThrow({ where: { jobId_callId: { jobId: other.id, callId: 'arrival_r1_1' } } })).toMatchObject({ kind: 'uncertain', run: 'r2' });
      });

      it('CodeRabbit 11: a call on the person’s own key is authorized under the same lock as the finish’s inference, and only while the job is on: a finish that wins the lock ends the job and the call is refused, one that waits sees the marker', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        // The marker waits for the lock, and the job ended while it waited (the finish committed first): refused, no marker
        const ended = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(clock));
        if (!ended.ok) throw new Error('the job did not start');
        const authorized = await whileHoldingRelayReach(ended.job.id, () => authorizeOwnKeyCall(ended.job.id, minutes(clock)), async (tx) => {
          await tx.computerJob.update({ where: { id: ended.job.id }, data: { status: 'failed', endedAt: new Date() } });
        });
        expect(authorized).toBe(false);
        expect(await hasOwnKeyCall(prisma, ended.job.id)).toBe(false);
        // A job that is still on: kept (after waiting for the lock), and the finish that comes after reads it
        const on = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(clock + 1));
        if (!on.ok) throw new Error('the job did not start');
        expect(await whileHoldingRelayReach(on.job.id, () => authorizeOwnKeyCall(on.job.id, minutes(clock + 1)))).toBe(true);
        expect(await hasOwnKeyCall(prisma, on.job.id)).toBe(true);
        expect(await authorizeOwnKeyCall(on.job.id, minutes(clock + 2))).toBe(true);
        expect(await prisma.computerJobFault.count({ where: { jobId: on.job.id, callId: OWN_KEY_CALL_MARK } })).toBe(1);
        // A job that does not exist, or one over before the call: refused
        expect(await authorizeOwnKeyCall(randomUUID(), minutes(clock))).toBe(false);
        clock += 10;
      });

      // The sweep marks a decision as looked at with the database's clock: the mark must be the UTC time the columns hold in any session time zone, or an arrival that comes after the look looks older than the mark and is never looked at
      describe.each(['UTC', 'Asia/Kuwait'])('the late look sweep in a database set to %s', (zone) => {
        const zoneSetting = databaseTimezone(prisma, zone);
        beforeAll(zoneSetting.set, 120_000);
        afterAll(zoneSetting.restore, 120_000);

        it('an arrival that comes after an earlier sweep looked at the decision is still found by the next sweep, and re-labels the reason', async () => {
          await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
          const sara = await person('sara');
          const outage = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, readied);
          // An arrival of another run says nothing of r2: the sweep looks at the decision and marks it as looked at
          await recordFaults(sara.brickId, outage.id, [arrival('r1', 1)]);
          // A distinct, older mark is seeded, so the assertion below does not lean on the clock's resolution: the first sweep must advance THIS decision's watermark
          const seeded = new Date('2026-01-01T00:00:00Z');
          await prisma.$executeRaw`UPDATE "computer_give_back_decisions" SET "updated_at" = ${seeded} WHERE "job_id" = ${outage.id}`;
          await sweepLateEvidence(new Date());
          expect((await decisionOf(outage.id))?.reason).toBe('relay_unreachable');
          expect((await decisionOf(outage.id))?.updatedAt.getTime()).toBeGreaterThan(seeded.getTime());
          // r2 reached the relay after that look: the next sweep finds it
          await recordFaults(sara.brickId, outage.id, [arrival('r2', 1)]);
          await sweepLateEvidence(new Date());
          expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
        });
      });

      it('CodeRabbit 13: an arrival marks the decision’s reason only through afterArrival when no look ran: the reason is still the outage’s until it is called, and then it is relay_reached, once', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const outage = await job(sara, { outcome: 'failed', cause: 'ours', run: 'r2' }, readied);
        expect(await decisionOf(outage.id)).toMatchObject({ reason: 'relay_unreachable' });
        await recordFaults(sara.brickId, outage.id, [arrival('r2', 1)]);
        expect(await decisionOf(outage.id)).toMatchObject({ reason: 'relay_unreachable' });
        await afterArrival(outage.id);
        expect(await decisionOf(outage.id)).toMatchObject({ state: 'given', reason: 'relay_reached' });
        expect(await givenBack(outage.id)).toBe(true);
      });

      it('the runner’s own marker, and Orbit’s own observation at prepare, are positive evidence: an arrival of the same run never overrides them', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 5 });
        const sara = await person('sara');
        const marked = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { callId: 'relay_unreachable_r1_1', run: 'r1', route: 'unknown' }), arrival('r1', 2)]);
        });
        expect(await decisionOf(marked.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        const observed = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordRelayUnreachable(prisma, jobId, { run: 'r1', status: 404 });
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(observed.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      });

      it('an arrival row is invisible to every ruling about money: the judged turn, the classes, the late look and the late sweep are the same with an arrival on every turn as without any', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 20 });
        const sara = await person('sara');
        const verdicts = async (withArrivals: boolean, who: { id: string; brickId: string }) => {
          const rowsOf = (rows: FaultInput[]) => async (jobId: string) => {
            await readied(jobId);
            await recordFaults(who.brickId, jobId, [...rows, ...(withArrivals ? [arrival('r1', 1), arrival('r1', 2), arrival('r1', 3)] : [])]);
          };
          const out: Array<Record<string, unknown>> = [];
          // The runner names no turn: the judged turn is the last turn that has a ROW OF A FAULT (turn 1 here), never the last turn that had a call (turn 3)
          for (const [ending, rows] of [
            [{ outcome: 'failed' as const, cause: 'agent' as const, run: 'r1' }, [fault(1, 'stream_cut', { run: 'r1' })]],
            [{ outcome: 'failed' as const, cause: 'agent' as const, run: 'r1' }, [fault(1, 'allowance', { run: 'r1' })]],
            [{ outcome: 'failed' as const, cause: 'agent' as const, run: 'r1' }, [fault(1, 'relay_down', { run: 'r1' })]],
            [{ outcome: 'failed' as const, cause: 'ours' as const, turns: [1, 2, 3], run: 'r1' }, [fault(1, 'stream_cut', { run: 'r1' })]],
            [{ outcome: 'failed' as const, cause: 'agent' as const, run: 'r1' }, [fault(2, 'stream_cut', { run: 'r1' }), fault(1, 'allowance', { run: 'r1' })]],
          ] as const) {
            const ended = await job(who, { ...ending, turns: 'turns' in ending ? [...ending.turns] : undefined }, rowsOf([...rows]));
            const kept = await decisionOf(ended.id);
            out.push({ state: kept?.state, basis: kept?.basis, reason: kept?.reason, turns: kept?.judgedTurns, given: await givenBack(ended.id) });
          }
          // A failed finish with nothing but arrivals (every turn had a call, none went wrong) is the agent's own ending, as with no rows at all after a call
          const calm = await job(who, { outcome: 'failed', cause: 'agent', run: 'r1' }, rowsOf([]));
          out.push({ calm: (await decisionOf(calm.id))?.basis });
          return out;
        };
        // Two people with the same history (none), so the month's bound and pause are the same for both
        const without = await verdicts(false, sara);
        const withThem = await verdicts(true, await person('tom'));
        // With no arrival at all, the "calm" job (readied, no row of any kind) is the genuine outage; with arrivals it is the agent ending: that one entry alone differs, by the rule
        expect(withThem.slice(0, -1)).toEqual(without.slice(0, -1));
        expect(without.at(-1)).toEqual({ calm: 'universe_fault' });
        expect(withThem.at(-1)).toEqual({ calm: 'agent_ended' });
        expect(without[0]).toMatchObject({ state: 'given', basis: 'goodwill', turns: [1] });
        expect(without[1]).toMatchObject({ state: 'refused', basis: 'person_caused' });
        expect(without[2]).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });

      it('the late look and the late sweep ignore an arrival row: it never re-judges a refusal, never resolves a pending decision and never moves money; a late fault row still does', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 20 });
        const sara = await person('sara');
        const refused = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
        });
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        // More arrivals, later: the sweep has nothing to look at, and the route's look (afterArrival) changes nothing
        await recordFaults(sara.brickId, refused.id, [arrival('r1', 2), arrival('r1', 3)]);
        expect((await sweepLateEvidence(new Date())).looked).toBe(0);
        const before = await decisionOf(refused.id);
        await afterArrival(refused.id);
        expect(await decisionOf(refused.id)).toEqual(before);
        expect(await givenBack(refused.id)).toBe(false);
        // A real late row is looked at, as before (finding 1)
        await recordFaults(sara.brickId, refused.id, [fault(3, 'stream_cut', { run: 'r1' })]);
        expect((await sweepLateEvidence(new Date())).looked).toBe(1);
        expect(await decisionOf(refused.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
        // A decision still pending is not resolved by an arrival
        const pending = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1], run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [fault(1, 'stream_cut', { run: 'r1' })]);
          // An outside effect planned and not settled: the decision cannot be made yet (the fixture is made the way the job makes it, and must have been made)
          expect((await planEffect(jobId, { key: `k-${jobId}`.slice(0, 40), kind: 'send' })).ok).toBe(true);
        });
        expect(await decisionOf(pending.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        await recordFaults(sara.brickId, pending.id, [arrival('r1', 2)]);
        await afterArrival(pending.id);
        expect(await decisionOf(pending.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
      });

      it('afterArrival (what the route calls for a batch of ONLY arrival rows) re-labels an inferred relay_unreachable give-back at once with the wallet unchanged, and changes nothing on Orbit’s own prepare observation', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        const moneyOf = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } });
        // (a) Inferred from the absence of every trace: the arrival of the same run re-labels the reason, only the reason
        const inferred = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await decisionOf(inferred.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        const moneyBefore = await moneyOf(inferred.id);
        await recordFaults(sara.brickId, inferred.id, [arrival('r1', 1)]);
        await afterArrival(inferred.id);
        expect(await decisionOf(inferred.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
        expect(await moneyOf(inferred.id)).toEqual(moneyBefore);
        expect(await givenBack(inferred.id)).toBe(true);
        // Another run's arrival alone does not re-label it
        const other = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        await recordFaults(sara.brickId, other.id, [arrival('r9', 1)]);
        await afterArrival(other.id);
        expect((await decisionOf(other.id))?.reason).toBe('relay_unreachable');
        // (b) Orbit's own observation at prepare is positive evidence: nothing changes
        const observed = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordRelayUnreachable(prisma, jobId, { run: 'r1', status: 404 });
        });
        const observedMoney = await moneyOf(observed.id);
        await recordFaults(sara.brickId, observed.id, [arrival('r1', 1)]);
        await afterArrival(observed.id);
        expect(await decisionOf(observed.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        expect(await moneyOf(observed.id)).toEqual(observedMoney);
      });

      it('an inferred row Orbit kept earlier never names a reason once the run has an arrival row (judged again: by the hint, like any failed job)', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        const done = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordFaults(sara.brickId, jobId, [arrival('r1', 1)]);
          await recordRelayUnreachable(prisma, jobId, { run: 'r1', inferred: true });
        });
        // The row is there, and the arrival is there: the decision reads the arrival, not the row
        expect(await decisionOf(done.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
        expect(await inferredRows(done.id)).toHaveLength(1);
        // Without the arrival, the same row names the reason (it is Orbit's finding)
        const bare = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordRelayUnreachable(prisma, jobId, { run: 'r1', inferred: true });
        });
        expect(await decisionOf(bare.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      });

      it('an arrival row that lands AFTER Orbit inferred the outage keeps the give-back exactly as it was and only re-labels the reason: the receipt and the report stop saying "we couldn’t reach our own service"; saying it twice, and the sweep, change nothing more', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        const late = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
        expect((await item(sara.id, late.id))?.outcomeNote).toBe(UNREACHABLE_WORDS);
        const moneyBefore = await prisma.meterEvent.findMany({ where: { jobId: late.id }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } });
        const decisionBefore = await decisionOf(late.id);
        // An arrival of ANOTHER run says nothing of this one
        await recordFaults(sara.brickId, late.id, [arrival('r9', 1)]);
        await afterLateEvidence(late.id);
        expect((await decisionOf(late.id))?.reason).toBe('relay_unreachable');
        // This run's own arrival: only the reason moves
        await recordFaults(sara.brickId, late.id, [arrival('r1', 1)]);
        await afterLateEvidence(late.id);
        const after = await decisionOf(late.id);
        expect(after).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached', route: null });
        expect(after?.decidedAt).toEqual(decisionBefore?.decidedAt);
        expect(await givenBack(late.id)).toBe(true);
        expect(await prisma.meterEvent.findMany({ where: { jobId: late.id }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, costMicros: true } })).toEqual(moneyBefore);
        // Orbit's own inferred row stays as a record
        expect(await inferredRows(late.id)).toMatchObject([{ kind: 'fault', run: 'r1' }]);
        // The words: the approved sentence, never the outage
        expect((await item(sara.id, late.id))?.outcomeNote).toBe(REACHED_WORDS);
        const told = (await reportsToTell(50, minutes(60 * 24))).filter((report) => report.kind === 'failed' && report.jobId === late.id);
        // The failed report for THIS job exists (an empty list would pass `every` on its own), and it never says the outage
        expect(told).toHaveLength(1);
        expect(told.every((report) => report.why !== UNREACHABLE_WORDS)).toBe(true);
        // Again: nothing more happens (no second give-back, no count)
        await afterLateEvidence(late.id);
        expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
        expect(await prisma.meterEvent.count({ where: { jobId: late.id } })).toBe(moneyBefore.length);
        // The same by the sweep (not the route)
        const swept = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, readied);
        expect(await decisionOf(swept.id)).toMatchObject({ reason: 'relay_unreachable' });
        await recordFaults(sara.brickId, swept.id, [arrival('r1', 3)]);
        await sweepLateEvidence(new Date());
        expect(await decisionOf(swept.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_reached' });
        expect(await givenBack(swept.id)).toBe(true);
        // A positive observation (Orbit's own at prepare) is never re-labelled by a late arrival
        const seen = await job(sara, { outcome: 'failed', cause: 'agent', run: 'r1' }, async (jobId) => {
          await readied(jobId);
          await recordRelayUnreachable(prisma, jobId, { run: 'r1', status: 404 });
        });
        await recordFaults(sara.brickId, seen.id, [arrival('r1', 1)]);
        await afterLateEvidence(seen.id);
        expect(await decisionOf(seen.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_unreachable' });
      });
    });

    it('is never read as the person’s, and a fault row of another run never gives this run back', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      // The probe of run r0 could not reach the relay; the job that ended is judged on run r1: the row is not r1's
      const other = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1], run: 'r1' }, async (jobId) => {
        await readied(jobId);
        await recordRelayUnreachable(prisma, jobId, { run: 'r0' });
        await recordFaults(sara.brickId, jobId, [fault(1, 'stream_cut', { run: 'r1' })]);
      });
      expect(await decisionOf(other.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'stream_cut' });
    });
  });

  describe('what the person reads while Orbit is still deciding (GPT observation: a provisional charge reads "still deciding")', () => {
    const itemOf = async (personId: string, jobId: string) => {
      return (await activityFor(personId)).find((item) => item.id === `act_job_${jobId}`);
    };

    it('an outside effect still to be confirmed: charged for now, and the receipt says Orbit is still deciding, never Done and never refunded; once decided it is refunded, on the same line', async () => {
      const sara = await person('sara');
      const held = await job(sara, ours, async (jobId) => {
        await planEffect(jobId, { key: 'mail-open', kind: 'send' });
      });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
      // The money rows: the time is on the person for now
      expect(await givenBack(held.id)).toBe(false);
      const cost = Number((await timeOf(held.id)).costMicros);
      expect(cost).toBeGreaterThan(0);
      const deciding = await itemOf(sara.id, held.id);
      expect(deciding).toMatchObject({ state: 'done', outcome: 'deciding', outcomeText: OUTCOME_WORDS.deciding, spentMicros: cost });
      expect(deciding?.outcomeText).not.toBe(OUTCOME_WORDS.done);
      expect(deciding?.outcomeText).not.toBe(OUTCOME_WORDS.refunded);
      expect(deciding?.outcomeNote).toContain('We’re still checking this one. If it was our fault, the time comes back.');
      expect(deciding?.outcomeNote).toContain('is charged for now.');
      // The effect is settled as not done: the decision is made, the time goes back, and the same line now says refunded
      const effect = await prisma.computerEffect.findFirstOrThrow({ where: { jobId: held.id } });
      expect(await settleEffect(held.id, effect.effectKey, 'failed')).toBe(true);
      // (settling the effect decides it itself; a sweep that comes after finds nothing left to decide)
      await resolveDecision(held.id, minutes(60));
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given' });
      const after = await itemOf(sara.id, held.id);
      expect(after).toMatchObject({ id: deciding?.id, state: 'refunded', outcome: 'refunded', outcomeText: OUTCOME_WORDS.refunded, spentMicros: null });
    });

    it('limits that are missing: the same words, with no word about limits; and once they are set and Orbit decides to charge, it reads as an ordinary failed job', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
      const sara = await person('sara');
      const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'limits_missing' });
      const item = await itemOf(sara.id, held.id);
      expect(item).toMatchObject({ state: 'done', outcome: 'deciding', outcomeText: OUTCOME_WORDS.deciding });
      expect(item?.outcomeNote).toContain('We’re still checking this one. If it was our fault, the time comes back.');
      expect(item?.outcomeNote).not.toMatch(/limit/i);
      // The Limits are set, and the person's bound is already used: Orbit decides to charge, and it reads as what it is, a job that did not finish (never "refunded")
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      expect(await resolveDecision(held.id, minutes(60))).toBe('resolved');
      expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      const decided = await itemOf(sara.id, held.id);
      expect(decided).toMatchObject({ id: item?.id, state: 'done', outcome: 'failed', outcomeText: OUTCOME_WORDS.failed });
      expect(decided?.outcomeNote).toMatch(/^It didn’t finish\. Computer time used \$0\.03\./);
    });
  });

  describe('the faults the relay keeps (recordFaults)', () => {
    it('keeps one row per (job, call), says nothing twice, settles an uncertain row once, and knows only its own Brick’s jobs', async () => {
      const sara = await person('sara');
      const other = await person('other');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!started.ok) throw new Error('no');
      const id = started.job.id;
      const row = { turn: 2, callId: 'c-x', kind: 'uncertain' as const, reason: 'timeout_after_output', source: 'universe-ai' as const, route: 'r1', providerStatus: null, at: new Date() };
      expect(await recordFaults(sara.brickId, id, [row])).toEqual({ stored: 1, conflicts: 0 });
      expect(await recordFaults(sara.brickId, id, [row])).toEqual({ stored: 0, conflicts: 0 });
      // The uncertain one turns out to be our fault: settled once; then it cannot move again
      expect(await recordFaults(sara.brickId, id, [{ ...row, kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 1, conflicts: 0 });
      expect(await recordFaults(sara.brickId, id, [{ ...row, kind: 'not_ours', reason: 'allowance' }])).toEqual({ stored: 0, conflicts: 0 });
      expect(await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ kind: 'fault', reason: 'provider_key_ours' });
      // A different Brick does not own the job; an unknown job is unknown
      expect(await recordFaults(other.brickId, id, [row])).toBeNull();
      expect(await recordFaults(sara.brickId, randomUUID(), [row])).toBeNull();
      expect(await prisma.computerJobFault.count({ where: { jobId: id } })).toBe(1);
    });

    it('settles an uncertain row only for the run and turn that kept it: another run’s confirmed fault under the same call id is a conflict and changes nothing', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!started.ok) throw new Error('no');
      const id = started.job.id;
      const at = new Date();
      const uncertainOfA = { turn: 2, run: 'run-a', callId: 'c1', kind: 'uncertain' as const, reason: 'timeout_after_output', source: 'universe-ai' as const, route: 'r1', providerStatus: null, at };
      expect(await recordFaults(sara.brickId, id, [uncertainOfA])).toEqual({ stored: 1, conflicts: 0 });
      // Run B names the same real call id (it is the model call's own) with a confirmed fault
      expect(await recordFaults(sara.brickId, id, [{ ...uncertainOfA, run: 'run-b', turn: 5, kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 0, conflicts: 1 });
      expect(await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ kind: 'uncertain', reason: 'timeout_after_output', run: 'run-a', turn: 2 });
      // The same turn of another run is also a conflict; the run's own confirmation still settles it
      expect(await recordFaults(sara.brickId, id, [{ ...uncertainOfA, run: 'run-b', kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 0, conflicts: 1 });
      expect(await recordFaults(sara.brickId, id, [{ ...uncertainOfA, kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 1, conflicts: 0 });
      expect(await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ kind: 'fault', reason: 'provider_key_ours', run: 'run-a', turn: 2 });
    });
  });

  describe('one provider failing for many people', () => {
    it('pauses new platform-funded work on that route once as many different people had a job fail in the window as Instant’s smallest batch, never a person’s own key, and lifts by itself', async () => {
      await limitsAre({ ...LAUNCH, pauseMinRuns: 3 });
      const people3 = [await person('a'), await person('b'), await person('c')];
      const route = 'universe-ai/model-z';
      const started = [] as Array<{ id: string; brickId: string }>;
      for (const p of people3) {
        const s = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, minutes(0));
        if (!s.ok) throw new Error('no');
        started.push({ id: s.job.id, brickId: p.brickId });
      }
      const probe = started[0];
      const { token } = (await mintJobToken(probe.id, 'model', new Date())) as { token: string };
      // Two jobs failed on the route: below the smallest batch, so nothing is paused
      for (const s of started.slice(0, 2)) await recordFaults(s.brickId, s.id, [fault(1, 'provider_5xx', { route })]);
      expect(await routeIsPaused(route)).toBe(false);
      expect(await authorizeModelCall({ token, callId: 'p1', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toMatchObject({ ok: true });
      // Many rows of one job are one; a third person makes three
      await recordFaults(started[1].brickId, started[1].id, [fault(2, 'provider_429', { route })]);
      expect(await routeIsPaused(route)).toBe(false);
      await recordFaults(started[2].brickId, started[2].id, [fault(1, 'provider_5xx', { route })]);
      expect(await routeIsPaused(route)).toBe(true);
      expect((await giveBackOverview()).routes).toContainEqual({ route, failedPeople: 3, paused: true });
      // New platform-funded work waits (our own decision: answered full, so the relay records it as a fault of ours; nothing is held); another route and the person's own key are untouched
      expect(await authorizeModelCall({ token, callId: 'p2', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toEqual({ ok: false, reason: 'pool', full: true });
      expect(await authorizeModelCall({ token, callId: 'p3', estimateMicros: 1_000, payer: 'universe', route: 'universe-ai/other' }, new Date())).toMatchObject({ ok: true });
      expect(await authorizeModelCall({ token, callId: 'p4', estimateMicros: 1_000, payer: 'own-key', route }, new Date())).toMatchObject({ ok: true });
      // A fault of the person's, or of our relay, is not a provider failing
      expect(await routeIsPaused('universe-ai/clean')).toBe(false);
      // It lifts by itself once the window has passed
      expect(await routeIsPaused(route, new Date(Date.now() + 61 * 60_000))).toBe(false);
    });

    it('a call that already holds its room is answered with its own authorization when it is asked again after the route paused; only a new call id waits', async () => {
      await limitsAre({ ...LAUNCH, pauseMinRuns: 3 });
      const people3 = [await person('a'), await person('b'), await person('c')];
      const route = 'universe-ai/model-replay';
      const started = [] as Array<{ id: string; brickId: string }>;
      for (const p of people3) {
        const s = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, minutes(0));
        if (!s.ok) throw new Error('no');
        started.push({ id: s.job.id, brickId: p.brickId });
      }
      const { token } = (await mintJobToken(started[0].id, 'model', new Date())) as { token: string };
      const first = await authorizeModelCall({ token, callId: 'held-1', estimateMicros: 1_000, payer: 'universe', route }, new Date());
      expect(first).toMatchObject({ ok: true, reservedMicros: 1_000 });
      // The route pauses in between
      for (const s of started) await recordFaults(s.brickId, s.id, [fault(1, 'provider_5xx', { route })]);
      expect(await routeIsPaused(route)).toBe(true);
      // The same call id, asked again (the relay's retry), gets what it was given; a new call id waits and takes nothing
      expect(await authorizeModelCall({ token, callId: 'held-1', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toEqual(first);
      expect(await authorizeModelCall({ token, callId: 'new-1', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toEqual({ ok: false, reason: 'pool', full: true });
      expect(await prisma.meterReservation.count({ where: { jobId: started[0].id, reservationKey: { startsWith: 'computer:call:' } } })).toBe(1);
      // A call whose room was settled is not replayed past the pause: the first try is the call
      await settleModelCall(started[0].id, 'held-1', { costMicros: 800, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, new Date());
      expect(await authorizeModelCall({ token, callId: 'held-1', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toEqual({ ok: false, reason: 'pool', full: true });
    });

    it('does not pause on rows of the person’s own key, the relay’s own faults, or answered calls', async () => {
      await limitsAre({ ...LAUNCH, pauseMinRuns: 1 });
      const sara = await person('sara');
      const s = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!s.ok) throw new Error('no');
      const route = 'universe-ai/model-q';
      await recordFaults(sara.brickId, s.job.id, [fault(1, 'provider_5xx', { route, source: 'own-key' }), fault(2, 'relay_down', { route }), fault(3, 'provider_5xx', { route, kind: 'answered' })]);
      expect(await routeIsPaused(route)).toBe(false);
    });

    it('does not pause on a Limits read that fails: a blip never stops anyone’s work', async () => {
      await limitsAre({ ...LAUNCH, pauseMinRuns: 1 });
      const sara = await person('sara');
      const s = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!s.ok) throw new Error('no');
      await recordFaults(sara.brickId, s.job.id, [fault(1, 'provider_5xx', { route: 'r-blip' })]);
      expect(await routeIsPaused('r-blip')).toBe(true);
      const spy = jest.spyOn(prisma.appSetting, 'findUnique').mockRejectedValue(new Error('blip'));
      try {
        expect(await routeIsPaused('r-blip')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['through a pending look first', 'straight to the refusal'] as const)('CodeRabbit on #1025 (14c4e407 pass, N2): a no-turn agent finish that is held, then judged on a numbered row of its run once that row arrives, keeps that turn (%s): the decision stores it, and an incident on that route reverses the refusal', async (path) => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-n2';
      const base = new Date();
      const window = { route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) };
      const held = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runn2' }, async (id) => {
        // A row of its run that names no turn (so nothing numbered to judge yet), unresolved: the decision is held for the effect
        await recordFaults(sara.brickId, id, [fault(null, 'provider_5xx', { route, run: 'runn2', at: base })]);
        await planEffect(id, { key: 'n2-mail', kind: 'send' });
      });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved', judgedTurns: [] });
      // The numbered row of the judged run arrives while the effect is still unresolved: the pending decision stores the turn it is now judged on
      await recordFaults(sara.brickId, held.id, [fault(2, 'provider_5xx', { route, run: 'runn2', at: base })]);
      if (path === 'through a pending look first') {
        expect(await resolveDecision(held.id, minutes(30))).toBe('pending');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', judgedTurns: [2] });
      } else {
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', judgedTurns: [] });
      }
      // The effect is delivered: the decision is refused as delivered, and it keeps that turn
      expect(await settleEffect(held.id, 'n2-mail', 'done', 'ali@example.test')).toBe(true);
      expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'delivered', judgedTurns: [2] });
      expect(await givenBack(held.id)).toBe(false);
      // An incident on that route and time reverses it (its evidence is the judged turn's own row)
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 1 });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(held.id)).toBe(true);
    });

    it('GPT eighth note, 2b: a refusal whose turn list was filled only when its pending refund resolved is corrected by the incident and refunded EXACTLY ONCE (a second correction, a retry of the resolver and the sweep change nothing)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-2b';
      const base = new Date();
      const window = { route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) };
      const held = await job(sara, { outcome: 'failed', cause: 'agent', run: 'run2b' }, async (id) => {
        await recordFaults(sara.brickId, id, [fault(null, 'provider_5xx', { route, run: 'run2b', at: base })]);
        await planEffect(id, { key: '2b-mail', kind: 'send' });
      });
      await recordFaults(sara.brickId, held.id, [fault(3, 'provider_5xx', { route, run: 'run2b', at: base })]);
      expect(await settleEffect(held.id, '2b-mail', 'done', 'ali@example.test')).toBe(true);
      // Refused as delivered, with the turn it was judged on kept: that turn is what lets the incident find it
      expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'delivered', judgedTurns: [3] });
      expect(await givenBack(held.id)).toBe(false);
      const eventsOf = () => prisma.meterEvent.count({ where: { eventId: { startsWith: `computer:${held.id}:` } } });
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 1 });
      expect(await givenBack(held.id)).toBe(true);
      const once = await timeOf(held.id);
      const events = await eventsOf();
      // Again: nothing is corrected a second time, the decision and the posted give-back stay as they were
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 0 });
      expect(await resolveDecision(held.id, minutes(30))).not.toBe('pending');
      await sweepGiveBackDecisions(minutes(60));
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident', judgedTurns: [3] });
      expect(await timeOf(held.id)).toEqual(once);
      expect(await eventsOf()).toBe(events);
    });

    it('an incident corrects a decision only by its OWN evidence: a fault of an earlier run of the same job, or of a turn that was not judged, never reverses it', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-scope';
      const base = new Date();
      const window = { route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) };
      // Held for an effect still to be confirmed: judged on run b, turn 1, which has no row of a provider failing. The provider's failure on the route is from run a
      const earlierRun = await job(sara, { ...ours, turns: [1], run: 'runb' }, async (id) => {
        await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx', { route, run: 'runa', at: base })]);
        await planEffect(id, { key: 'scope-1', kind: 'send' });
      });
      // The same on a turn that was not judged (turn 2 of the same run)
      const otherTurn = await job(sara, { ...ours, turns: [1], run: 'runb' }, async (id) => {
        await recordFaults(sara.brickId, id, [fault(2, 'provider_5xx', { route, run: 'runb', at: base })]);
        await planEffect(id, { key: 'scope-2', kind: 'send' });
      });
      // The provider's failure IS part of what was judged (run b, turn 1)
      const ownEvidence = await job(sara, { ...ours, turns: [1], run: 'runb' }, async (id) => {
        await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx', { route, run: 'runb', at: base })]);
        await planEffect(id, { key: 'scope-3', kind: 'send' });
      });
      for (const one of [earlierRun, otherTurn, ownEvidence]) expect(await decisionOf(one.id)).toMatchObject({ state: 'pending', judgedRun: 'runb', judgedTurns: [1] });
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 1, uncounted: 0 });
      expect(await decisionOf(earlierRun.id)).toMatchObject({ state: 'pending' });
      expect(await decisionOf(otherTurn.id)).toMatchObject({ state: 'pending' });
      expect(await decisionOf(ownEvidence.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(earlierRun.id)).toBe(false);
      expect(await givenBack(otherTurn.id)).toBe(false);
      expect(await givenBack(ownEvidence.id)).toBe(true);
    });

    it('the same evidence gives the same incident correction whichever arrives first, the provider fault row or the finish; a numbered fault on a turn nobody judged still reverses nothing', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const route = 'universe-ai/model-both-orders';
      // One fixed mid-month origin: the bound is per calendar month, and three jobs and their rows made across midnight of the month's last day would not share one
      const window = { route, from: new Date(MIDMONTH.getTime() - 60 * 60_000), to: new Date(MIDMONTH.getTime() + 600 * 60_000) };
      const at = MIDMONTH;
      // The runner names no turn and says the agent ended: the last turn with a row is judged (run b). Row BEFORE the finish
      const before = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, withFaults(sara, [fault(2, 'provider_5xx', { route, run: 'runb', at })]), MIDMONTH);
      // The same row AFTER the finish (the relay writes best effort)
      const after = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, undefined, MIDMONTH);
      expect(await decisionOf(after.id)).toMatchObject({ state: 'refused', basis: 'agent_ended', judgedTurns: [] });
      await recordFaults(sara.brickId, after.id, [fault(2, 'provider_5xx', { route, run: 'runb', at })]);
      await afterLateEvidence(after.id);
      // A provider failure is unresolved, never ours alone: the one found on time is bounded goodwill, and the late one is judged the same way. Both decisions stand on turn 2 of run b
      expect(await decisionOf(before.id)).toMatchObject({ state: 'given', basis: 'goodwill', judgedRun: 'runb', judgedTurns: [2] });
      expect(await decisionOf(after.id)).toMatchObject({ state: 'given', basis: 'goodwill', judgedRun: 'runb', judgedTurns: [2] });
      // A turn nobody judged: turn 2 (a failure on another route) was the last one found, and a provider failure of THIS route arrives later still, on turn 3
      const unjudged = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, undefined, MIDMONTH);
      await recordFaults(sara.brickId, unjudged.id, [fault(2, 'provider_5xx', { route: 'universe-ai/elsewhere', run: 'runb', at })]);
      await afterLateEvidence(unjudged.id);
      await recordFaults(sara.brickId, unjudged.id, [fault(3, 'provider_5xx', { route, run: 'runb', at })]);
      await afterLateEvidence(unjudged.id);
      // Its judged turn is 2, on ANOTHER route: that is what it was judged on (the person's bound is used by the two above: refused for the cap); the later row of turn 3 is for a turn nobody judged and changes nothing
      expect(await decisionOf(unjudged.id)).toMatchObject({ state: 'refused', basis: 'cap', judgedTurns: [2] });
      // The incident corrects both by the same evidence, whichever arrived first: the counted goodwill is freed from the bound. The one judged on another route's failure is not touched by it
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 0, uncounted: 2 });
      expect(await decisionOf(before.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(after.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(unjudged.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await givenBack(before.id)).toBe(true);
      expect(await givenBack(after.id)).toBe(true);
      expect(await givenBack(unjudged.id)).toBe(false);
    });

    it('a decision judged on no turn is read on every row of the job only when the runner called it ours; for any other hint a numbered fault of another run never reverses it, and a turnless one of its own run does', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const route = 'universe-ai/model-no-turn';
      const window = { route, from: minutes(-60), to: minutes(600) };
      // The agent ended on its own: the runner named no turn and nothing was recorded, so the decision judged no turn (run b)
      const agentEnded = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' });
      const turnless = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' });
      expect(await decisionOf(agentEnded.id)).toMatchObject({ state: 'refused', basis: 'agent_ended', judgedRun: 'runb', judgedTurns: [] });
      expect(await decisionOf(turnless.id)).toMatchObject({ state: 'refused', basis: 'agent_ended', judgedTurns: [] });
      // A provider failure of ANOTHER run of the job (a numbered turn) is not what this decision judged
      await recordFaults(sara.brickId, agentEnded.id, [fault(3, 'provider_5xx', { route, run: 'runa' })]);
      // A turnless one of its own run is part of its evidence
      await recordFaults(sara.brickId, turnless.id, [fault(null, 'provider_5xx', { route, run: 'runb' })]);
      expect(await correctRouteTogether(window)).toMatchObject({ corrected: 1, uncounted: 0 });
      expect(await decisionOf(agentEnded.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await givenBack(agentEnded.id)).toBe(false);
      expect(await decisionOf(turnless.id)).toMatchObject({ state: 'given', basis: 'incident' });
    });

    it('a runner that named no turn, with no numbered row to choose one from, is judged on the confirmed rows that apply to the whole job (its run’s and no run’s), never on the numbered rows of another run', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      // Our relay was down before any turn: a turnless confirmed fault of this run
      const ownRun = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, withFaults(sara, [fault(null, 'relay_down', { run: 'runb' })]));
      expect(await decisionOf(ownRun.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_down' });
      expect(await givenBack(ownRun.id)).toBe(true);
      // The same naming no run at all (it applies to the whole job)
      const wholeJob = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, withFaults(sara, [fault(null, 'relay_down', { run: null })]));
      expect(await decisionOf(wholeJob.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      // A numbered fault of ours of ANOTHER run, and a turnless one of another run, are not what this run's ending rests on: the agent ended on its own
      const otherRun = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' }, withFaults(sara, [fault(3, 'relay_down', { run: 'runa' }), fault(null, 'relay_down', { run: 'runa' })]));
      expect(await decisionOf(otherRun.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      expect(await givenBack(otherRun.id)).toBe(false);
    });

    it('a confirmed turnless fault of ours that arrives late gives back a job the agent was said to have ended itself, by the same reading; a numbered one of another run does not', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const late = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' });
      const stranger = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runb' });
      expect(await decisionOf(late.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      await recordFaults(sara.brickId, stranger.id, [fault(5, 'relay_down', { run: 'runa' })]);
      await afterLateEvidence(stranger.id);
      expect(await decisionOf(stranger.id)).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      await recordFaults(sara.brickId, late.id, [fault(null, 'relay_down', { run: 'runb' })]);
      await afterLateEvidence(late.id);
      expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'relay_down' });
      expect(await givenBack(late.id)).toBe(true);
      expect(await givenBack(stranger.id)).toBe(false);
    });

    it('the legacy verdict the runner called ours with no turns named keeps reading every row of the job: a provider row of any run on the route qualifies', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-legacy';
      const first = await job(sara, ours);
      // The cap is used; this one is refused as capped, with every row of the job its evidence
      const capped = await job(sara, ours, withFaults(sara, [fault(4, 'provider_5xx', { route, run: 'runz' })]));
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'refused', basis: 'cap', judgedTurns: [] });
      expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 1 });
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'given', basis: 'incident' });
    });

    it('corrects every affected job together: held, cap-refused and delivered ones are given back uncounted (an App’s own delivery stays), person-caused ones are left alone, and it is safe to say twice', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-i';
      const base = new Date();
      const rows = (r: string) => [fault(1, r, { route, at: base })];
      // 1 goodwill give-back uses the bound; 2 and 3 are refused by it; 4 is held for an effect; 5 is the person's; 6 delivered
      const first = await job(sara, { ...ours, turns: [1] }, withFaults(sara, rows('provider_5xx')));
      const capped = await job(sara, { ...ours, turns: [1] }, withFaults(sara, rows('provider_5xx')));
      const held = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await recordFaults(sara.brickId, id, rows('provider_5xx'));
        await planEffect(id, { key: 'mail-1', kind: 'send' });
      });
      const theirs = await job(sara, { ...ours, turns: [1] }, withFaults(sara, rows('allowance')));
      const delivered = await job(sara, { ...ours, turns: [1] }, async (id) => {
        await recordFaults(sara.brickId, id, rows('provider_5xx'));
        await planEffect(id, { key: 'mail-2', kind: 'send' });
        await settleEffect(id, 'mail-2', 'done', 'ali@example.test');
      });
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'pending' });
      const result = await correctRouteTogether({ route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) });
      // The held and capped ones, and the one that delivered something outside its computer (the incident caused its failure: its computer cost goes back, what its App did stays)
      expect(result.corrected).toBe(3);
      // The goodwill one given back before the incident was known is freed from the bound too (it was the provider's)
      expect(result.uncounted).toBe(1);
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(capped.id)).toBe(true);
      expect(await givenBack(held.id)).toBe(true);
      expect(await givenBack(theirs.id)).toBe(false);
      expect(await decisionOf(delivered.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(delivered.id)).toBe(true);
      expect(await prisma.computerEffect.count({ where: { jobId: delivered.id, state: 'done' } })).toBe(1);
      // None of them used the bound: they are incidents, not the person's goodwill
      expect(await prisma.computerJob.count({ where: { personId: sara.id, runnerFault: true } })).toBe(0);
      expect(await correctRouteTogether({ route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) })).toEqual({ corrected: 0, uncounted: 0, costMicros: 0 });
    });

    it('tells operations what is at risk: decisions by state with their cost, the oldest held one, and the failing routes', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { route: 'universe-ai/model-o' })]));
      const held = await job(sara, ours, async (id) => {
        await planEffect(id, { key: 'mail-1', kind: 'send' });
      });
      const overview = await giveBackOverview(new Date(Date.now() + 10 * 60_000));
      expect(overview.decisions.map((row) => `${row.state}:${row.basis}`)).toEqual(expect.arrayContaining(['given:goodwill', 'pending:effect_unresolved']));
      expect(overview.pending.jobs).toBe(1);
      expect(overview.pending.costMicros).toBeGreaterThan(0);
      expect(overview.pending.oldestMinutes).toBeGreaterThanOrEqual(0);
      expect(overview.routes).toContainEqual({ route: 'universe-ai/model-o', failedPeople: 1, paused: false });
      expect(held.id).toBeTruthy();
    });
  });

  describe('holes found by the read of the amend (late evidence, purge, pause by one person)', () => {
    it('un-counts a goodwill give-back when a confirmed fault of ours arrives late: the bound is not used, and the next unclear failure is still given back', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const first = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ runnerFault: true });
      // Our key was out of credit on that very turn; the row reaches Orbit late
      await recordFaults(sara.brickId, first.id, [fault(1, 'provider_key_ours', { providerStatus: 402 })]);
      // Said twice at the same moment: both attempt the goodwill-to-fault transition together, and it happens once
      await Promise.all([afterLateEvidence(first.id), afterLateEvidence(first.id)]);
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'provider_key_ours' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      expect(await givenBack(first.id)).toBe(true);
      // The bound (1) is free again
      const next = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(next.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      // Said again later it changes nothing more
      await afterLateEvidence(first.id);
      expect(await decisionOf(first.id)).toMatchObject({ basis: 'universe_fault' });
      expect(await prisma.computerJob.count({ where: { personId: sara.id, runnerFault: true } })).toBe(1);
    });

    it('does not touch a give-back that is already uncounted, or a decision the runner did not call ours, when a late row arrives', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const orbit = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'relay_down')]));
      const before = await decisionOf(orbit.id);
      await recordFaults(sara.brickId, orbit.id, [fault(1, 'provider_key_ours')]);
      await afterLateEvidence(orbit.id);
      expect(await decisionOf(orbit.id)).toMatchObject({ basis: 'universe_fault', reason: before?.reason });
    });

    it('lets one person alone never pause a route: three jobs of one person with fieldless 400s are one person', async () => {
      await limitsAre({ ...LAUNCH, pauseMinRuns: 3 });
      const sara = await person('sara');
      const route = 'universe-ai/model-solo';
      for (let n = 0; n < 3; n++) {
        const brickId = n === 0 ? sara.brickId : (await createBrick({ ownerId: sara.id, name: `Solo ${n}` })).id;
        if (n > 0) await giveComputer(brickId, sara.id);
        const s = await startJob({ botId: brickId, personId: sara.id, title: `Solo ${n}` }, minutes(0));
        if (!s.ok) throw new Error('no');
        await recordFaults(brickId, s.job.id, [fault(1, 'fieldless_400', { route })]);
      }
      expect(await routeIsPaused(route)).toBe(false);
      expect((await giveBackOverview()).routes).toContainEqual({ route, failedPeople: 1, paused: false });
      // A second and a third person make three people
      for (const name of ['two', 'three']) {
        const p = await person(name);
        const s = await startJob({ botId: p.brickId, personId: p.id, title: 'Other' }, minutes(0));
        if (!s.ok) throw new Error('no');
        await recordFaults(p.brickId, s.job.id, [fault(1, 'provider_5xx', { route })]);
      }
      expect(await routeIsPaused(route)).toBe(true);
    });

    it('gives back, uncounted and with the bound spent, a job that fails because OUR pause refused its call (the route is paused: answered full, recorded as a fault of ours)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1, pauseMinRuns: 2 });
      const sara = await person('sara');
      expect(await givenBack((await job(sara, ours)).id)).toBe(true);
      const route = 'universe-ai/model-paused';
      for (const name of ['p1', 'p2']) {
        const p = await person(name);
        const s = await startJob({ botId: p.brickId, personId: p.id, title: 'Failing' }, minutes(0));
        if (!s.ok) throw new Error('no');
        await recordFaults(p.brickId, s.job.id, [fault(1, 'provider_5xx', { route })]);
      }
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Refused by the pause' }, minutes(100));
      if (!started.ok) throw new Error('no');
      const { token } = (await mintJobToken(started.job.id, 'model', new Date())) as { token: string };
      const answer = await authorizeModelCall({ token, callId: 'x1', estimateMicros: 1_000, payer: 'universe', route }, new Date());
      expect(answer).toEqual({ ok: false, reason: 'pool', full: true });
      // The game reads full as a confirmed pool_busy and writes a fault row; three such turns end the job as ours
      await recordFaults(sara.brickId, started.job.id, [fault(1, 'pool_busy'), fault(2, 'pool_busy'), fault(3, 'pool_busy')]);
      await finishJob(started.job.id, 'failed', minutes(105), null, 'ours', [1, 2, 3]);
      expect(await decisionOf(started.job.id)).toMatchObject({ state: 'given', basis: 'universe_fault', reason: 'pool_busy' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      expect(await givenBack(started.job.id)).toBe(true);
    });

    it('corrects a goodwill give-back of the same incident together: it is freed from the bound, and the next unclear failure is given back', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
      const sara = await person('sara');
      const route = 'universe-ai/model-inc';
      const base = new Date();
      const first = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { route, at: base })]));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ runnerFault: true });
      expect(await correctRouteTogether({ route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) })).toEqual({ corrected: 0, uncounted: 1, costMicros: 0 });
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ endedBy: 'error', runnerFault: false });
      expect(await givenBack(first.id)).toBe(true);
      const next = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
      expect(await decisionOf(next.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
    });

    describe('runs: a bot-server restart makes a new run that numbers its turns from 1 again', () => {
      it('does not mix two runs that use the same turn numbers: the rows of an earlier run are not the turns of the new one', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        // Run A's turn 1 was the person's (their job set a field the provider refused); run B's turn 1 crashed and left no row
        const rowsA = [fault(1, 'field_job_set', { run: 'runa' })];
        const mixed = await job(sara, { ...ours, turns: [1], run: 'runb' }, withFaults(sara, rowsA));
        expect(await decisionOf(mixed.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'no_row', judgedRun: 'runb' });
        // The same rows judged in the run they belong to are the person's
        const own = await job(sara, { ...ours, turns: [1], run: 'runa' }, withFaults(sara, [fault(1, 'field_job_set', { run: 'runa' })]));
        expect(await decisionOf(own.id)).toMatchObject({ state: 'refused', basis: 'person_caused', judgedRun: 'runa' });
      });

      it('reads a confirmed fault of ours only in the run it was written in, and a late row of another run changes nothing', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        // Our fault on turn 1 of run A; the job's new run B crashed on its turn 1 with no row: B's ending is unresolved, and the bound is spent
        const ended = await job(sara, { ...ours, turns: [1], run: 'runb' }, withFaults(sara, [fault(1, 'provider_key_ours', { run: 'runa' })]));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        await afterLateEvidence(ended.id);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        // A late row of OUR fault in run B itself does give it back
        await recordFaults(sara.brickId, ended.id, [fault(1, 'provider_key_ours', { run: 'runb' })]);
        await afterLateEvidence(ended.id);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });

      it('keeps the run a held decision was judged in: decided again later (the Limits now set) it reads the same run’s rows, not another run’s', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1], run: 'runb' }, withFaults(sara, [fault(1, 'provider_5xx', { run: 'runb' }), fault(1, 'allowance', { run: 'runa', callId: 'other-run' })]));
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', judgedRun: 'runb', reason: 'provider_5xx' });
        await limitsAre(LAUNCH);
        await sweepComputers(new Date(NOW.getTime() + 3 * 60 * 60_000));
        // Decided from run B's own row (the provider's 5xx), not as "no row" (run lost) and not from run A's allowance
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'provider_5xx' });
      });

      it('matches no run with no run, so rows and finishes from a game that names none read as before; a run on only one side is not a match', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const none = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'field_job_set')]));
        expect(await decisionOf(none.id)).toMatchObject({ state: 'refused', basis: 'person_caused', judgedRun: null });
        const finishOnly = await job(sara, { ...ours, turns: [1], run: 'runx' }, withFaults(sara, [fault(1, 'field_job_set')]));
        expect(await decisionOf(finishOnly.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'no_row' });
        const rowOnly = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'field_job_set', { run: 'runx' })]));
        expect(await decisionOf(rowOnly.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'no_row' });
      });

      it('keeps the run of a row once, like the rest of it (a row said twice changes nothing)', async () => {
        const sara = await person('sara');
        const s = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
        if (!s.ok) throw new Error('no');
        const row = fault(2, 'provider_5xx', { run: 'runa', callId: 'same' });
        expect(await recordFaults(sara.brickId, s.job.id, [row])).toEqual({ stored: 1, conflicts: 0 });
        // A real call id another run uses is not kept over the first, and it is not dropped silently: it is counted as a conflict
        expect(await recordFaults(sara.brickId, s.job.id, [{ ...row, run: 'runb' }])).toEqual({ stored: 0, conflicts: 1 });
        expect(await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: s.job.id } })).toMatchObject({ run: 'runa' });
      });
    });

    describe('round 3: what a ruling reads', () => {
      it('an own-key call refused for its own provider key is the person’s only when the relay says it is not ours; an unconfirmed row, or one that says fault, stays unresolved', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const sara = await person('sara');
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        const own = (kind: FaultInput['kind']) => withFaults(sara, [fault(1, 'provider_key_ours', { source: 'own-key', kind })]);
        // Only row of the judged turn, unconfirmed: unresolved, so past the bound it is refused for the cap, never as the person's doing
        const uncertain = await job(sara, { ...ours, turns: [1] }, own('uncertain'));
        expect(await decisionOf(uncertain.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        const contradicting = await job(sara, { ...ours, turns: [1] }, own('fault'));
        expect(await decisionOf(contradicting.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        const confirmed = await job(sara, { ...ours, turns: [1] }, own('not_ours'));
        expect(await decisionOf(confirmed.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
      });

      it('a row with no turn counts for a run only when it names no run or that run: another named run’s never does', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 0 });
        const sara = await person('sara');
        // Run A recorded a turnless relay fault; run B finishes on turn 1: A's fault is not B's
        const other = await job(sara, { ...ours, turns: [1], run: 'runb' }, withFaults(sara, [fault(null, 'relay_down', { run: 'runa', callId: 'turn:none-a' }), fault(1, 'field_job_set', { run: 'runb' })]));
        expect(await decisionOf(other.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
        // The same run's own turnless fault, and a runless one, do count
        const same = await job(sara, { ...ours, turns: [1], run: 'runb' }, withFaults(sara, [fault(null, 'relay_down', { run: 'runb', callId: 'turn:none-b' })]));
        expect(await decisionOf(same.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        const runless = await job(sara, { ...ours, turns: [1], run: 'runc' }, withFaults(sara, [fault(null, 'relay_down', { callId: 'turn:none-c' })]));
        expect(await decisionOf(runless.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });

      it('answered calls never hide a confirmed fault: more than a page of them ahead of it, and the verdict is still ours', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 0 });
        const sara = await person('sara');
        const early = new Date(Date.now() - 3_600_000);
        const answered = Array.from({ length: 620 }, (_, index) => fault(1, 'relay_down', { kind: 'answered', callId: `ok-${index}`, at: new Date(early.getTime() + index) }));
        const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [...answered, fault(1, 'relay_down', { callId: 'the-fault', at: new Date() })]));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        // And more than a page of failures that are not decisive ahead of a decisive one does not hide it either
        const many = Array.from({ length: 520 }, (_, index) => fault(2, 'provider_5xx', { callId: `slow-${index}`, at: new Date(early.getTime() + index) }));
        const late = await job(sara, { ...ours, turns: [2] }, withFaults(sara, [...many, fault(2, 'relay_down', { callId: 'decisive', at: new Date() })]));
        expect(await decisionOf(late.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });

      it('two runs of one job that each wrote a turn-only row for the same turn are both kept, and each run is judged by its own', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 0 });
        const sara = await person('sara');
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
        if (!started.ok) throw new Error('no');
        const jobId = started.job.id;
        expect(await recordFaults(sara.brickId, jobId, [fault(1, 'field_job_set', { run: 'runa', callId: 'turn:1' })])).toEqual({ stored: 1, conflicts: 0 });
        expect(await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { run: 'runb', callId: 'turn:1' })])).toEqual({ stored: 1, conflicts: 0 });
        expect(await prisma.computerJobFault.count({ where: { jobId } })).toBe(2);
        // Said again, it changes nothing
        expect(await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { run: 'runb', callId: 'turn:1' })])).toEqual({ stored: 0, conflicts: 0 });
        await finishJob(jobId, 'failed', minutes(5), null, 'ours', [1], 'runb');
        expect(await decisionOf(jobId)).toMatchObject({ state: 'given', basis: 'universe_fault' });
      });
    });

    it('two runs that name no run and both report a fault of turn 1 are both kept, never one dropped as the other said again (CodeRabbit: they shared the key turn:1)', async () => {
      await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 0 });
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
      if (!started.ok) throw new Error('no');
      const jobId = started.job.id;
      const rows = () => prisma.computerJobFault.findMany({ where: { jobId }, orderBy: { callId: 'asc' } });
      // The first unnamed run: the person's own doing, confirmed
      expect(await recordFaults(sara.brickId, jobId, [fault(1, 'field_job_set', { callId: 'turn:1' })])).toEqual({ stored: 1, conflicts: 0 });
      // The second unnamed run numbers its turns from 1 again and says something else about its turn 1: kept, not taken for the first said again
      expect(await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { callId: 'turn:1' })])).toEqual({ stored: 1, conflicts: 0 });
      expect((await rows()).map((row) => [row.callId, row.reason])).toEqual([['turn:1', 'field_job_set'], ['turn:1~2', 'relay_down']]);
      // Either said again (a retry) is the same slot and changes nothing
      expect(await recordFaults(sara.brickId, jobId, [fault(1, 'field_job_set', { callId: 'turn:1' })])).toEqual({ stored: 0, conflicts: 0 });
      expect(await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', { callId: 'turn:1' })])).toEqual({ stored: 0, conflicts: 0 });
      expect(await prisma.computerJobFault.count({ where: { jobId } })).toBe(2);
      // An uncertain report is never settled by a confirmed one of an unnamed run (it may be another run's): both are kept, each in its own slot
      expect(await recordFaults(sara.brickId, jobId, [fault(2, 'provider_5xx', { callId: 'turn:2', kind: 'uncertain' })])).toEqual({ stored: 1, conflicts: 0 });
      expect(await recordFaults(sara.brickId, jobId, [fault(2, 'relay_down', { callId: 'turn:2' })])).toEqual({ stored: 1, conflicts: 0 });
      expect((await rows()).filter((row) => row.turn === 2).map((row) => [row.callId, row.kind, row.reason])).toEqual([['turn:2', 'uncertain', 'provider_5xx'], ['turn:2~2', 'fault', 'relay_down']]);
      // Both are read when a ruling on turn 1 asks: the person's and ours
      expect((await readFaultRows(prisma, jobId, [1])).map((row) => row.cls).sort()).toEqual(['ours', 'person']);
      // More different reports than slots is counted and said, not dropped silently
      const many = Array.from({ length: 9 }, (_, index) => fault(3, 'provider_5xx', { callId: 'turn:3', kind: 'uncertain', route: `route-${index}` }));
      expect(await recordFaults(sara.brickId, jobId, many)).toEqual({ stored: 8, conflicts: 1 });
    });

    it('a confirmed report of one unnamed run never settles the uncertain row of another, and the ruling reads both (Opus: a person row beside an unresolved one is unresolved, never a charge)', async () => {
      const sara = await person('sara');
      // Run A (unnamed) reports a provider 5xx on its turn 1 that the relay did not confirm; run B (unnamed too) then reports, on ITS turn 1, that the person's own provider refused their key
      const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { callId: 'turn:1', kind: 'uncertain' }), fault(1, 'own_provider', { callId: 'turn:1', kind: 'not_ours' })]));
      expect((await prisma.computerJobFault.findMany({ where: { jobId: ended.id }, orderBy: { callId: 'asc' } })).map((row) => [row.callId, row.kind, row.reason])).toEqual([
        ['turn:1', 'uncertain', 'provider_5xx'],
        ['turn:1~2', 'not_ours', 'own_provider'],
      ]);
      // Every report said again, in any order, is a retry of a kept one: nothing new is stored and nothing changes (Sentry: a replay of the uncertain one next to the confirmed one made a phantom uncertain row)
      const again = () => prisma.computerJobFault.findMany({ where: { jobId: ended.id }, orderBy: { callId: 'asc' } });
      const before = await again();
      for (const replay of [[fault(1, 'own_provider', { callId: 'turn:1', kind: 'not_ours' })], [fault(1, 'provider_5xx', { callId: 'turn:1', kind: 'uncertain' })], [fault(1, 'provider_5xx', { callId: 'turn:1', kind: 'uncertain' }), fault(1, 'own_provider', { callId: 'turn:1', kind: 'not_ours' })]]) {
        expect(await recordFaults(sara.brickId, ended.id, replay)).toEqual({ stored: 0, conflicts: 0 });
      }
      expect(await again()).toEqual(before);
      // Unresolved wins over the person's row: bounded goodwill (given here, inside the bound), never the refusal that charges the person
      expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', reason: 'provider_5xx' });
      expect(await givenBack(ended.id)).toBe(true);
    });

    describe('round 3: the decision itself', () => {
      it('late evidence gives the verdict evidence on time gives: a confirmed fault of ours beats a delivered effect, and a row that is not one changes nothing', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-1', kind: 'send' });
        });
        expect(await settleEffect(ended.id, 'mail-1', 'done', 'ali@example.test')).toBe(true);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'delivered' });
        // A row of the person's, or an unresolved one, never turns delivered work into a give-back
        await recordFaults(sara.brickId, ended.id, [fault(1, 'allowance'), fault(1, 'provider_5xx')]);
        await afterLateEvidence(ended.id);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'delivered' });
        expect(await givenBack(ended.id)).toBe(false);
        // A confirmed fault of ours does, exactly as it would have on time
        await recordFaults(sara.brickId, ended.id, [fault(1, 'relay_down')]);
        await afterLateEvidence(ended.id);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'universe_fault' });
        expect(await givenBack(ended.id)).toBe(true);
      });

      it('reads the effects once, in one statement: one done blocks goodwill, one still planned defers it, none leaves it to the bound', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, minutes(0));
        if (!started.ok) throw new Error('no');
        const jobId = started.job.id;
        await recordFaults(sara.brickId, jobId, [fault(1, 'provider_5xx')]);
        const seen = { groups: 0, counts: 0 };
        const verdict = (effectsClosed = false) =>
          prisma.$transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get: (target, key) =>
                key === 'computerEffect'
                  ? {
                      groupBy: (args: never) => {
                        seen.groups++;
                        return (target.computerEffect.groupBy as (a: never) => Promise<unknown>)(args);
                      },
                      count: (args: never) => {
                        seen.counts++;
                        return (target.computerEffect.count as (a: never) => Promise<unknown>)(args);
                      },
                    }
                  : (target as never)[key as never],
            }) as typeof tx;
            return decideRunnerFinish(wrapped, await readLimits(), { id: jobId, personId: sara.id, startedAt: new Date() }, [1], new Date(), { effectsClosed });
          }, HOLDER);
        const readLimits = async () => (await import('@/lib/computer-giveback')).readGiveBackLimits();
        expect(await verdict()).toMatchObject({ state: 'given', basis: 'goodwill' });
        await planEffect(jobId, { key: 'a', kind: 'send' });
        expect(await verdict()).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        expect(await verdict(true)).toMatchObject({ state: 'given', basis: 'goodwill' });
        await planEffect(jobId, { key: 'b', kind: 'send' });
        await settleEffect(jobId, 'b', 'done', 'x@example.test');
        // One done and one still planned: the done one decides (delivered), whatever the other is
        expect(await verdict()).toMatchObject({ state: 'refused', basis: 'delivered' });
        expect(seen.counts).toBe(0);
        expect(seen.groups).toBe(4);
      });

      /** Resolves once the retry has READ the decision (as pending): the first read of that job's decision is the retry's, made before it waits for the person's lock. A barrier, never a timer. */
      const retryHasRead = (jobId: string) => {
        const real = prisma.computerGiveBackDecision.findUnique.bind(prisma.computerGiveBackDecision);
        let release: () => void = () => undefined;
        const read = new Promise<void>((resolve) => {
          release = resolve;
        });
        const spy = jest.spyOn(prisma.computerGiveBackDecision, 'findUnique').mockImplementation(((args: { where?: { jobId?: string } }) => {
          const answer = real(args as never);
          if (args?.where?.jobId === jobId) answer.then(() => release(), () => release());
          return answer;
        }) as never);
        return { read, restore: () => spy.mockRestore() };
      };

      it('a retry that read a decision as pending decides nothing over one an incident correction made while it waited for the person’s lock', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'limits_missing' });
        // The Limits are set now and would refuse it (a bound of 0 is no bound set, so use a spent one)
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        let retry: Promise<string> = Promise.resolve('none');
        const barrier = retryHasRead(held.id);
        await prisma.$transaction(async (tx) => {
          await lockPerson(tx, sara.id);
          retry = resolveDecision(held.id, minutes(30));
          // The retry has read the decision as pending; only then does the correction commit
          await barrier.read;
          await tx.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { state: 'given', basis: 'incident', route: 'r', nextAttemptAt: null } });
        }, HOLDER);
        expect(await retry).toBe('none');
        barrier.restore();
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      });

      it('the same for a decision whose job is gone: a decision made while it waited for the lock stands', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        await prisma.computerJob.delete({ where: { id: held.id } });
        let retry: Promise<string> = Promise.resolve('none');
        const barrier = retryHasRead(held.id);
        await prisma.$transaction(async (tx) => {
          await lockPerson(tx, sara.id);
          retry = resolveDecision(held.id, minutes(30));
          // The retry has read the decision as pending; only then does the correction commit
          await barrier.read;
          await tx.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { state: 'given', basis: 'incident', route: 'r', nextAttemptAt: null } });
        }, HOLDER);
        expect(await retry).toBe('none');
        barrier.restore();
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      });

      it('CodeRabbit on #1032 (00abcd25 pass): a retry judges from the decision row it reads UNDER the person’s lock, so a retry that read before the lock never writes its older turn list over the one another retry committed first', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const route = 'universe-ai/model-lock';
        const base = new Date();
        const held = await job(sara, { outcome: 'failed', cause: 'agent', run: 'runlk' }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(null, 'provider_5xx', { route, run: 'runlk', at: base })]);
          await planEffect(id, { key: 'lk-mail', kind: 'send' });
        });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved', judgedTurns: [] });
        // Two numbered rows of the run arrive: a retry that judges from an empty list would take the later one
        await recordFaults(sara.brickId, held.id, [fault(2, 'provider_5xx', { route, run: 'runlk', at: base }), fault(3, 'provider_5xx', { route, run: 'runlk', at: base })]);
        let retry: Promise<string> = Promise.resolve('none');
        const barrier = retryHasRead(held.id);
        await prisma.$transaction(async (tx) => {
          await lockPerson(tx, sara.id);
          retry = resolveDecision(held.id, minutes(30));
          // The retry has read the decision with its empty turn list; only then does the other retry commit the turn it judged on
          await barrier.read;
          await tx.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { judgedTurns: [2], attempts: { increment: 1 } } });
        }, HOLDER);
        expect(await retry).toBe('pending');
        barrier.restore();
        // The committed selection stands: the stale retry does not replace [2] with what it would have judged from its own read
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', judgedTurns: [2], attempts: 2 });
      });

      it('a decision that throws when it is tried again is rescheduled, so the oldest rows cannot keep every slot from the ones behind them', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const ids: string[] = [];
        for (let index = 0; index < 3; index++) ids.push((await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]))).id);
        for (const [index, id] of ids.entries()) await prisma.computerGiveBackDecision.update({ where: { jobId: id }, data: { nextAttemptAt: new Date(NOW.getTime() - (10 - index) * 1000) } });
        const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
        const spyOn = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { where: { id?: string } }) => {
          if (args?.where?.id && ids.slice(0, 2).includes(args.where.id)) throw new Error('boom');
          return real(args as never);
        }) as never);
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const now = minutes(1);
          expect(await sweepGiveBackDecisions(now, 2)).toMatchObject({ looked: 2 });
          for (const id of ids.slice(0, 2)) {
            const row = await decisionOf(id);
            expect(row?.attempts).toBe(1);
            expect(row?.nextAttemptAt && row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
          }
          // The next sweep reaches the one behind them
          expect(await sweepGiveBackDecisions(now, 2)).toMatchObject({ looked: 1 });
          expect((await decisionOf(ids[2]))?.attempts).toBe(1);
        } finally {
          spyOn.mockRestore();
          quiet.mockRestore();
        }
      });

      it('a Brick with more waiting decisions than one batch is not purged until the last is decided', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const first = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        const second = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decidePendingForPurge(sara.brickId, minutes(60), 1)).toBe(false);
        const states = [(await decisionOf(first.id))?.state, (await decisionOf(second.id))?.state].sort();
        expect(states).toEqual(['given', 'pending']);
        expect(await decidePendingForPurge(sara.brickId, minutes(61), 1)).toBe(true);
        expect([(await decisionOf(first.id))?.state, (await decisionOf(second.id))?.state]).toEqual(['given', 'given']);
      });

      it('an incident correction gives back every eligible job, a batch at a time, never stopping at a limit nobody is told about', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const route = 'universe-ai/model-incident';
        const sara = await person('sara');
        // Every job ends on the 15th of this month, so the four are in ONE bound month whenever the test runs (never across a month's end)
        const mid = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 15, 12));
        const at = (n: number) => new Date(mid.getTime() + n * 60_000);
        expect(await givenBack((await job(sara, ours, undefined, mid)).id)).toBe(true);
        const refused: string[] = [];
        for (let index = 0; index < 3; index++) {
          const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { route, at: at(clock + 1) })]), mid);
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
          expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).endedAt?.getUTCMonth()).toBe(mid.getUTCMonth());
          refused.push(ended.id);
        }
        expect(await correctRouteTogether({ route, from: at(-60), to: at(600) }, 1)).toMatchObject({ corrected: 3 });
        for (const id of refused) expect(await decisionOf(id)).toMatchObject({ state: 'given', basis: 'incident' });
        // Said twice it changes nothing
        expect(await correctRouteTogether({ route, from: at(-60), to: at(600) }, 1)).toMatchObject({ corrected: 0, uncounted: 0 });
      });

      it('an incident correction counts a relay’s own reason only on a row the relay called a fault: a row of another kind with such a reason is no evidence of ours', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const route = 'universe-ai/model-contradiction';
        const sara = await person('sara');
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        // Refused (the bound is spent); its only row says relay_down but is NOT called a fault (a contradiction: unresolved, as the verdict reads it)
        const contradicted = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'relay_down', { route, kind: 'not_ours' })]));
        expect(await decisionOf(contradicted.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 0, uncounted: 0 });
        expect(await decisionOf(contradicted.id)).toMatchObject({ state: 'refused', basis: 'cap' });
        // A row that IS a fault of the relay's, and a provider reason of any kind, still correct
        const real = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'pool_busy', { route })]));
        const provider = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { route })]));
        expect([(await decisionOf(real.id))?.state, (await decisionOf(provider.id))?.state]).toEqual(['given', 'refused']);
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 1 });
        expect(await decisionOf(provider.id)).toMatchObject({ state: 'given', basis: 'incident' });
        expect(await decisionOf(contradicted.id)).toMatchObject({ state: 'refused', basis: 'cap' });
      });

      it('an incident correction gives back a job whose outside effect was delivered while its decision waited: operations established the incident caused the failure, so the computer cost goes back and the App’s delivery stays', async () => {
        await limitsAre(LAUNCH);
        const route = 'universe-ai/model-delivered';
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx', { route })]);
          await planEffect(id, { key: 'mail-1', kind: 'send' });
        });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        // The send went out before the decision was decided again
        await prisma.computerEffect.updateMany({ where: { jobId: held.id }, data: { state: 'done' } });
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 1, uncounted: 0 });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
        expect(await givenBack(held.id)).toBe(true);
        expect(await prisma.computerEffect.count({ where: { jobId: held.id, state: 'done' } })).toBe(1);
        // Said twice it is one correction
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 0, uncounted: 0 });
      });

      it('without an incident a delivered effect still disqualifies a still-unresolved job from discretionary goodwill', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const delivered = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-9', kind: 'send' });
          await settleEffect(id, 'mail-9', 'done', 'ali@example.test');
        });
        expect(await decisionOf(delivered.id)).toMatchObject({ state: 'refused', basis: 'delivered' });
        expect(await givenBack(delivered.id)).toBe(false);
        // The same under a hint
        const hinted = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-10', kind: 'send' });
          await settleEffect(id, 'mail-10', 'done', 'ali@example.test');
        });
        expect(await decisionOf(hinted.id)).toMatchObject({ state: 'refused', basis: 'delivered', causeHint: 'agent' });
      });

      it('an incident correction frees a counted goodwill give-back from the bound even when its effect was delivered late: the delivered effect blocks only the flip of a held or refused decision', async () => {
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        const route = 'universe-ai/model-late-delivered';
        const sara = await person('sara');
        const ended = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx', { route })]);
          await planEffect(id, { key: 'late-1', kind: 'send' });
        });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        // The effect is still unconfirmed at the bounded close: given back as goodwill, counted against the bound
        await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { nextAttemptAt: new Date(NOW.getTime() - 1000), decidedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000) } });
        await sweepComputers(new Date(NOW.getTime() + 2 * 24 * 60 * 60_000));
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).runnerFault).toBe(true);
        // ...then the effect turns out delivered
        expect(await settleEffect(ended.id, 'late-1', 'done', 'ali@example.test')).toBe(true);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', deliveredLate: true });
        // Operations correct the incident: the give-back stays, but it no longer uses the person's bound
        expect(await correctRouteTogether({ route, from: minutes(-60), to: new Date(NOW.getTime() + 3 * 24 * 60 * 60_000) })).toMatchObject({ corrected: 0, uncounted: 1 });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'incident' });
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: ended.id } })).runnerFault).toBe(false);
        expect(await givenBack(ended.id)).toBe(true);
        // The person's slot is free again: a later unclear failure is still given back
        expect(await decisionOf((await job(sara, { ...ours, turns: [1] })).id)).toMatchObject({ state: 'given', basis: 'goodwill' });
      });

      it('an effect settled as done and the note that a give-back made while it was unconfirmed was for delivered work commit together: a flag that cannot be written leaves the effect planned, and the retry sets both', async () => {
        const sara = await person('sara');
        const ended = await job(sara, ours, async (id) => {
          await planEffect(id, { key: 'mail-1', kind: 'send' });
        });
        const later = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000);
        await prisma.computerGiveBackDecision.update({ where: { jobId: ended.id }, data: { nextAttemptAt: new Date(NOW.getTime() - 1000), decidedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000) } });
        await sweepComputers(later);
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', deliveredLate: false });
        // The database refuses the flag (a stand-in for any failure of that write)
        await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_refuse_delivered_late() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END; $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER test_refuse_delivered_late BEFORE UPDATE ON computer_give_back_decisions FOR EACH ROW WHEN (NEW.delivered_late IS TRUE) EXECUTE FUNCTION test_refuse_delivered_late()`);
        try {
          await expect(settleEffect(ended.id, 'mail-1', 'done', 'ali@example.test')).rejects.toThrow();
        } finally {
          await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_refuse_delivered_late ON computer_give_back_decisions');
          await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_refuse_delivered_late()');
        }
        // Nothing half-done: the effect is still planned and the give-back is as it was
        expect(await prisma.computerEffect.findFirstOrThrow({ where: { jobId: ended.id } })).toMatchObject({ state: 'planned' });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', deliveredLate: false });
        // Asked again, both are written, and the give-back stays
        expect(await settleEffect(ended.id, 'mail-1', 'done', 'ali@example.test')).toBe(true);
        expect(await prisma.computerEffect.findFirstOrThrow({ where: { jobId: ended.id } })).toMatchObject({ state: 'done' });
        expect(await decisionOf(ended.id)).toMatchObject({ state: 'given', basis: 'goodwill', deliveredLate: true });
        expect(await givenBack(ended.id)).toBe(true);
      });

      it('a provider fault the relay stamped in the future is not counted towards a pause yet', async () => {
        await limitsAre({ ...LAUNCH, pauseMinRuns: 2 });
        const route = 'universe-ai/model-clock';
        for (const name of ['c1', 'c2']) {
          const p = await person(name);
          const s = await startJob({ botId: p.brickId, personId: p.id, title: 'Failing' }, minutes(0));
          if (!s.ok) throw new Error('no');
          await recordFaults(p.brickId, s.job.id, [fault(1, 'provider_5xx', { route, at: new Date(Date.now() + 10 * 60_000) })]);
        }
        expect(await routeIsPaused(route, new Date())).toBe(false);
        expect(await routeIsPaused(route, new Date(Date.now() + 11 * 60_000))).toBe(true);
      });
    });

    describe('a Brick purged while a give-back still waits', () => {
      const purge = (brickId: string, now: Date) => jest.requireActual('@/lib/brick-purge').purgeBrick(brickId, now) as Promise<string>;
      const deleteBrick = (brickId: string, at: Date) => prisma.bot.update({ where: { id: brickId }, data: { deletedAt: at, goneAt: at, enabled: false, enabledBeforeDelete: true } });

      it('is never a final charge: a decision held for missing Limits is given back, uncounted, before the jobs and their rows are deleted', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending' });
        expect(await givenBack(held.id)).toBe(false);
        const at = minutes(10);
        await deleteBrick(sara.brickId, at);
        const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await purge(sara.brickId, minutes(120))).toBe('purged');
        spy.mockRestore();
        expect(await prisma.computerJob.count({ where: { id: held.id } })).toBe(0);
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'brick_purged' });
        // What the job took is not on the person any more
        expect(await givenBack(held.id)).toBe(true);
      });

      it('decides a decision held for an unconfirmed effect with the effect closed, by the goodwill rules, before the purge', async () => {
        await limitsAre(LAUNCH);
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, async (id) => {
          await recordFaults(sara.brickId, id, [fault(1, 'provider_5xx')]);
          await planEffect(id, { key: 'mail-1', kind: 'send' });
        });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'effect_unresolved' });
        await deleteBrick(sara.brickId, minutes(10));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await purge(sara.brickId, minutes(120))).toBe('purged');
        spy.mockRestore();
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'goodwill' });
        expect(await givenBack(held.id)).toBe(true);
      });

      it('gives back a decision whose job is already gone (purged before this fix), in the person’s favour and uncounted', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        const timeEvent = await timeOf(held.id);
        // The job is removed while its decision waits (an older purge)
        await prisma.computerJob.delete({ where: { id: held.id } });
        await sweepComputers(new Date(NOW.getTime() + 3 * 60 * 60_000));
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'job_removed' });
        expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: timeEvent.eventId } })).personKey).toBe('unknown');
      });
    });
  });
});
