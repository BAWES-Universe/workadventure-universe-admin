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
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { saveInstantLimits } from '@/lib/instant/state';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, planEffect, settleEffect, startJob, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { recordFaults, type FaultInput } from '@/lib/computer-faults';
import { afterLateEvidence, decidePendingForPurge, decideRunnerFinish, lockPerson, resolveDecision, sweepGiveBackDecisions, sweepLateEvidence } from '@/lib/computer-giveback';
import { correctRouteTogether, giveBackOverview, giveBackReadiness, routeIsPaused } from '@/lib/computer-fault-ops';
import { mintJobToken, revokeJobTokens } from '@/lib/computer-token';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
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
async function job(p: { id: string; brickId: string }, ending: { outcome: 'done' | 'failed'; cause?: 'ours' | 'agent'; turns?: number[]; run?: string }, before?: (jobId: string) => Promise<void>) {
  const at = clock;
  clock += 10;
  const started = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, minutes(at));
  if (!started.ok) throw new Error('the job did not start');
  if (before) await before(started.job.id);
  await finishJob(started.job.id, ending.outcome, minutes(at + 5), null, ending.cause ?? null, ending.turns, ending.run);
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
      // Their own provider failing on their own key is theirs
      const own = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'own_provider', { source: 'own-key' })]));
      expect(await decisionOf(own.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
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

    it('never lets a late row take a give-back back, or turn a job the runner did not report as ours into a give-back', async () => {
      await limitsAre(LAUNCH);
      const sara = await person('sara');
      const given = await job(sara, { ...ours, turns: [1] });
      await recordFaults(sara.brickId, given.id, [fault(1, 'allowance')]);
      await afterLateEvidence(given.id);
      expect(await givenBack(given.id)).toBe(true);
      const agent = await job(sara, { outcome: 'failed', cause: 'agent', turns: [1] });
      await recordFaults(sara.brickId, agent.id, [fault(1, 'provider_key_ours')]);
      await afterLateEvidence(agent.id);
      expect(await givenBack(agent.id)).toBe(false);
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

    it('corrects every affected job together: held and cap-refused ones are given back uncounted, delivered and person-caused ones are left alone, and it is safe to say twice', async () => {
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
      expect(result.corrected).toBe(2);
      // The goodwill one given back before the incident was known is freed from the bound too (it was the provider's)
      expect(result.uncounted).toBe(1);
      expect(await decisionOf(first.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(capped.id)).toBe(true);
      expect(await givenBack(held.id)).toBe(true);
      expect(await givenBack(theirs.id)).toBe(false);
      expect(await givenBack(delivered.id)).toBe(false);
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
          });
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

      it('a retry that read a decision as pending decides nothing over one an incident correction made while it waited for the person’s lock', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending', basis: 'limits_missing' });
        // The Limits are set now and would refuse it (a bound of 0 is no bound set, so use a spent one)
        await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        let retry: Promise<string> = Promise.resolve('none');
        await prisma.$transaction(async (tx) => {
          await lockPerson(tx, sara.id);
          retry = resolveDecision(held.id, minutes(30));
          await new Promise((resolve) => setTimeout(resolve, 500));
          await tx.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { state: 'given', basis: 'incident', route: 'r', nextAttemptAt: null } });
        });
        expect(await retry).toBe('none');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      });

      it('the same for a decision whose job is gone: a decision made while it waited for the lock stands', async () => {
        await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
        const sara = await person('sara');
        const held = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx')]));
        await prisma.computerJob.delete({ where: { id: held.id } });
        let retry: Promise<string> = Promise.resolve('none');
        await prisma.$transaction(async (tx) => {
          await lockPerson(tx, sara.id);
          retry = resolveDecision(held.id, minutes(30));
          await new Promise((resolve) => setTimeout(resolve, 500));
          await tx.computerGiveBackDecision.update({ where: { jobId: held.id }, data: { state: 'given', basis: 'incident', route: 'r', nextAttemptAt: null } });
        });
        expect(await retry).toBe('none');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
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
        expect(await givenBack((await job(sara, ours)).id)).toBe(true);
        const refused: string[] = [];
        for (let index = 0; index < 3; index++) {
          const ended = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'provider_5xx', { route })]));
          expect(await decisionOf(ended.id)).toMatchObject({ state: 'refused', basis: 'cap' });
          refused.push(ended.id);
        }
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) }, 1)).toMatchObject({ corrected: 3 });
        for (const id of refused) expect(await decisionOf(id)).toMatchObject({ state: 'given', basis: 'incident' });
        // Said twice it changes nothing
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) }, 1)).toMatchObject({ corrected: 0, uncounted: 0 });
      });

      it('an incident correction leaves a job alone whose outside effect was delivered while its decision waited: it stays pending and is decided by its evidence', async () => {
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
        expect(await correctRouteTogether({ route, from: minutes(-60), to: minutes(600) })).toMatchObject({ corrected: 0, uncounted: 0 });
        expect(await decisionOf(held.id)).toMatchObject({ state: 'pending' });
        expect(await givenBack(held.id)).toBe(false);
        expect(await resolveDecision(held.id, minutes(30))).toBe('resolved');
        expect(await decisionOf(held.id)).toMatchObject({ state: 'refused', basis: 'delivered' });
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
