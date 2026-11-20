/**
 * What a computer job that ended on our side is given back, against a real database (the bound on give-backs). Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-giveback-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { saveInstantLimits } from '@/lib/instant/state';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, planEffect, settleEffect, startJob, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
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
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'instant-limits'] } } });
};

let clock = 0;
/** A job that starts and then is ended as the runner says; every job in these tests runs 5 minutes. */
async function job(p: { id: string; brickId: string }, ending: { outcome: 'done' | 'failed'; cause?: 'ours' | 'agent' }, before?: (jobId: string) => Promise<void>) {
  const at = clock;
  clock += 10;
  const started = await startJob({ botId: p.brickId, personId: p.id, title: 'Job' }, minutes(at));
  if (!started.ok) throw new Error('the job did not start');
  if (before) await before(started.job.id);
  await finishJob(started.job.id, ending.outcome, minutes(at + 5), null, ending.cause ?? null);
  return prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } });
}
const ours = { outcome: 'failed' as const, cause: 'ours' as const };
const timeOf = (jobId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } });
const givenBack = async (jobId: string) => (await timeOf(jobId)).personKey === 'unknown';

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

  it('is still given back when an effect was only tried, or confirmed not done: nothing was delivered', async () => {
    const sara = await person('sara');
    const ended = await job(sara, ours, async (jobId) => {
      await planEffect(jobId, { key: 'mail-1', kind: 'send' });
      await settleEffect(jobId, 'mail-1', 'failed');
    });
    expect(await givenBack(ended.id)).toBe(true);
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

  it('bounds a failure Orbit saw itself too (a job whose room lapsed), not only one the runner reported', async () => {
    await limitsAre({ ...LAUNCH, goodwillPerPersonPerMonth: 1 });
    const sara = await person('sara');
    expect(await givenBack((await job(sara, ours)).id)).toBe(true);
    const lapsing = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, minutes(100));
    if (!lapsing.ok) throw new Error('no');
    expect(await sweepComputers(minutes(200))).toMatchObject({ stopped: 1 });
    expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: lapsing.job.id } })).toMatchObject({ status: 'failed', endedBy: null });
    expect(await givenBack(lapsing.job.id)).toBe(false);
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

  it('gives back as it always did when Limits carry no pause numbers at all (nothing to read a bound from)', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
    const sara = await person('sara');
    for (let n = 0; n < 4; n++) expect(await givenBack((await job(sara, ours)).id)).toBe(true);
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
});
