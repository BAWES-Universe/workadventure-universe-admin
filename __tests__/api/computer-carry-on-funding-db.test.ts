/**
 * GPT round 6, finding 5: a job its month or a limit paused carries on by itself only once WHAT WAS REFUSED fits again (a model call's estimate on top of the room to run), so unchanged funds restart nothing;
 * the person's own Pause of such a job makes it their pause (never carried on by itself); "back in line" is told while it waits, "carrying on" only in the write that sets it running. Each case asserts the job,
 * its stretch, its rooms and holds, its time events and the messages. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database, in UTC and in Kuwait time:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-carry-on-funding-db.test.ts --runInBand
 *   TZ=Asia/Kuwait ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-carry-on-funding-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn((...args: unknown[]) => actual.recordMeterEvent(...args)) };
});
// The funding look is the real one behind a jest.fn: a test runs something between that look and the write that carries a job on
jest.mock('@/lib/meter-allowance', () => {
  const actual = jest.requireActual('@/lib/meter-allowance');
  return { ...actual, roomWouldFit: jest.fn((...args: unknown[]) => actual.roomWouldFit(...args)) };
});
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import * as allowanceModule from '@/lib/meter-allowance';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, controlInternals, finishJobUnder, giveComputer, renewJob, startJob, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { carryOnPaused } from '@/lib/computer-limit-pause';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';
import { createGiftFor } from '@/lib/grants-admin';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
/** The pretend provider's price: 6,000 micros a minute, so a 10-minute room is 60,000. */
const PER_MINUTE = 6_000;
const ACCEPTS = ['paused', 'carried_on', 'can_carry_on'];
let issuer: { userId: string; superAdmin: true };

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, rolloutBudgetMicros: 1_000_000_000_000, ...over }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_refunds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_allocations');
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_lots');
  await prisma.$executeRawUnsafe('DELETE FROM grant_recipients');
  await prisma.$executeRawUnsafe('DELETE FROM grant_rules');
  await prisma.$executeRawUnsafe('DELETE FROM grant_programs');
  await prisma.spendRule.deleteMany({ where: { ownerPersonId: { in: people } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const timeEvents = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const tellings = (jobId: string) => prisma.computerJobTelling.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};
const keyFor = async (jobId: string, epoch: number, at: Date = NOW) => ((await mintJobToken(jobId, 'model', at, { generation: (await jobOf(jobId)).controlGeneration }, { epoch })) as { ok: true; token: string }).token;
const ask = (token: string, callId: string, over: Partial<Parameters<typeof authorizeModelCall>[0]> = {}, at: Date = NOW) => authorizeModelCall({ token, callId, estimateMicros: 5_000, payer: 'universe', turn: 1, run: 'rA', ...over }, at);
const settle = (jobId: string, callId: string, cost: number, at: Date) => settleModelCall(jobId, callId, { costMicros: cost, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, at);
const rule = (sara: { id: string; brickId: string }, capMicros: number) =>
  prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(capMicros), words: 'Never more than this a day', createdById: sara.id } });
const gift = (userId: string, amountMicros: number) =>
  createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [userId] }, scope: 'computers', amountMicros, shared: false, endsAt: new Date(NOW.getTime() + 40 * 86_400_000).toISOString() } as never, issuer, NOW);
const told = async (at: Date) => (await reportsToTell(50, at, { accepts: ACCEPTS })).filter((one) => ACCEPTS.includes(one.kind));

/** A person with a Brick with a computer and one job running on it since `at`, claimed by run rA. */
async function running(name: string, at: Date = NOW) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, at);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  const epoch = await claimed(started.job.id, 'rA', at);
  return { sara, jobId: started.job.id, epoch };
}

run('finding 5 (GPT round 6): carrying on only when what was refused fits, in a real database', () => {
  let fake: FakeComputerProvider;
  beforeAll(async () => {
    process.env.COMPUTER_PROVIDER = 'fake';
    const admin = await prisma.user.create({ data: { uuid: `lp-admin-${tag}`, email: `lp-admin-${tag}@example.test`, name: 'Admin' } });
    people.push(admin.id);
    issuer = { userId: admin.id, superAdmin: true };
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  const credits = (personId: string) => prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM credit_holds WHERE person_id = ${personId}`.then((rows) => Number(rows[0].n));
  const roomsOf = (personId: string) => prisma.meterReservation.count({ where: { personId } });
  /** A job paused because a 900,000 model call did not fit what was left of the month (1,000,000 a month, 300,000 used by a call before). */
  async function pausedByBigCall(name: string) {
    const ran = await running(name);
    const k = await keyFor(ran.jobId, ran.epoch);
    expect(await ask(k, 'c-small', { estimateMicros: 300_000 })).toMatchObject({ ok: true });
    await settle(ran.jobId, 'c-small', 300_000, minutes(1));
    expect(await ask(k, 'c-big', { estimateMicros: 900_000 }, minutes(2))).toEqual({ ok: false, reason: 'allowance' });
    expect(await jobOf(ran.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
    return ran;
  }

  describe('finding 5 (GPT round 6): a carry-on remembers what blocked it', () => {
    it('REPRO: a 5,000,000 call refused for the allowance, funds unchanged: N sweeps make ZERO time events, ZERO holds and ZERO rooms; the job stays paused and the pause keeps what was refused', async () => {
      const { sara, jobId, epoch } = await running('f5-big');
      const k = await keyFor(jobId, epoch);
      expect(await ask(k, 'c-huge', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      const pause = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } });
      expect(pause).toMatchObject({ why: 'allowance', blockedKind: 'call', blockedMicros: BigInt(5_000_000), blockedMonth: '2026-11' });
      expect(pause.blockedRuleRev).toMatch(/^[0-9a-f]{64}$/);
      const before = { events: (await timeEvents(jobId)).length, rooms: await roomsOf(sara.id), holds: await credits(sara.id), epoch: (await jobOf(jobId)).ownerEpoch };
      for (let sweep = 0; sweep < 4; sweep++) {
        expect(await carryOnPaused(minutes(3 + sweep))).toBe(0);
        await sweepComputers(minutes(3 + sweep));
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', pauses: 1, reservationKey: null, ownerEpoch: before.epoch });
      expect((await timeEvents(jobId)).length).toBe(before.events);
      expect(await roomsOf(sara.id)).toBe(before.rooms);
      expect(await credits(sara.id)).toBe(before.holds);
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused']);
    });

    it('CodeRabbit on #1025 (55): the estimate belongs to one pause: a job paused again between the estimate and the flip is not carried on with the earlier pause’s estimate', async () => {
      const { jobId, epoch } = await running('f5-55');
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      await setUp();
      const real = jest.requireActual('@/lib/meter-allowance').roomWouldFit as typeof allowanceModule.roomWouldFit;
      // While the funding is being looked at, the job is resumed and paused again by a limit (its pause number moves on)
      let estimated: unknown = 'not asked';
      (allowanceModule.roomWouldFit as jest.Mock).mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        const answer = await real(...args);
        // The funding look itself passed (null: it would fit): the refusal below can only be the pause number
        estimated = answer;
        const first = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } });
        // ...a second pause of the same kind is on record, with a bigger refused call than the first one's estimate
        await prisma.computerJobPause.create({ data: { jobId, n: 2, why: 'allowance', seconds: 0, at: first.at, grantsPrint: first.grantsPrint, heldScreen: false, blockedKind: 'call', blockedMicros: BigInt(5_000_000), blockedMonth: first.blockedMonth } });
        await prisma.computerJob.update({ where: { id: jobId }, data: { pauses: 2 } });
        return answer;
      });
      expect(await carryOnPaused(minutes(6))).toBe(0);
      expect(estimated).toBeNull();
      // The second pause is the one that is stored: the sweep did not stop at an unrelated refusal before the estimate
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', carryOnPending: false, pauses: 2 });
    });

    it('CodeRabbit on #1025 (56): a start that rejects after the carry-on committed still leaves the `back_in_line` telling (the job stays in line with its mark set, and nothing else would tell)', async () => {
      const { jobId, epoch } = await running('f5-56');
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      await setUp();
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
        throw new Error('the database went away');
      });
      const mute = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await carryOnPaused(minutes(6))).toBe(0);
      } finally {
        spy.mockRestore();
        mute.mockRestore();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', carryOnPending: true });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'back_in_line']);
    });

    it('a renewal refused for the month keeps `renewal` and its room; with the room back it carries on (only the room to run is needed)', async () => {
      const { jobId, epoch } = await running('f5-renewal');
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).toMatchObject({ blockedKind: 'renewal', blockedMicros: BigInt(10 * PER_MINUTE) });
      await setUp();
      expect(await carryOnPaused(minutes(6))).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });

    it.each([
      ['a top-up (a credit gift)', async (sara: { id: string; brickId: string }) => void (await gift(sara.id, 10_000_000)), minutes(4)],
      ['a new month', async () => undefined, new Date('2026-12-01T00:05:00Z')],
    ])('%s that lets the refused call fit carries it on ONCE: one new room, then nothing more', async (_what, more, at) => {
      const { sara, jobId } = await pausedByBigCall(`f5-more-${++made}`);
      expect(await carryOnPaused(minutes(3))).toBe(0);
      await more(sara);
      expect(await carryOnPaused(at)).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', queuedFor: null, pausedWhy: null, carryOnPending: false });
      expect(await carryOnPaused(new Date(at.getTime() + 60_000))).toBe(0);
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'carried_on']);
    });

    it('a limit raised so the refused call fits carries it on once; a limit raised only enough to run (not for the call) does not', async () => {
      const { sara, jobId, epoch } = await running('f5-rule');
      const r = await rule(sara, 500_000);
      const k = await keyFor(jobId, epoch);
      expect(await ask(k, 'c-big', { estimateMicros: 900_000 })).toMatchObject({ ok: false, reason: 'rule' });
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).toMatchObject({ why: 'rule', blockedKind: 'call', blockedMicros: BigInt(900_000) });
      // 600,000 lets the job run a stretch (its room is 60,000) but not the 900,000 call it stopped at: it stays paused, nothing is written
      await prisma.spendRule.update({ where: { id: r.id }, data: { capMicros: BigInt(600_000), version: { increment: 1 } } });
      expect(await carryOnPaused(minutes(3))).toBe(0);
      expect(await roomsOf(sara.id)).toBe(1);
      // 930,000 fits the call (900,000) on top of what the job has already used, but NOT the call plus the new room (60,000): a check of the call alone would carry it on, and it must not (CodeRabbit on #1025, 34)
      await prisma.spendRule.update({ where: { id: r.id }, data: { capMicros: BigInt(930_000), version: { increment: 1 } } });
      expect(await carryOnPaused(minutes(3))).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule' });
      expect(await roomsOf(sara.id)).toBe(1);
      await prisma.spendRule.update({ where: { id: r.id }, data: { capMicros: BigInt(10_000_000), version: { increment: 1 } } });
      expect(await carryOnPaused(minutes(4))).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });

    it('round 8, C (Opus’s design: the same admission check for every way a job starts): the person’s Resume while the refused call would not fit is answered with the reason, and nothing is held or booked; once it fits, Resume starts it', async () => {
      const { sara, jobId } = await pausedByBigCall('f5-manual');
      const before = { events: (await timeEvents(jobId)).length, rooms: await roomsOf(sara.id) };
      const resumed = await resumeJob(sara.brickId, sara.id, jobId, minutes(3));
      expect(resumed).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', reservationKey: null });
      expect((await timeEvents(jobId)).length).toBe(before.events);
      expect(await roomsOf(sara.id)).toBe(before.rooms);
      await setUp({ memberAllowanceMicros: 5_000_000 });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(4))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pausedWhy: null });
    });
  });

  describe('finding 5: the person’s own Pause of a limit-paused job is THEIR pause', () => {
    it('REPRO: Pause on a job the month paused answers ok and records `person`; the sweep never carries it on, even once funds arrive; their Resume does', async () => {
      const { sara, jobId } = await pausedByBigCall('f5-promote');
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(3))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
      await gift(sara.id, 10_000_000);
      expect(await carryOnPaused(minutes(4))).toBe(0);
      await sweepComputers(minutes(5));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
      expect((await timeEvents(jobId)).length).toBe(1);
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(6))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });

    it('the `paused` message of the month is not said once the person made it their own pause', async () => {
      const { sara, jobId } = await pausedByBigCall('f5-promote-told');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(3));
      expect((await told(minutes(4))).filter((one) => one.jobId === jobId)).toEqual([]);
    });
  });

  describe('finding 5: "back in line" while queued, "carrying on" only when running', () => {
    it('REPRO: a carry-on behind another job on the same computer is told `back_in_line`, never `carried_on`; `carried_on` comes in the write that sets it running, once', async () => {
      const { sara, jobId, epoch } = await running('f5-line');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      // Another job takes the computer while it waits
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hotel' }, minutes(6));
      if (!other.ok) throw new Error('no job');
      expect(other.job.status).toBe('running');
      expect(await carryOnPaused(minutes(7))).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', carryOnPending: true });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'back_in_line']);
      const offered = await reportsToTell(50, minutes(8), { accepts: [...ACCEPTS, 'back_in_line'] });
      expect(offered.filter((one) => one.jobId === jobId).map((one) => one.kind)).toEqual(['back_in_line']);
      // An older reader that does not say it understands the kind is never sent it
      expect((await told(minutes(8))).filter((one) => one.jobId === jobId)).toEqual([]);
      // Another sweep while it waits: told nothing again
      await carryOnPaused(minutes(9));
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'back_in_line']);
      // The other job ends: the line moves and THIS write tells `carried_on`, once
      await finishJobUnder(other.job.id, null, 'done', minutes(10));
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', carryOnPending: false });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'back_in_line', 'carried_on']);
      const now = await reportsToTell(50, minutes(11), { accepts: [...ACCEPTS, 'back_in_line'] });
      expect(now.filter((one) => one.jobId === jobId).map((one) => one.kind)).toEqual(['carried_on']);
    });

    it('CONTROL: a person’s own Resume that queues is not told back to them (no back_in_line, no carried_on)', async () => {
      const { sara, jobId } = await running('f5-resume-line');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2));
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hotel' }, minutes(3));
      if (!other.ok) throw new Error('no job');
      await resumeJob(sara.brickId, sara.id, jobId, minutes(4));
      await finishJobUnder(other.job.id, null, 'done', minutes(5));
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await tellings(jobId)).toEqual([]);
    });

    it('N11: a reader that accepts only `carried_on` gets it when an older `paused` telling of another job (which it cannot say) would take the only place of a batch of one', async () => {
      // A: paused by a spending rule it keeps hitting (so it stays paused, with its `paused` telling the oldest)
      const a = await running('n11-a');
      await rule(a.sara, 1_000);
      await renewJob(a.jobId, minutes(5), { epoch: a.epoch });
      expect(await jobOf(a.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule' });
      // B: paused by the month, then carried on by itself: `paused`, then `carried_on`
      const b = await running('n11-b');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(b.jobId, minutes(6), { epoch: b.epoch });
      await setUp();
      await carryOnPaused(minutes(7));
      expect(await jobOf(b.jobId)).toMatchObject({ status: 'running' });
      expect((await tellings(b.jobId)).map((one) => one.kind)).toEqual(['paused', 'carried_on']);
      // A batch of ONE, for a reader that says only `carried_on`: it is B's `carried_on`, never nothing because A's older `paused` held the place
      const only = await reportsToTell(1, minutes(8), { accepts: ['carried_on'] });
      expect(only.filter((one) => one.kind === 'carried_on').map((one) => one.jobId)).toEqual([b.jobId]);
      // CONTROL: A's `paused` is still there for a reader that says it understands it
      const both = await reportsToTell(50, minutes(8), { accepts: ACCEPTS });
      expect(both.filter((one) => one.jobId === a.jobId).map((one) => one.kind)).toEqual(['paused']);
    });

    it('a `carried_on` is not told of a job the PERSON paused again after it carried on (a person pause makes no newer telling)', async () => {
      const { sara, jobId, epoch } = await running('n11-again');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      await carryOnPaused(minutes(6));
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'carried_on']);
      await claimed(jobId, 'rB', minutes(6));
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(7))).ok).toBe(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
      expect((await told(minutes(8))).filter((one) => one.jobId === jobId)).toEqual([]);
      // CONTROL: a job that carried on and is still running is told
      const still = await running('n11-still');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(still.jobId, minutes(5), { epoch: still.epoch });
      await setUp();
      await carryOnPaused(minutes(6));
      expect((await told(minutes(8))).filter((one) => one.jobId === still.jobId).map((one) => one.kind)).toEqual(['carried_on']);
    });

    it('CodeRabbit on #1025 (58): a confirmation names the kind of the telling it confirms: another kind’s number changes nothing, the right one confirms, and a correct repeat still succeeds', async () => {
      const { jobId, epoch } = await running('cr58');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      const [paused] = await tellings(jobId);
      expect(paused).toMatchObject({ kind: 'paused', toldAt: null });
      expect(await keepReportTold(jobId, 'back_in_line', paused.seq, { delivered: true }, minutes(6))).toBe(false);
      expect((await tellings(jobId))[0].toldAt).toBeNull();
      expect(await keepReportTold(jobId, 'paused', paused.seq, { delivered: true }, minutes(6))).toBe(true);
      expect((await tellings(jobId))[0].toldAt).not.toBeNull();
      expect(await keepReportTold(jobId, 'paused', paused.seq, { delivered: true }, minutes(7))).toBe(true);
      expect(await keepReportTold(jobId, 'carried_on', paused.seq, { delivered: true }, minutes(7))).toBe(false);
    });

    it('CodeRabbit on #1025 (57): a `carried_on` that was not told yet is let go by the person’s Pause, so a manual Resume afterwards (into a busy queue or onto the computer) never makes it say the job is carrying on', async () => {
      const { sara, jobId, epoch } = await running('cr57');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      await carryOnPaused(minutes(6));
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'carried_on']);
      await claimed(jobId, 'rB', minutes(6));
      // The person pauses before the telling is polled, and resumes by hand: the computer is busy with another job of theirs, so this one waits in line
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(7))).ok).toBe(true);
      expect((await prisma.computerJobTelling.findFirstOrThrow({ where: { jobId, kind: 'carried_on' } })).staleAt).not.toBeNull();
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Other', writes: true }, minutes(7));
      if (!other.ok) throw new Error('the other job was not made');
      expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(8))).ok).toBe(true);
      expect((await told(minutes(9))).filter((one) => one.jobId === jobId)).toEqual([]);
      // ...and a `carried_on` is never told of a job that waits in line, whatever its row says
      await prisma.computerJobTelling.updateMany({ where: { jobId, kind: 'carried_on' }, data: { staleAt: null } });
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'queued', queuedFor: 'busy', pausedAt: null, pausedWhy: null } });
      expect((await told(minutes(10))).filter((one) => one.jobId === jobId && one.kind === 'carried_on')).toEqual([]);
    });
  });
});
