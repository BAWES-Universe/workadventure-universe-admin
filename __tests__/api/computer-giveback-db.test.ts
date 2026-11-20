/**
 * What a computer job that ended on our side is given back, against a real database (the bound on give-backs). Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-giveback-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

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
import { afterLateEvidence } from '@/lib/computer-giveback';
import { correctRouteTogether, giveBackOverview, giveBackReadiness, routeIsPaused } from '@/lib/computer-fault-ops';
import { mintJobToken } from '@/lib/computer-token';

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
async function job(p: { id: string; brickId: string }, ending: { outcome: 'done' | 'failed'; cause?: 'ours' | 'agent'; turns?: number[] }, before?: (jobId: string) => Promise<void>) {
  const at = clock;
  clock += 10;
  const started = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, minutes(at));
  if (!started.ok) throw new Error('the job did not start');
  if (before) await before(started.job.id);
  await finishJob(started.job.id, ending.outcome, minutes(at + 5), null, ending.cause ?? null, ending.turns);
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
      // A call on the person's own key is theirs whatever went wrong with it, even with a reason that is ours on our key
      const own = await job(sara, { ...ours, turns: [1] }, withFaults(sara, [fault(1, 'relay_down', { source: 'own-key' })]));
      expect(await decisionOf(own.id)).toMatchObject({ state: 'refused', basis: 'person_caused' });
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
      expect(await recordFaults(sara.brickId, id, [row])).toEqual({ stored: 1 });
      expect(await recordFaults(sara.brickId, id, [row])).toEqual({ stored: 0 });
      // The uncertain one turns out to be our fault: settled once; then it cannot move again
      expect(await recordFaults(sara.brickId, id, [{ ...row, kind: 'fault', reason: 'provider_key_ours' }])).toEqual({ stored: 1 });
      expect(await recordFaults(sara.brickId, id, [{ ...row, kind: 'not_ours', reason: 'allowance' }])).toEqual({ stored: 0 });
      expect(await prisma.computerJobFault.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ kind: 'fault', reason: 'provider_key_ours' });
      // A different Brick does not own the job; an unknown job is unknown
      expect(await recordFaults(other.brickId, id, [row])).toBeNull();
      expect(await recordFaults(sara.brickId, randomUUID(), [row])).toBeNull();
      expect(await prisma.computerJobFault.count({ where: { jobId: id } })).toBe(1);
    });
  });

  describe('one provider failing for many people', () => {
    it('pauses new platform-funded work on that route once as many jobs failed in the window as Instant’s smallest batch, never a person’s own key, and lifts by itself', async () => {
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
      // Many rows of one job are one job; a third job makes three
      await recordFaults(started[1].brickId, started[1].id, [fault(2, 'provider_429', { route })]);
      expect(await routeIsPaused(route)).toBe(false);
      await recordFaults(started[2].brickId, started[2].id, [fault(1, 'provider_5xx', { route })]);
      expect(await routeIsPaused(route)).toBe(true);
      expect((await giveBackOverview()).routes).toContainEqual({ route, failedJobs: 3, paused: true });
      // New platform-funded work waits (the relay answers busy, nothing is held); another route and the person's own key are untouched
      expect(await authorizeModelCall({ token, callId: 'p2', estimateMicros: 1_000, payer: 'universe', route }, new Date())).toEqual({ ok: false, reason: 'pool' });
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
      expect(await decisionOf(capped.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await decisionOf(held.id)).toMatchObject({ state: 'given', basis: 'incident' });
      expect(await givenBack(capped.id)).toBe(true);
      expect(await givenBack(held.id)).toBe(true);
      expect(await givenBack(theirs.id)).toBe(false);
      expect(await givenBack(delivered.id)).toBe(false);
      // None of them used the bound: they are incidents, not the person's goodwill
      expect(await prisma.computerJob.count({ where: { personId: sara.id, runnerFault: true } })).toBe(1);
      expect(await correctRouteTogether({ route, from: new Date(base.getTime() - 60_000), to: new Date(base.getTime() + 60_000) })).toEqual({ corrected: 0, costMicros: 0 });
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
      expect(overview.routes).toContainEqual({ route: 'universe-ai/model-o', failedJobs: 1, paused: false });
      expect(held.id).toBeTruthy();
    });
  });
});
