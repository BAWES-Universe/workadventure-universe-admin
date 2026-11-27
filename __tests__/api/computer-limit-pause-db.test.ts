/**
 * Piece 3 of the computer job controls: out of the month's computer time, or over a spending limit the person set, PAUSES a job instead of ending it, each stretch is charged on its own, a later fault of ours
 * gives back only the faulty stretch, and a paused job carries on by itself when more arrives. Opus's acceptance cases C5, C6 and C7 (release-0-5-0/opus-controls-acceptance-23-nov.md), each with its control and a
 * check that what should be left intact is. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database, in UTC and in Kuwait time:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-limit-pause-db.test.ts --runInBand
 *   TZ=Asia/Kuwait ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-limit-pause-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn((...args: unknown[]) => actual.recordMeterEvent(...args)) };
});
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })), wipeLiveProfile: jest.fn((...args: unknown[]) => actual.wipeLiveProfile(...args)) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { heldRoom, memberAllowance } from '@/lib/meter-allowance';
import * as meterModule from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, computerTimeInBooks, finishJobUnder, getJob, giveComputer, recordFinishIntent, renewJob, runnableJobsPage, startJob, stopJobFor, setWakeTimingForTests, sweepComputers, takeOver, takeWakeTicketForTests } from '@/lib/computer';
import { authorizeModelCall, callRoomKey, settleModelCall } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { recordPoolCutoff } from '@/lib/computer-faults';
import { cancelJob, pauseEventId, pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { carryOnPaused, pauseForLimit, resetCarryOnScanForTests } from '@/lib/computer-limit-pause';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';
import { createGiftFor } from '@/lib/grants-admin';
import { callInLastStretch } from '@/lib/computer-stretch';
import * as profiles from '@/lib/computer-browser-profile';

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

/** The wake of this Brick's machine that is in flight is older than a start can take (no start is behind it any more): another start wakes the machine itself instead of waiting for it (round 8, B1). */
const ageWake = (botId: string) => prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "bot_id" = ${botId}`;
const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const timeEvents = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const liveKeys = (jobId: string) => prisma.computerJobToken.count({ where: { jobId, revokedAt: null } });
const tellings = (jobId: string) => prisma.computerJobTelling.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  // A job that already has an owner is claimed only once that owner stopped beating (GPT round 6, finding 3): the hold is let go first, as it runs out by itself 90 s after the owner's last beat
  await prisma.computerJob.updateMany({ where: { id: jobId, NOT: { ownerLeaseUntil: null } }, data: { ownerLeaseUntil: null } });
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

run('out of time or over a limit pauses, per-stretch charging, carrying on by itself (piece 3), in a real database', () => {
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
    resetCarryOnScanForTests();
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

  describe('C5: a renewal or a call refused for the month or a limit pauses the job, under the same conditions an ending had', () => {
    it('C5.1 a renewal with no room in the month PAUSES (allowance): the stretch is charged once on its own event, the unused room goes back, epoch and keys move, the turn is cancelled after, Brick tells once', async () => {
      const { sara, jobId, epoch } = await running('c5-allow');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1', agentSessionId: 'sess-1' } });
      await keyFor(jobId, epoch);
      const room = (await jobOf(jobId)).reservationKey!;
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, endedAt: null, pauses: 1, secondsRun: 0, secondsBilled: 300, reservationKey: null, agentSessionId: 'sess-1', ownerEpoch: epoch + 1 });
      expect(await liveKeys(jobId)).toBe(0);
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room } })).toMatchObject({ state: 'settled', settledMicros: BigInt(5 * PER_MINUTE) });
      expect(await prisma.meterReservation.count({ where: { jobId, state: 'held' } })).toBe(0);
      const events = await timeEvents(jobId);
      expect(events.map((one) => [one.eventId, one.costMicros, one.personId])).toEqual([[pauseEventId(jobId, 1), BigInt(5 * PER_MINUTE), sara.id]]);
      expect(fake.cancelledTurns).toEqual(['resp-1']);
      // Brick tells once, with what paused it and nothing else
      expect((await tellings(jobId)).map((one) => [one.kind, one.why])).toEqual([['paused', 'allowance']]);
      const said = await told(minutes(6));
      expect(said).toEqual([expect.objectContaining({ jobId, kind: 'paused', pausedWhy: 'allowance', seq: 1, key: `computer-told:${jobId}:paused:1`, title: 'Visa form' })]);
      // A reader that does not say it understands it is never sent it
      expect((await reportsToTell(50, minutes(6))).filter((one) => one.jobId === jobId)).toEqual([]);
      expect(await keepReportTold(jobId, 'paused', 1)).toBe(true);
      expect(await told(minutes(7))).toEqual([]);
      // The old worker is replaced: its next renewal is superseded and changes nothing
      expect(await renewJob(jobId, minutes(6), { epoch })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await timeEvents(jobId)).toHaveLength(1);
    });

    it('C5.1 a renewal over a spending limit the person set PAUSES (rule); CONTROL: with room it renews', async () => {
      const ctl = await running('c5-rule-ctl');
      expect(await renewJob(ctl.jobId, minutes(5), { epoch: ctl.epoch })).toMatchObject({ ok: true });
      const { sara, jobId, epoch } = await running('c5-rule');
      await rule(sara, 10);
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'rule' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule', endedBy: null });
      expect((await tellings(jobId)).map((one) => [one.kind, one.why])).toEqual([['paused', 'rule']]);
      expect(await jobOf(ctl.jobId)).toMatchObject({ status: 'running' });
    });

    it('C5.1 the owner’s model call refused for the month or a rule PAUSES the job (the call is refused as before); the other job is left intact', async () => {
      const other = await running('c5-call-other');
      const { jobId, epoch } = await running('c5-call');
      const k = await keyFor(jobId, epoch);
      expect(await ask(k, 'c-big', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, ownerEpoch: epoch + 1 });
      expect(await liveKeys(jobId)).toBe(0);
      const ruled = await running('c5-call-rule');
      const kr = await keyFor(ruled.jobId, ruled.epoch);
      await rule(ruled.sara, 100);
      expect(await ask(kr, 'c-big', { estimateMicros: 5_000_000 })).toMatchObject({ ok: false, reason: 'rule' });
      expect(await jobOf(ruled.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule', endedBy: null });
      expect(await jobOf(other.jobId)).toMatchObject({ status: 'running', ownerEpoch: other.epoch });
    });

    it('C5.2 a refusal for an OLD epoch or a key that ended pauses nothing: the owner’s key, room and job stay as they were', async () => {
      const { jobId, epoch } = await running('c5-old');
      const old = await keyFor(jobId, epoch);
      const oldKey = await prisma.computerJobToken.findFirstOrThrow({ where: { jobId, revokedAt: null } });
      const eb = await claimed(jobId, 'rB', minutes(1));
      const b = await keyFor(jobId, eb, minutes(1));
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: (await jobOf(jobId)).reservationKey! } });
      expect(await pauseForLimit(jobId, 'allowance', minutes(2), { epoch, tokenId: oldKey.id })).toBe('not');
      // The old worker's renewal at the limit: superseded, nothing paused
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(2), { epoch })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', ownerEpoch: eb, pauses: 0 });
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room.reservationKey } })).toMatchObject({ state: 'held', amountMicros: room.amountMicros });
      expect((await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: eb })).ok).toBe(true);
      expect(old).not.toEqual(b);
      const bKey = await prisma.computerJobToken.findFirstOrThrow({ where: { jobId, revokedAt: null, ownerEpoch: eb } });
      // The epoch is checked on its own too: a refusal that names the OLD epoch pauses nothing even with a key that is live, and one that names no epoch at all pauses only a job nobody claimed
      expect(await pauseForLimit(jobId, 'allowance', minutes(2), { epoch, tokenId: bKey.id })).toBe('not');
      expect(await pauseForLimit(jobId, 'allowance', minutes(2))).toBe('not');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', ownerEpoch: eb, pauses: 0 });
      // A key of the current owner that was ended before its refusal decides nothing either
      await prisma.computerJobToken.update({ where: { id: bKey.id }, data: { revokedAt: minutes(2) } });
      expect(await pauseForLimit(jobId, 'allowance', minutes(3), { epoch: eb, tokenId: bKey.id })).toBe('not');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0 });
      expect(await tellings(jobId)).toEqual([]);
    });

    it('C5.3 a kept intent wins over the month: the renewal is `ending` and the job ends as the intent says; a decided pool cutoff wins too and ends as `pool`, given back (E6)', async () => {
      const { jobId, epoch } = await running('c5-intent');
      expect(await recordFinishIntent(jobId, { outcome: 'done', why: null, cause: null, turns: [], run: 'rA', epoch } as never, minutes(4))).toMatchObject({ ok: true });
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'ending' });
      const k = await prisma.computerJobToken.count({ where: { jobId } });
      expect(k).toBe(0);
      expect(await pauseForLimit(jobId, 'allowance', minutes(5), { epoch, tokenId: 'none' })).toBe('not');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0 });
      await finishJobUnder(jobId, null, 'failed', minutes(6), null, null, null, 'rA', epoch);
      expect(await jobOf(jobId)).toMatchObject({ status: 'done', pauses: 0 });
      await setUp();
      const cut = await running('c5-cutoff');
      const kc = await keyFor(cut.jobId, cut.epoch);
      await recordPoolCutoff(prisma, cut.jobId, minutes(3));
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(cut.jobId, minutes(5), { epoch: cut.epoch })).toEqual({ ok: false, reason: 'ending' });
      expect(await ask(kc, 'c-big', { estimateMicros: 5_000_000 }, minutes(5))).toMatchObject({ ok: false });
      expect(await jobOf(cut.jobId)).toMatchObject({ pauses: 0 });
      expect((await jobOf(cut.jobId)).queuedFor).not.toBe('paused');
    });

    it('C5.4 our own pool being full ends the job as ours, given back, exactly as before (never a pause)', async () => {
      const { jobId, epoch } = await running('c5-pool');
      await setUp({ poolCeilingMicros: 1 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'pool' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', pauses: 0 });
      expect(await tellings(jobId)).toEqual([]);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } })).personKey).toBe('unknown');
    });

    it('C5.5 a call made with the paused job’s old key is refused: nothing is held for it and no admission is kept', async () => {
      const { jobId, epoch } = await running('c5-after');
      const k = await keyFor(jobId, epoch);
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toMatchObject({ reason: 'paused' });
      await setUp();
      expect(await ask(k, 'c-after', {}, minutes(6))).toEqual({ ok: false, reason: 'refused' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'c-after') } })).toBe(0);
      expect(await prisma.computerJobFault.count({ where: { jobId, callId: { contains: 'c-after' } } })).toBe(0);
    });

    it('C5.8 the person holds the screen (section 7): the month takes the screen back and PAUSES the job, marked held; Brick says the held-screen line once; it never carries on by itself (Brick asks once); on Resume it asks the person again', async () => {
      const { sara, jobId, epoch } = await running('c5-person');
      expect((await takeOver(sara.brickId, sara.id, minutes(1))).ok).toBe(true);
      const held = await jobOf(jobId);
      expect(held).toMatchObject({ control: 'person', status: 'waiting' });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).controlState).toBe('human_ready');
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch: held.ownerEpoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      // One write: paused (never ended), Brick's again, its stretch charged on its own event, nothing held, every key ended, the owner moved
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, control: 'brick', pauses: 1, reservationKey: null, ownerEpoch: held.ownerEpoch + 1 });
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).toMatchObject({ why: 'allowance', heldScreen: true });
      expect(await prisma.meterEvent.count({ where: { eventId: pauseEventId(jobId, 1) } })).toBe(1);
      expect(await liveKeys(jobId)).toBe(0);
      // The screen is taken back: the computer is no longer the person's (on its way back to Brick's, as when a job they held ends)
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).controlState).not.toBe('human_ready');
      // Told once, with the held-screen mark (the game says the held-screen line in place of the usual one)
      const said = (await told(minutes(6))).filter((one) => one.jobId === jobId);
      expect(said).toEqual([expect.objectContaining({ kind: 'paused', pausedWhy: 'allowance', heldScreen: true, seq: 1 })]);
      await keepReportTold(jobId, 'paused', 1);
      // More arrives: it does not carry on by itself; Brick asks once, and only once
      await setUp();
      expect(await carryOnPaused(minutes(7))).toBe(0);
      expect(await carryOnPaused(minutes(8))).toBe(0);
      await sweepComputers(minutes(9));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'can_carry_on']);
      expect((await told(minutes(10))).filter((one) => one.jobId === jobId).map((one) => [one.kind, one.heldScreen])).toEqual([['can_carry_on', undefined]]);
      // The person says yes (Resume): it runs again on a new room, and its runner is told to ask the person for their step again
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', control: 'brick' });
      expect(await getJob(jobId)).toMatchObject({ resumed: true, askAgain: true });
      expect(epoch).toBeGreaterThan(0);
    });

    it('C5.8 a spending limit while the person holds the screen pauses too (rule, held); a kept intent still wins over it; the pool still ENDS; CONTROL: a pause with the screen not held is not marked and asks nothing again', async () => {
      const ruled = await running('c5-person-rule');
      await takeOver(ruled.sara.brickId, ruled.sara.id, minutes(1));
      await rule(ruled.sara, 10);
      expect(await renewJob(ruled.jobId, minutes(5), { epoch: (await jobOf(ruled.jobId)).ownerEpoch })).toEqual({ ok: false, reason: 'paused', why: 'rule' });
      expect(await jobOf(ruled.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule', control: 'brick' });
      expect((await tellings(ruled.jobId)).map((one) => [one.kind, one.why, one.heldScreen])).toEqual([['paused', 'rule', true]]);
      // Rule B: an intent kept while the person holds the screen owns the ending; nothing is paused
      const intent = await running('c5-person-intent');
      const ie = (await jobOf(intent.jobId)).ownerEpoch;
      expect(await recordFinishIntent(intent.jobId, { outcome: 'done', why: null, cause: null, turns: [], run: 'rA', epoch: ie } as never, minutes(1))).toMatchObject({ ok: true });
      await takeOver(intent.sara.brickId, intent.sara.id, minutes(1));
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(intent.jobId, minutes(5), { epoch: (await jobOf(intent.jobId)).ownerEpoch })).toEqual({ ok: false, reason: 'ending' });
      expect(await prisma.computerJobPause.count({ where: { jobId: intent.jobId } })).toBe(0);
      await setUp();
      // Our pool is full while the person holds the screen: it ends, given back, as before
      const pool = await running('c5-person-pool');
      await takeOver(pool.sara.brickId, pool.sara.id, minutes(1));
      await setUp({ poolCeilingMicros: 1 });
      expect(await renewJob(pool.jobId, minutes(5), { epoch: (await jobOf(pool.jobId)).ownerEpoch })).toMatchObject({ ok: false, reason: 'pool' });
      expect(await jobOf(pool.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', pauses: 0 });
      await setUp();
      // CONTROL: a month pause with Brick in control is not marked, and on resume nothing is asked again
      const plain = await running('c5-plain');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(plain.jobId, minutes(5), { epoch: plain.epoch });
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: plain.jobId, n: 1 } } })).toMatchObject({ heldScreen: false });
      expect((await tellings(plain.jobId)).map((one) => one.heldScreen)).toEqual([false]);
      // The report of a plain pause has no held mark at all (absent, never false): the game says the usual line
      const plainSaid = (await told(minutes(5))).filter((one) => one.jobId === plain.jobId);
      expect(plainSaid).toHaveLength(1);
      expect(plainSaid[0]).toMatchObject({ kind: 'paused', pausedWhy: 'allowance' });
      expect('heldScreen' in plainSaid[0]).toBe(false);
      await setUp();
      await resumeJob(plain.sara.brickId, plain.sara.id, plain.jobId, minutes(6));
      expect(await getJob(plain.jobId)).toMatchObject({ resumed: true, askAgain: false });
    });

    it('the person’s own Pause is still not offered while they hold the screen (decision 3a)', async () => {
      const { sara, jobId, epoch } = await running('c5-person-own');
      await takeOver(sara.brickId, sara.id, minutes(1));
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2))).toMatchObject({ ok: false, reason: 'taken_over' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', pauses: 0 });
      expect(epoch).toBeGreaterThan(0);
      // A model call refused just as the person takes the screen never pauses the job
      await setUp();
      const call = await running('c5-person-call');
      const ce = (await jobOf(call.jobId)).ownerEpoch;
      await setUp({ memberAllowanceMicros: 1_000 });
      const k = await keyFor(call.jobId, ce, minutes(6));
      // No call is let through while the person holds the screen, so the person takes it just as the refusal reaches the pause (right after the pause's first read)
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as unknown as (args: { where?: { id?: string }; select?: Record<string, unknown> }) => Promise<unknown>;
      let fired = false;
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { where?: { id?: string }; select?: Record<string, unknown> }) => {
        const mine = !fired && args?.where?.id === call.jobId && !!args.select && Object.keys(args.select).join() === 'botId';
        return real(args).then(async (row) => {
          if (mine) {
            fired = true;
            await takeOver(call.sara.brickId, call.sara.id, minutes(7));
          }
          return row;
        });
      }) as never);
      try {
        expect(await ask(k, 'c-big', { estimateMicros: 50_000_000 }, minutes(7))).toMatchObject({ ok: false, reason: 'allowance' });
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      // Taking the screen moved the owner, so the refused call's key no longer decides anything: nothing is paused or ended, the job stays with the person (its next renewal at the month ends it, above)
      expect(await jobOf(call.jobId)).toMatchObject({ status: 'waiting', control: 'person', endedBy: null, pauses: 0, queuedFor: null });
      expect(await prisma.computerJobPause.count({ where: { jobId: call.jobId } })).toBe(0);
    });

    it('C5.7 the person’s own Resume refused by the month is answered to them, not told again; a stale message is never offered', async () => {
      const { sara, jobId, epoch } = await running('c5-quiet');
      const other = await running('c5-stale');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await keepReportTold(jobId, 'paused', 1);
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(6))).toEqual({ ok: false, reason: 'allowance' });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused']);
      // A "paused" not said yet for a job that has since carried on is stale: never offered
      await renewJob(other.jobId, minutes(5), { epoch: other.epoch });
      await setUp();
      expect(await carryOnPaused(minutes(6))).toBeGreaterThanOrEqual(1);
      const said = await told(minutes(7));
      expect(said.filter((one) => one.jobId === other.jobId).map((one) => one.kind)).toEqual(['carried_on']);
      expect((await tellings(other.jobId)).find((one) => one.kind === 'paused')?.staleAt).not.toBeNull();
    });
  });

  describe('C6: each stretch is charged on its own; a later fault of ours gives back only the faulty stretch', () => {
    it('C6.1 run, pause, carry on, done: two charges under their own events, each at its own room’s terms, each room settled once, and the sum is the time run', async () => {
      const { sara, jobId, epoch } = await running('c6-two');
      const first = (await jobOf(jobId)).reservationKey!;
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      // The second stretch is priced at twice the first: each stretch keeps its own room's terms
      setComputerProviderForTests(new FakeComputerProvider(2 * PER_MINUTE));
      await setUp();
      expect(await carryOnPaused(minutes(6))).toBe(1);
      const resumed = await jobOf(jobId);
      expect(resumed).toMatchObject({ status: 'running', queuedFor: null, pausedWhy: null });
      expect(resumed.reservationKey).not.toBe(first);
      const second = resumed.reservationKey!;
      const eb = await claimed(jobId, 'rB', minutes(6));
      expect(eb).toBeGreaterThan(epoch + 1 - 1);
      await finishJobUnder(jobId, null, 'done', minutes(8), null, null, null, 'rB', eb);
      const events = await timeEvents(jobId);
      expect(events.map((one) => [one.eventId, Number(one.quantity), Number(one.costMicros), one.personId])).toEqual([
        [`computer:${jobId}:time`, 120, 2 * 2 * PER_MINUTE, sara.id],
        [pauseEventId(jobId, 1), 300, 5 * PER_MINUTE, sara.id],
      ]);
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: first } })).toMatchObject({ state: 'settled', settledMicros: BigInt(5 * PER_MINUTE) });
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: second } })).toMatchObject({ state: 'settled', settledMicros: BigInt(2 * 2 * PER_MINUTE) });
      expect(events.reduce((sum, one) => sum + Number(one.quantity), 0)).toBe(420);
      expect((await jobOf(jobId)).secondsRun + (await jobOf(jobId)).secondsBilled).toBe(420);
    });

    it('C6.2 a second pause on the same job is a third event; C6.3 a replayed pause or ending charges nothing more', async () => {
      const { sara, jobId, epoch } = await running('c6-three');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      await carryOnPaused(minutes(6));
      const e2 = await claimed(jobId, 'rB', minutes(6));
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(9), { epoch: e2 })).toMatchObject({ reason: 'paused' });
      // Replayed: the same renewal again, and a pause asked again
      expect(await renewJob(jobId, minutes(9), { epoch: e2 })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await pauseForLimit(jobId, 'allowance', minutes(9))).toBe('not');
      await setUp();
      await carryOnPaused(minutes(10));
      const e3 = await claimed(jobId, 'rC', minutes(10));
      await finishJobUnder(jobId, null, 'done', minutes(11), null, null, null, 'rC', e3);
      await finishJobUnder(jobId, null, 'done', minutes(12), null, null, null, 'rC', e3);
      const events = await timeEvents(jobId);
      expect(events.map((one) => one.eventId).sort()).toEqual([`computer:${jobId}:time`, pauseEventId(jobId, 1), pauseEventId(jobId, 2)].sort());
      expect(events.map((one) => Number(one.quantity)).sort((a, b) => a - b)).toEqual([60, 180, 300]);
      expect(events.every((one) => one.personId === sara.id)).toBe(true);
    });

    it('C6.4 the month read straight after a pause counts the paused stretch (no free room when it carries on)', async () => {
      const { sara, jobId, epoch } = await running('c6-month');
      const settings = await getMeterSettings();
      const before = (await memberAllowance(sara.id, NOW, settings))!.leftMicros!;
      await setUp({ memberAllowanceMicros: 70_000 });
      await renewJob(jobId, minutes(5), { epoch });
      const after = (await memberAllowance(sara.id, minutes(5), await getMeterSettings()))!;
      expect(after.leftMicros).toBe(70_000 - 5 * PER_MINUTE);
      expect(before).toBe(1_000_000);
      // 40,000 is left: not room for a 60,000 stretch, so it does not carry on
      expect(await carryOnPaused(minutes(6))).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'allowance' });
    });

    it('C6.4b (Opus P1-1) a limit pause whose write to the books FAILS: the carry-on still counts the stretch (no free room) until the sweep writes it, then counts it once; CONTROL: the write working', async () => {
      for (const writes of ['failing', 'working'] as const) {
        const { sara, jobId, epoch } = await running(`c6-p11-${writes}`);
        await setUp({ memberAllowanceMicros: 1_000 });
        const record = meterModule.recordMeterEvent as jest.Mock;
        if (writes === 'failing') {
          record.mockImplementation(async () => {
            throw new Error('the books did not answer');
          });
        }
        try {
          expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
        } finally {
          record.mockImplementation((...args: unknown[]) => jest.requireActual('@/lib/meter').recordMeterEvent(...args));
        }
        expect(await prisma.meterEvent.count({ where: { eventId: pauseEventId(jobId, 1) } })).toBe(writes === 'failing' ? 0 : 1);
        // 80,000 for the month less the 30,000 stretch leaves 50,000: not room for a 60,000 stretch, so it waits (it would carry on if the stretch were counted nowhere)
        await setUp({ memberAllowanceMicros: 80_000 });
        expect((await memberAllowance(sara.id, minutes(5), await getMeterSettings()))!.usedMicros! + (await heldRoom(sara.id, minutes(5)))).toBe(5 * PER_MINUTE);
        expect(await carryOnPaused(minutes(5))).toBe(0);
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', reservationKey: null });
        // The sweep writes the missing event: still counted once, still waiting
        await sweepComputers(minutes(7));
        expect(await prisma.meterEvent.count({ where: { eventId: pauseEventId(jobId, 1) } })).toBe(1);
        expect((await memberAllowance(sara.id, minutes(7), await getMeterSettings()))!.usedMicros! + (await heldRoom(sara.id, minutes(7)))).toBe(5 * PER_MINUTE);
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
        // More arrives: it carries on
        await setUp({ memberAllowanceMicros: 100_000 });
        expect(await carryOnPaused(minutes(8))).toBe(1);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        await stopJobFor(sara.brickId, sara.id, minutes(9));
        await setUp();
      }
    });

    it('GPT round 6, finding 8b: a paused stretch whose event is in the books is counted ONCE whether or not its `booked_at` mark landed: 69,000 for the month, 6,000 used, and the 60,000 the next stretch asks for still fits', async () => {
      for (const mark of ['failed', 'written'] as const) {
        const { sara, jobId, epoch } = await running(`g6-8b-${mark}`);
        await setUp({ memberAllowanceMicros: 1_000 });
        expect(await renewJob(jobId, minutes(1), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
        // The stretch's own event is in the books...
        expect(await prisma.meterEvent.count({ where: { eventId: pauseEventId(jobId, 1) } })).toBe(1);
        // ...and the mark that follows that write either landed or did not (the server stopped between the two)
        if (mark === 'failed') await prisma.computerJobPause.updateMany({ where: { jobId, n: 1 }, data: { bookedAt: null } });
        expect((await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 1 } })).bookedAt === null).toBe(mark === 'failed');
        await setUp({ memberAllowanceMicros: 69_000 });
        // Counted once, by its event: 6,000 of the month used and nothing held beside it (counted twice, the stretch would stand in the person's own way)
        expect([(await memberAllowance(sara.id, minutes(2), await getMeterSettings()))!.usedMicros, await heldRoom(sara.id, minutes(2))]).toEqual([PER_MINUTE, 0]);
        // 63,000 is left, so the 60,000 the next stretch asks for fits and the job carries on (counted twice, 57,000 would refuse it)
        expect(await carryOnPaused(minutes(2))).toBe(1);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running', queuedFor: null, pausedWhy: null });
        await stopJobFor(sara.brickId, sara.id, minutes(3));
        await setUp();
      }
    });

    it('C6.5 a fault of ours after the job carried on gives back only the faulty stretch: its time, its calls and the credit they drew; the stretch before the pause stays charged, calls and credit included', async () => {
      const { sara, jobId, epoch } = await running('c6-fault');
      await gift(sara.id, 10_000_000);
      const k1 = await keyFor(jobId, epoch);
      expect(await ask(k1, 'c1', { estimateMicros: 20_000 }, minutes(1))).toMatchObject({ ok: true });
      await settle(jobId, 'c1', 10_000, minutes(1));
      // A call of the first stretch whose figures only arrive after the pause (a late report): it stays with the first stretch
      expect(await ask(k1, 'c1late', { estimateMicros: 20_000 }, minutes(2))).toMatchObject({ ok: true });
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      await resumeJob(sara.brickId, sara.id, jobId, minutes(6));
      const e2 = await claimed(jobId, 'rB', minutes(6));
      const k2 = await keyFor(jobId, e2, minutes(6));
      expect(await ask(k2, 'c2', { estimateMicros: 20_000, run: 'rB' }, minutes(7))).toMatchObject({ ok: true });
      await settle(jobId, 'c2', 12_000, minutes(7));
      expect(await callInLastStretch(jobId, 'c1')).toBe(false);
      expect(await callInLastStretch(jobId, 'c2')).toBe(true);
      // The second stretch's room lapses with nobody renewing it: the sweep ends the job as ours, given back
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(jobId)).reservationKey! }, data: { expiresAt: minutes(8) } });
      await sweepComputers(minutes(9));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'error' });
      await settle(jobId, 'c1late', 7_000, minutes(10));
      const event = (id: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: id } });
      // Given back: the faulty stretch's time and call
      expect((await event(`computer:${jobId}:time`)).personKey).toBe('unknown');
      expect((await event(`computer:${jobId}:call:c2`)).personKey).toBe('unknown');
      // Kept: the first stretch's time and BOTH its calls (the one that reported late too)
      expect((await event(pauseEventId(jobId, 1))).personKey).toBe(`person:${sara.id}`);
      expect((await event(`computer:${jobId}:call:c1`)).personKey).toBe(`person:${sara.id}`);
      expect((await event(`computer:${jobId}:call:c1late`)).personKey).toBe(`person:${sara.id}`);
      // Credit: the first stretch drew for its time and its calls, the faulty one for its call (its time was written against nobody, so it drew nothing). Only what the faulty stretch drew is owed back
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers', state: 'settled' }, select: { holdKey: true } });
      expect(holds.map((one) => one.holdKey).sort()).toEqual(
        [`computer:credit:${pauseEventId(jobId, 1)}`, `computer:credit:computer:${jobId}:call:c1`, `computer:credit:computer:${jobId}:call:c1late`, `computer:credit:computer:${jobId}:call:c2`].sort(),
      );
      const owed = await prisma.computerRefundObligation.findMany({ where: { jobId }, select: { holdKey: true } });
      expect(owed.map((one) => one.holdKey)).toEqual([`computer:credit:computer:${jobId}:call:c2`]);
      // The sweep that looks for give-backs that did not go through, and the Brick's purge, see nothing left owed (they would otherwise try for ever, and the purge would wait for ever)
      await sweepComputers(minutes(20));
      expect((await event(`computer:${jobId}:call:c1`)).personKey).toBe(`person:${sara.id}`);
      expect(await prisma.computerRefundObligation.count({ where: { jobId } })).toBe(1);
      expect(await computerTimeInBooks(sara.brickId, minutes(21))).toBe(true);
      // ...and the job is not even looked at again: the sweep's window found nothing left to give back
      expect((await prisma.appSetting.findUnique({ where: { key: 'computer_giveback_sweep_cursor' } }))?.value).toEqual({ after: '' });
    });

    it('C6.5b two pauses: a fault after the second gives back only the stretch after the LAST pause; the middle stretch stays charged like the first', async () => {
      const { sara, jobId, epoch } = await running('c6-two');
      await gift(sara.id, 10_000_000);
      const k1 = await keyFor(jobId, epoch);
      expect(await ask(k1, 'c1', { estimateMicros: 20_000 }, minutes(1))).toMatchObject({ ok: true });
      await settle(jobId, 'c1', 10_000, minutes(1));
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2));
      await resumeJob(sara.brickId, sara.id, jobId, minutes(3));
      const e2 = await claimed(jobId, 'rB', minutes(3));
      const k2 = await keyFor(jobId, e2, minutes(3));
      expect(await ask(k2, 'c2', { estimateMicros: 20_000, run: 'rB' }, minutes(4))).toMatchObject({ ok: true });
      await settle(jobId, 'c2', 11_000, minutes(4));
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      await resumeJob(sara.brickId, sara.id, jobId, minutes(6));
      const e3 = await claimed(jobId, 'rC', minutes(6));
      const k3 = await keyFor(jobId, e3, minutes(6));
      expect(await ask(k3, 'c3', { estimateMicros: 20_000, run: 'rC' }, minutes(7))).toMatchObject({ ok: true });
      await settle(jobId, 'c3', 12_000, minutes(7));
      expect([await callInLastStretch(jobId, 'c1'), await callInLastStretch(jobId, 'c2'), await callInLastStretch(jobId, 'c3')]).toEqual([false, false, true]);
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(jobId)).reservationKey! }, data: { expiresAt: minutes(8) } });
      await sweepComputers(minutes(9));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'error', pauses: 2 });
      const event = (id: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: id } });
      expect((await event(`computer:${jobId}:call:c1`)).personKey).toBe(`person:${sara.id}`);
      expect((await event(`computer:${jobId}:call:c2`)).personKey).toBe(`person:${sara.id}`);
      expect((await event(`computer:${jobId}:call:c3`)).personKey).toBe('unknown');
      expect((await event(pauseEventId(jobId, 1))).personKey).toBe(`person:${sara.id}`);
      expect((await event(pauseEventId(jobId, 2))).personKey).toBe(`person:${sara.id}`);
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId }, select: { holdKey: true } })).map((one) => one.holdKey)).toEqual([`computer:credit:computer:${jobId}:call:c3`]);
      await sweepComputers(minutes(20));
      expect((await event(`computer:${jobId}:call:c2`)).personKey).toBe(`person:${sara.id}`);
      expect(await computerTimeInBooks(sara.brickId, minutes(21))).toBe(true);
    });

    it('C6.6 CONTROL: a job that was never paused is charged once, and a fault of ours gives ALL of it back, as before', async () => {
      const { sara, jobId, epoch } = await running('c6-none');
      await gift(sara.id, 10_000_000);
      const k = await keyFor(jobId, epoch);
      await ask(k, 'c1', { estimateMicros: 20_000 }, minutes(1));
      await settle(jobId, 'c1', 10_000, minutes(1));
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(jobId)).reservationKey! }, data: { expiresAt: minutes(3) } });
      await sweepComputers(minutes(4));
      expect(await timeEvents(jobId)).toHaveLength(1);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } })).personKey).toBe('unknown');
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c1` } })).personKey).toBe('unknown');
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId } })).map((one) => one.holdKey)).toEqual([`computer:credit:computer:${jobId}:call:c1`]);
    });
  });

  describe('GPT round 6, finding 3b: the outcome of ONE start lands only on that start’s own try', () => {
    it('a bring-up that fails AFTER the job was paused, carried on and claimed again ends nothing: the replacement runs on, its own room and browser are untouched, and the machine is not marked broken', async () => {
      const { sara, jobId } = await running('g6-3b');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      const keys: Array<string | null> = [];
      let first = true;
      // The first try waits here for the machine to come ready. While it waits, the person pauses the job and carries it on: another try takes the job, with a room of its own, and another runner claims it
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (!first) return;
        first = false;
        keys.push((await jobOf(jobId)).reservationKey);
        expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(3))).ok).toBe(true);
        await ageWake(sara.brickId);
        expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(4))).ok).toBe(true);
        keys.push((await jobOf(jobId)).reservationKey);
        await claimed(jobId, 'rB', minutes(4));
        // ...and only now does the first try's bring-up fail
        throw new Error('the machine never came ready');
      });
      try {
        await resumeJob(sara.brickId, sara.id, jobId, minutes(2));
      } finally {
        spy.mockRestore();
      }
      // Two tries, two rooms
      expect(keys[0]).not.toBeNull();
      expect(keys[1]).not.toBe(keys[0]);
      // The job that runs now is the second try's, and the first try's failure landed on nothing
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'running', endedBy: null, reservationKey: keys[1] });
      expect(after.pauses).toBe(2);
      // The browser of the stretch that really started was brought back by its own try, with its time
      expect(await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 2 }, select: { resumedAt: true } })).toEqual({ resumedAt: minutes(4) });
      // ...and the first try marked nothing for the stretch IT was starting: that stretch was never carried on, it was paused again
      expect(await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 1 }, select: { resumedAt: true } })).toEqual({ resumedAt: null });
      // ...and the machine the replacement is on is not rewritten under it
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true } })).toEqual({ machine: 'working' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });
  });

  describe('GPT seventh note, B1: a stale start never stops or marks a machine a replacement woke (the wake ticket)', () => {
    const stopsOf = () => fake.calls.filter((call) => call.name === 'stop').length;
    const refOf = async (botId: string) => (await prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { providerRef: true } })).providerRef as string;
    /** The first try waits at readiness; while it waits the job is paused and carried on (a replacement wakes the machine); then `ending` decides how the first try's readiness ends. */
    const replacedWhileWaiting = async (name: string, ending: 'fails' | 'succeeds') => {
      const { sara, jobId } = await running(name);
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      let first = true;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (!first) return;
        first = false;
        expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(3))).ok).toBe(true);
        // The first wake is older than a start can take (no start is behind it any more): the replacement wakes the machine itself, with the next ticket
        await ageWake(sara.brickId);
        expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(4))).ok).toBe(true);
        await claimed(jobId, 'rB', minutes(4));
        if (ending === 'fails') throw new Error('the machine never came ready');
      });
      const stopsBefore = stopsOf();
      try {
        await resumeJob(sara.brickId, sara.id, jobId, minutes(2));
      } finally {
        spy.mockRestore();
      }
      return { sara, jobId, stopsBefore };
    };

    it('the first try’s readiness FAILS after the replacement is running: the provider is still awake, no stop was asked, the machine is working and the job runs', async () => {
      const { sara, jobId, stopsBefore } = await replacedWhileWaiting('b1-fail', 'fails');
      expect(stopsOf()).toBe(stopsBefore);
      expect(await fake.awake(await refOf(sara.brickId))).toBe(true);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true } })).toEqual({ machine: 'working' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('the first try’s readiness SUCCEEDS late after the replacement is running: it writes nothing (the replacement’s own working mark stands) and the replacement is unaffected', async () => {
      const { sara, jobId } = await replacedWhileWaiting('b1-late', 'succeeds');
      // The replacement marked the machine working at its own time (minutes(4)); the late first try (minutes(2)) wrote nothing over it
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true, lastWorkedAt: true } })).toEqual({ machine: 'working', lastWorkedAt: minutes(4) });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('CONTROL: a start that fails with no replacement stops the machine (claimed and proved) and marks it broken, as before, and the job is over', async () => {
      const { sara, jobId } = await running('b1-alone');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.failNext.ready = true;
      const stopsBefore = stopsOf();
      await resumeJob(sara.brickId, sara.id, jobId, minutes(2)).catch(() => undefined);
      expect(stopsOf()).toBe(stopsBefore + 1);
      expect(await fake.awake(await refOf(sara.brickId))).toBe(false);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true } })).toEqual({ machine: 'broken' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'failed' });
    });
  });

  describe('GPT seventh note, B1 (Opus): one wake in flight per Brick', () => {
    const wakesOf = () => fake.calls.filter((call) => call.name === 'wake').length;
    const stopsOf = () => fake.calls.filter((call) => call.name === 'stop').length;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const machineOf = async (botId: string) => (await prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { machine: true, providerRef: true, wakeEpoch: true } }));
    const until = async (check: () => Promise<boolean>) => {
      for (let at = 0; at < 200; at++) {
        if (await check()) return;
        await sleep(25);
      }
      throw new Error('the state never came');
    };
    /**
     * A bounded checkpoint tied to what a start does, raced against the starts that fixture runs: a start that ends (or fails) before the checkpoint is reached rejects the wait at once, with its own error, instead of
     * leaving the test to its timeout.
     */
    const reached = async (what: string, check: () => boolean | Promise<boolean>, ...fixtures: Promise<unknown>[]) => {
      const state: { ended: { error: unknown } | null } = { ended: null };
      for (const fixture of fixtures) {
        fixture.then(
          () => {
            state.ended ??= { error: new Error(`a start ended before ${what}`) };
          },
          (error: unknown) => {
            state.ended ??= { error };
          },
        );
      }
      for (let at = 0; at < 200; at++) {
        if (await check()) return;
        if (state.ended) throw state.ended.error;
        await sleep(25);
      }
      throw new Error(`${what} never came`);
    };
    /**
     * Counts what starts read of this Brick's machine row, through spies that call through: the looks of the wake path (the first look of a start, its look again after a lost ticket, and each poll of the wait for another start's
     * wake: all `findUniqueOrThrow` with no select) and the polls of the wait out of a browser cleanup (`findUnique` selecting the cleanup claim). The wait for another start's wake polls only after it sleeps, so a second look
     * after the ones a start made on arrival is that start inside its wait.
     */
    const watchMachine = (botId: string) => {
      const looksSpy = jest.spyOn(prisma.brickComputer, 'findUniqueOrThrow');
      const claimSpy = jest.spyOn(prisma.brickComputer, 'findUnique');
      const ofBrick = (args: unknown) => (args as { where?: { botId?: string } } | undefined)?.where?.botId === botId;
      return {
        looks: () => looksSpy.mock.calls.filter(([args]) => ofBrick(args) && !(args as { select?: unknown }).select).length,
        claimPolls: () => claimSpy.mock.calls.filter(([args]) => ofBrick(args) && (args as { select?: { cleanClaimedAt?: boolean } }).select?.cleanClaimedAt === true).length,
        stop: () => {
          looksSpy.mockRestore();
          claimSpy.mockRestore();
        },
      };
    };
    /** A Brick whose machine is asleep with no job on it. */
    const sleepingBrick = async (name: string) => {
      const sara = await person(name);
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'First', writes: false }, NOW);
      if (!first.ok) throw new Error('no first job');
      await finishJobUnder(first.job.id, null, 'done', minutes(1), null, null, null);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      return sara;
    };
    const readerOf = (sara: { id: string; brickId: string }, title: string, at: Date) => startJob({ botId: sara.brickId, personId: sara.id, title, writes: false }, at);
    const gate = () => {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open, opened };
    };

    it('(a) two readers start side by side on a sleeping machine: the second waits for the first wake instead of waking again, and both run on the one wake', async () => {
      const sara = await sleepingBrick('b1-sib');
      const first = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        readies++;
        if (readies === 1) await first.opened;
      });
      const wakes = wakesOf();
      const stops = stopsOf();
      let watch: ReturnType<typeof watchMachine> | null = null;
      let started: Promise<unknown>[] = [];
      try {
        const x = readerOf(sara, 'X', minutes(10));
        started = [x];
        await reached('the first start waits for its readiness', () => readies === 1, x);
        watch = watchMachine(sara.brickId);
        const y = readerOf(sara, 'Y', minutes(10));
        started = [x, y];
        // The second start is inside its wait for the first wake (its look on arrival and a poll of the wait), while the first readiness is still held
        const seen = watch;
        await reached('the second start waits for the first wake', () => seen.looks() >= 2, x, y);
        // The second start does not wake it again, and takes no ticket
        expect(wakesOf()).toBe(wakes + 1);
        expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 1);
        first.open();
        const [rx, ry] = await Promise.all([x, y]);
        expect(rx.ok && rx.job.status).toBe('running');
        expect(ry.ok && ry.job.status).toBe('running');
      } finally {
        first.open();
        await Promise.allSettled(started);
        watch?.stop();
        spy.mockRestore();
      }
      expect(wakesOf()).toBe(wakes + 1);
      expect(readies).toBe(1);
      expect(stopsOf()).toBe(stops);
      expect(await fake.awake((await machineOf(sara.brickId)).providerRef as string)).toBe(true);
      expect((await machineOf(sara.brickId)).machine).toBe('working');
    });

    it('(a) two starts that begin in the same instant on a sleeping machine take ONE wake ticket between them: the ticket is taken only from the state both saw, so the loser takes none and wakes nothing', async () => {
      for (let round = 0; round < 3; round++) {
        const sara = await sleepingBrick(`b1-race-${round}`);
        const wakes = wakesOf();
        const first = gate();
        const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
          await first.opened;
        });
        // Both starts are held after they read the machine `stopped` and before either tries to take a ticket: each one's first look of the machine row waits at this barrier, and both are let go together
        const barrier = gate();
        const original = prisma.brickComputer.findUniqueOrThrow.bind(prisma.brickComputer) as unknown as (args: { where: { botId: string } }) => Promise<{ machine: string }>;
        let held = 0;
        // (the watch spies on the same method and calls through; the barrier below is set on that same spy, which `watch.stop()` restores)
        const watch = watchMachine(sara.brickId);
        const lookSpy = jest.spyOn(prisma.brickComputer, 'findUniqueOrThrow').mockImplementation(((args: { where: { botId: string }; select?: unknown }) => {
          const look = original(args);
          if (args.where.botId !== sara.brickId || args.select || held >= 2) return look;
          return look.then(async (row) => {
            if (row.machine !== 'stopped') return row;
            held += 1;
            await barrier.opened;
            return row;
          });
        }) as never);
        let both: Promise<unknown>[] = [];
        try {
          const x = readerOf(sara, 'X', minutes(10));
          const y = readerOf(sara, 'Y', minutes(10));
          both = [x, y];
          await reached('both starts have read the machine stopped', () => held === 2, x, y);
          // Nothing has taken a ticket yet: both saw the same state
          expect((await machineOf(sara.brickId)).machine).toBe('stopped');
          expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1);
          const before = watch.looks();
          barrier.open();
          // The one that lost the ticket looks again and polls the wait for the winner's wake (two looks), while the winner's readiness is still held
          await reached('the start that lost the ticket waits for the other one’s wake', () => watch.looks() - before >= 2, x, y);
          expect(wakesOf()).toBe(wakes + 1);
          expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 1);
          first.open();
          const [rx, ry] = await Promise.all([x, y]);
          expect(rx.ok && rx.job.status).toBe('running');
          expect(ry.ok && ry.job.status).toBe('running');
        } finally {
          barrier.open();
          first.open();
          await Promise.allSettled(both);
          lookSpy.mockRestore();
          watch.stop();
          spy.mockRestore();
        }
        expect(wakesOf()).toBe(wakes + 1);
        expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 1);
      }
    });

    it('(a) the ticket is taken only from the state the start saw: of two starts that both saw the machine stopped, one gets the ticket and the other gets none (it waits for that wake)', async () => {
      const sara = await sleepingBrick('b1-ticket');
      const before = (await machineOf(sara.brickId)).wakeEpoch;
      const [one, two] = await Promise.all([takeWakeTicketForTests(sara.brickId, 'waking', 'stopped'), takeWakeTicketForTests(sara.brickId, 'waking', 'stopped')]);
      expect([one, two].filter((ticket) => ticket !== null)).toEqual([before + 1]);
      expect([one, two].filter((ticket) => ticket === null)).toHaveLength(1);
      expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'waking', wakeEpoch: before + 1 });
    });

    it('(a) the first of two side-by-side starts FAILS its readiness: its own stop is claimed and proved, and the second, which waited, wakes the machine itself and runs on it', async () => {
      const sara = await sleepingBrick('b1-sibfail');
      const first = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        readies++;
        if (readies === 1) {
          await first.opened;
          throw new Error('the machine never came ready');
        }
      });
      const wakes = wakesOf();
      let watch: ReturnType<typeof watchMachine> | null = null;
      let started: Promise<unknown>[] = [];
      try {
        const x = readerOf(sara, 'X', minutes(10));
        started = [x];
        await reached('the first start waits for its readiness', () => readies === 1, x);
        watch = watchMachine(sara.brickId);
        const y = readerOf(sara, 'Y', minutes(10));
        started = [x, y];
        // The second start is inside its wait for the first wake before the first readiness is let to fail
        const seen = watch;
        await reached('the second start waits for the first wake', () => seen.looks() >= 2, x, y);
        first.open();
        const [rx, ry] = await Promise.all([x, y]);
        expect(rx).toEqual({ ok: false, reason: 'broken_start' });
        expect(ry.ok && ry.job.status).toBe('running');
      } finally {
        first.open();
        await Promise.allSettled(started);
        watch?.stop();
        spy.mockRestore();
      }
      // The failed start stopped the machine it had woken (once, claimed), and the second woke it again, after: it is awake and working, under the second's ticket
      expect(wakesOf()).toBe(wakes + 2);
      expect(await fake.awake((await machineOf(sara.brickId)).providerRef as string)).toBe(true);
      expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working', wakeEpoch: 1 + 2 });
    });

    it('(b) the first start’s readiness fails while the replacement is STILL waking (not yet working): the stop claim matches nothing, no stop is asked, the provider stays awake and the replacement then comes ready', async () => {
      const sara = await sleepingBrick('b1-stillwaking');
      const first = gate();
      const second = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        readies++;
        if (readies === 1) {
          await first.opened;
          throw new Error('the machine never came ready');
        }
        await second.opened;
      });
      const stops = stopsOf();
      try {
        const x = readerOf(sara, 'X', minutes(10));
        await until(async () => (await machineOf(sara.brickId)).machine === 'waking');
        // The first wake is older than a start can take: the second start wakes the machine itself, with the next ticket, and is still waiting for its readiness
        await ageWake(sara.brickId);
        const y = readerOf(sara, 'Y', minutes(10));
        await until(async () => readies === 2);
        expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 2);
        // The first start's readiness now fails, while the machine is still waking for the second
        first.open();
        expect(await x).toEqual({ ok: false, reason: 'broken_start' });
        expect(stopsOf()).toBe(stops);
        expect(await fake.awake((await machineOf(sara.brickId)).providerRef as string)).toBe(true);
        expect((await machineOf(sara.brickId)).machine).toBe('waking');
        second.open();
        const ry = await y;
        expect(ry.ok && ry.job.status).toBe('running');
      } finally {
        first.open();
        second.open();
        spy.mockRestore();
      }
      expect(stopsOf()).toBe(stops);
      expect((await machineOf(sara.brickId)).machine).toBe('working');
    });

    it('(c) a start taken over while it was still waiting for readiness does NOT go on as ready: its job gets no stretch and no booking until the machine is working; the replacement then fails, is stopped under its own ticket, and the first start wakes the machine again and runs on it', async () => {
      const sara = await sleepingBrick('b1-takeover');
      const a = gate();
      const b = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        const n = ++readies;
        if (n === 1) await a.opened;
        if (n === 2) {
          await b.opened;
          throw new Error('the machine never came ready');
        }
      });
      const stops = stopsOf();
      let xDone = false;
      let watch: ReturnType<typeof watchMachine> | null = null;
      let started: Promise<unknown>[] = [];
      try {
        const x = readerOf(sara, 'X', minutes(10)).then((result) => {
          xDone = true;
          return result;
        });
        started = [x];
        await reached('the first start waits for its readiness', () => readies === 1, x);
        // The first wake is older than a start can take (no beat): the second start takes it over with the next ticket and runs its own readiness, which will fail
        await ageWake(sara.brickId);
        const y = readerOf(sara, 'Y', minutes(10));
        started = [x, y];
        await reached('the second start waits for its readiness', () => readies === 2, x, y);
        expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 2);
        // The first start's readiness comes in while the replacement's is still going: it is not the Brick's ticket any more, so the machine is not ready for its job
        watch = watchMachine(sara.brickId);
        const seen = watch;
        a.open();
        // The first start has run its check of the ticket after its readiness (the write that says `working` found the ticket replaced and wrote nothing) when it looks at the machine again, and then waits for the replacement's wake
        await reached('the first start has checked its ticket after its readiness', () => seen.looks() >= 2, x, y);
        expect(xDone).toBe(false);
        const xJob = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'X' } });
        expect(xJob.stretchStarted).toBeNull();
        expect((await timeEvents(xJob.id)).reduce((sum, one) => sum + Number(one.quantity), 0)).toBe(0);
        expect((await machineOf(sara.brickId)).machine).toBe('waking');
        // The replacement fails: it is stopped under its own ticket (one stop), and the first start, which waited, wakes the machine again itself
        b.open();
        expect(await y).toEqual({ ok: false, reason: 'broken_start' });
        const rx = await x;
        expect(rx.ok && rx.job.status).toBe('running');
      } finally {
        a.open();
        b.open();
        await Promise.allSettled(started);
        watch?.stop();
        spy.mockRestore();
      }
      expect(stopsOf()).toBe(stops + 1);
      expect(readies).toBe(3);
      expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working', wakeEpoch: 1 + 3 });
      expect(await fake.awake((await machineOf(sara.brickId)).providerRef as string)).toBe(true);
      const xRunning = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'X' } });
      expect(xRunning).toMatchObject({ status: 'running', prepState: null });
      expect(xRunning.stretchStarted).not.toBeNull();
    });

    it('(c) the first start comes ready after the replacement already made the machine working: it returns on that, with nothing woken again', async () => {
      const sara = await sleepingBrick('b1-takeover-ok');
      const a = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (++readies === 1) await a.opened;
      });
      const wakes = wakesOf();
      try {
        const x = readerOf(sara, 'X', minutes(10));
        await until(async () => readies === 1);
        await ageWake(sara.brickId);
        const ry = await readerOf(sara, 'Y', minutes(10));
        expect(ry.ok && ry.job.status).toBe('running');
        expect((await machineOf(sara.brickId)).machine).toBe('working');
        a.open();
        const rx = await x;
        expect(rx.ok && rx.job.status).toBe('running');
      } finally {
        a.open();
        spy.mockRestore();
      }
      expect(wakesOf()).toBe(wakes + 2);
      expect(readies).toBe(2);
      expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working', wakeEpoch: 1 + 2 });
    });

    it('(d) the replaced start that finds the machine `working` after its own readiness waits out a browser cleanup that holds it before it returns', async () => {
      const sara = await sleepingBrick('b1-clean-replaced');
      const a = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (++readies === 1) await a.opened;
      });
      let xDone = false;
      let watch: ReturnType<typeof watchMachine> | null = null;
      let x: Promise<unknown> = Promise.resolve();
      try {
        const first = readerOf(sara, 'X', minutes(10)).then((result) => {
          xDone = true;
          return result;
        });
        x = first;
        await reached('the first start waits for its readiness', () => readies === 1, first);
        await ageWake(sara.brickId);
        // The replacement makes the machine working while the first start is still waiting for its readiness
        const ry = await readerOf(sara, 'Y', minutes(10));
        expect(ry.ok && ry.job.status).toBe('running');
        expect((await machineOf(sara.brickId)).machine).toBe('working');
        // A cleanup of the browser holds the machine as the first start's readiness comes in
        await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = (NOW() AT TIME ZONE 'UTC') WHERE "bot_id" = ${sara.brickId}`;
        watch = watchMachine(sara.brickId);
        const seen = watch;
        a.open();
        // The start is inside its wait for the cleanup (it has looked at the claim twice and found it held) and has not returned
        await reached('the first start waits out the cleanup', () => seen.claimPolls() >= 2, first);
        expect(xDone).toBe(false);
        // The claim is let go: the write is awaited, and only then can the start return
        await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = NULL WHERE "bot_id" = ${sara.brickId}`;
        const rx = await first;
        expect(rx.ok && rx.job.status).toBe('running');
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { cleanClaimedAt: true } })).toEqual({ cleanClaimedAt: null });
      } finally {
        // Whatever happened, the claim is let go, the readiness is open and the start is joined before the next test
        // The database write may fail: its rejection is kept (the test fails with it), and the gate, the join and the spies are let go whatever it does (CodeRabbit on #1025, N8)
        try {
          await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = NULL WHERE "bot_id" = ${sara.brickId}`;
        } finally {
          a.open();
          await Promise.allSettled([x]);
          watch?.stop();
          spy.mockRestore();
        }
      }
    });

    describe('the wake is a heartbeat, not a length of time', () => {
      afterEach(() => setWakeTimingForTests(null));

      // These tests run in the UTC run and in the Kuwait run (a database whose time zone is Kuwait): `updated_at` is a timestamp without a time zone that is read against the server's clock, so every raw write of it is UTC (`NOW() AT TIME ZONE 'UTC'`: the ticket, the beat and the stop claim; the stop claim's value is overwritten by the write that follows it, so it is not read here)
      it('the ticket and the beat write `updated_at` as UTC: each lands within seconds of the server’s clock whatever the database’s time zone', async () => {
        setWakeTimingForTests({ beatMs: 100, staleMs: 700 });
        const sara = await sleepingBrick('b1-utc');
        const skew = async () => Math.abs(Date.now() - (await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { updatedAt: true } })).updatedAt.getTime());
        await ageWake(sara.brickId);
        expect(await skew()).toBeGreaterThan(5 * 60_000);
        // The ticket
        expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'stopped')).not.toBeNull();
        expect(await skew()).toBeLessThan(10_000);
        // The beat of a wake in flight
        await ageWake(sara.brickId);
        const a = gate();
        let readies = 0;
        const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
          readies++;
          await a.opened;
        });
        const mine = (await machineOf(sara.brickId)).wakeEpoch;
        let x: Promise<unknown> = Promise.resolve();
        try {
          const first = readerOf(sara, 'X', minutes(10));
          x = first;
          // X's own wake: it took the ticket after the abandoned one above (the machine was `waking` with a stale beat) and is inside its readiness, beating that ticket
          await reached('the start waits for its readiness', () => readies === 1, first);
          const own = (await machineOf(sara.brickId)).wakeEpoch;
          expect(own).toBe(mine + 1);
          // That ticket's row is backdated now; a fresh `updated_at` on the same ticket can come only from its beat
          await ageWake(sara.brickId);
          await until(async () => {
            expect((await machineOf(sara.brickId)).wakeEpoch).toBe(own);
            return (await skew()) < 10_000;
          });
          a.open();
          await first;
        } finally {
          a.open();
          await Promise.allSettled([x]);
          spy.mockRestore();
        }
      });

      it('a readiness that takes longer than the stale time but keeps beating is not taken over: one wake, one ticket, and both starts run on it', async () => {
        setWakeTimingForTests({ beatMs: 100, staleMs: 700 });
        const sara = await sleepingBrick('b1-beat');
        const a = gate();
        let readies = 0;
        const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
          if (++readies === 1) await a.opened;
        });
        const wakes = wakesOf();
        try {
          const x = readerOf(sara, 'X', minutes(10));
          await until(async () => readies === 1);
          const y = readerOf(sara, 'Y', minutes(10));
          // Three times the stale time with the start still waking: the beat kept it alive, so nothing took it over
          await sleep(2200);
          expect(readies).toBe(1);
          expect(wakesOf()).toBe(wakes + 1);
          expect((await machineOf(sara.brickId)).wakeEpoch).toBe(1 + 1);
          a.open();
          const [rx, ry] = await Promise.all([x, y]);
          expect(rx.ok && rx.job.status).toBe('running');
          expect(ry.ok && ry.job.status).toBe('running');
        } finally {
          a.open();
          spy.mockRestore();
        }
        expect(wakesOf()).toBe(wakes + 1);
      });

      it('a start that was replaced does not keep the replacement’s wake alive: only the Brick’s own ticket beats, so a replacement that is gone is taken over', async () => {
        setWakeTimingForTests({ beatMs: 100, staleMs: 700 });
        const sara = await sleepingBrick('b1-beat-own');
        const a = gate();
        let readies = 0;
        const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
          if (++readies === 1) await a.opened;
        });
        try {
          const x = readerOf(sara, 'X', minutes(10));
          await until(async () => readies === 1);
          // A replacement took the next ticket and is gone (nothing beats it); the first start is still waiting for its readiness, and still beats (its own ticket is no longer the Brick's)
          expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking')).toBe(1 + 2);
          const y = readerOf(sara, 'Y', minutes(10));
          const first = await Promise.race([y, sleep(3500).then(() => 'still waiting' as const)]);
          expect(first).not.toBe('still waiting');
          expect(first !== 'still waiting' && first.ok && first.job.status).toBe('running');
          a.open();
          await x;
        } finally {
          a.open();
          spy.mockRestore();
        }
        expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working' });
      });

      it('a wake call that THROWS stops the machine (it may have started), and its beat is let go with it: the next start wakes it under a ticket of its own and runs', async () => {
        setWakeTimingForTests({ beatMs: 100, staleMs: 700 });
        const sara = await sleepingBrick('b1-wakefail');
        // Another job is on the machine (so a failed start does not rewrite its state), and the machine is `waking` with a wake that has no start behind it
        const other = await readerOf(sara, 'R', minutes(9));
        expect(other.ok && other.job.status).toBe('running');
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking' } });
        await ageWake(sara.brickId);
        const wakes = wakesOf();
        const stops = fake.calls.filter((call) => call.name === 'stop').length;
        fake.failNext.wake = true;
        const first = await readerOf(sara, 'X', minutes(10));
        expect(first).toEqual({ ok: false, reason: 'broken_start' });
        const epochAfterFail = (await machineOf(sara.brickId)).wakeEpoch;
        // The wake that failed may have started the instance (Agent37 starts it, then waits for health): it is stopped under the start's own ticket (Opus on #1040)
        expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'stopped' });
        expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stops + 1);
        // A beat that outlived the failed wake would keep it fresh for ever, and this start would wait on it for ever
        const second = await Promise.race([readerOf(sara, 'Y', minutes(10)), sleep(5000).then(() => 'still waiting' as const)]);
        expect(second).not.toBe('still waiting');
        expect(second !== 'still waiting' && second.ok && second.job.status).toBe('running');
        expect(wakesOf()).toBeGreaterThanOrEqual(wakes + 1);
        expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working', wakeEpoch: epochAfterFail + 1 });
      });

      it('a wake whose start is gone (no beat for the stale time) is taken over by the waiting start, which wakes it itself and runs', async () => {
        setWakeTimingForTests({ beatMs: 100, staleMs: 700 });
        const sara = await sleepingBrick('b1-nobeat');
        // A machine left `waking` by a start that crashed: its ticket is taken and nothing beats it
        await takeWakeTicketForTests(sara.brickId, 'waking', 'stopped');
        const wakes = wakesOf();
        const started = Date.now();
        const result = await readerOf(sara, 'Y', minutes(10));
        expect(result.ok && result.job.status).toBe('running');
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        expect(wakesOf()).toBe(wakes + 1);
        expect(await machineOf(sara.brickId)).toMatchObject({ machine: 'working', wakeEpoch: 1 + 2 });
      });
    });

    it('(d) a waiter that sees the wake end in `working` while a browser cleanup holds the machine waits the cleanup out before it returns', async () => {
      const sara = await sleepingBrick('b1-clean');
      const a = gate();
      let readies = 0;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (++readies === 1) await a.opened;
      });
      let yDone = false;
      let watch: ReturnType<typeof watchMachine> | null = null;
      let started: Promise<unknown>[] = [];
      try {
        const x = readerOf(sara, 'X', minutes(10));
        started = [x];
        await reached('the first start waits for its readiness', () => readies === 1, x);
        watch = watchMachine(sara.brickId);
        const seen = watch;
        const y = readerOf(sara, 'Y', minutes(10)).then((result) => {
          yDone = true;
          return result;
        });
        started = [x, y];
        // The second start is inside its wait for the first wake
        await reached('the second start waits for the first wake', () => seen.looks() >= 2, x, y);
        // A cleanup of the browser holds the machine as it comes up
        await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = (NOW() AT TIME ZONE 'UTC') WHERE "bot_id" = ${sara.brickId}`;
        a.open();
        // The wake ends in `working` (the first start returns on it), and the waiting start is inside its wait for the cleanup (it has looked at the claim twice and found it held) and has not returned
        await reached('the waiting start waits out the cleanup', () => seen.claimPolls() >= 2, y);
        expect(yDone).toBe(false);
        // The claim is let go: the write is awaited, and only then can the start return
        await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = NULL WHERE "bot_id" = ${sara.brickId}`;
        const ry = await y;
        expect(ry.ok && ry.job.status).toBe('running');
        await x;
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { cleanClaimedAt: true } })).toEqual({ cleanClaimedAt: null });
      } finally {
        // Whatever happened, the claim is let go, the readiness is open and the starts are joined before the next test
        // The database write may fail: its rejection is kept (the test fails with it), and the gate, the join and the spies are let go whatever it does (CodeRabbit on #1025, N8)
        try {
          await prisma.$executeRaw`UPDATE "brick_computers" SET "clean_claimed_at" = NULL WHERE "bot_id" = ${sara.brickId}`;
        } finally {
          a.open();
          await Promise.allSettled(started);
          watch?.stop();
          spy.mockRestore();
        }
      }
    });
  });

  describe('CodeRabbit on #1025 (8): the machine is written under the job row, with the room checked there', () => {
    it('a bring-up that fails while another request is giving the job a new room (its row is locked and changed) does not mark the machine broken, and ends nothing', async () => {
      const { sara, jobId } = await running('cr-8');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      let first = true;
      let held: Promise<void> = Promise.resolve();
      let poll: Promise<void> = Promise.resolve();
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      let resumeEnded = false;
      let waited = false;
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (!first) return;
        first = false;
        // Another request holds the job's row and gives it another room, but has not committed when this try's bring-up fails: the failed try waits for it at the machine write and then finds the room moved
        let pid = 0;
        let locked: () => void = () => undefined;
        const gotLock = new Promise<void>((resolve) => (locked = resolve));
        held = prisma.$transaction(
          async (tx) => {
            pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
            await tx.$queryRaw`SELECT 1 AS one FROM "computer_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
            locked();
            await gate;
            await tx.computerJob.update({ where: { id: jobId }, data: { reservationKey: 'cr-8-other-room' } });
          },
          { timeout: 30_000, maxWait: 30_000 },
        );
        // A holder that fails before it takes the row ends the wait with its own error
        await Promise.race([gotLock, held.then(() => Promise.reject(new Error('the holder ended before it took the row')))]);
        // The row is let go when the failing resume is blocked on it (a backend the holder blocks), or when the resume ended without waiting (the test then fails on what it wrote), or at a bounded deadline
        poll = (async () => {
          try {
            for (let tries = 0; tries < 250 && !waited && !resumeEnded; tries += 1) {
              waited = (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0].n >= 1;
              if (!waited) await new Promise((resolve) => setTimeout(resolve, 20));
            }
          } finally {
            // The row is let go on every way out of the poll, a rejected query included (the resume may be blocked on it)
            letGo();
          }
        })();
        // Observed from the start (its rejection is raised where the test awaits `poll`), so a failing poll is never an unhandled rejection while the resume is still pending
        poll.catch(() => undefined);
        throw new Error('the machine never came ready');
      });
      try {
        await resumeJob(sara.brickId, sara.id, jobId, minutes(2)).finally(() => {
          resumeEnded = true;
        });
        await poll;
        await held;
        // The failing resume really waited for the row the other request held
        expect(waited).toBe(true);
      } finally {
        spy.mockRestore();
        resumeEnded = true;
        letGo();
        await Promise.allSettled([poll, held]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, reservationKey: 'cr-8-other-room' });
      // (the machine is in whatever state the waking left it: never "broken", which is what a failure that wrote it would leave)
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true } })).machine).not.toBe('broken');
    });
  });

  describe('GPT round 6, finding 3b (second half): a start that SUCCEEDS late writes nothing for the stretch that moved on without it', () => {
    it('the browser of a resumed stretch is brought back once, by the try that really started it: a late try whose job was paused and carried on meanwhile marks nothing and restores nothing', async () => {
      const { sara, jobId } = await running('g6-3b-late');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      (profiles.restoreProfile as jest.Mock).mockClear();
      let first = true;
      // The first try's machine comes ready LATE: by then the person has paused the job and carried it on, so another try is the one that started this stretch
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        if (!first) return;
        first = false;
        expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(3))).ok).toBe(true);
        await ageWake(sara.brickId);
        expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(4))).ok).toBe(true);
        await claimed(jobId, 'rB', minutes(4));
      });
      try {
        await resumeJob(sara.brickId, sara.id, jobId, minutes(2));
      } finally {
        spy.mockRestore();
      }
      // The browser was brought back ONCE, by the second try (the first try's would have put the wrong stretch's browser on the machine)
      expect((profiles.restoreProfile as jest.Mock).mock.calls).toHaveLength(1);
      expect(await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 2 }, select: { resumedAt: true } })).toEqual({ resumedAt: minutes(4) });
      expect(await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 1 }, select: { resumedAt: true } })).toEqual({ resumedAt: null });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, pauses: 2 });
    });
  });

  describe('GPT round 6, finding 7: a job that carried on is not worked on until its browser is settled', () => {
    it('while its browser is still coming back the job is running but nobody works it: not in the runnable list, a claim answers `not_ready`, and no call of its own key is authorized', async () => {
      const { sara, jobId, epoch } = await running('g6-7-wait');
      // A key made while it ran: its calls must be refused while the browser is still coming back, not only after a new claim
      const token = await keyFor(jobId, epoch);
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      let settle = (): void => undefined;
      const waiting = new Promise<void>((resolve) => {
        settle = () => resolve();
      });
      let seen: { status: string; prepState: string | null } | null = null;
      let runnable: string[] = [];
      let claim: unknown = null;
      let call: unknown = null;
      let revived: unknown = null;
      (profiles.restoreProfile as jest.Mock).mockImplementationOnce(async () => {
        // The job is running on its new room already; its browser is not back yet
        const row = await jobOf(jobId);
        seen = { status: row.status, prepState: row.prepState };
        runnable = (await runnableJobsPage(50)).jobs.map((one) => one.jobId);
        claim = await claimJob(jobId, { run: 'rB', seen: row.ownerEpoch }, minutes(2));
        call = await ask(token, 'c-prep', {}, minutes(2));
        // ...and a key that somehow outlived the pause (the pause revokes them all, so this one is revived by hand) is refused too: the browser, not the key alone, is what decides here
        await prisma.computerJobToken.updateMany({ where: { jobId }, data: { revokedAt: null, ownerEpoch: row.ownerEpoch, expiresAt: minutes(60) } });
        revived = await ask(token, 'c-prep-live', {}, minutes(2));
        await waiting;
        return { state: 'restored', reason: null };
      });
      const resumed = resumeJob(sara.brickId, sara.id, jobId, minutes(2));
      // Let the restore's checks run, then let it answer
      await new Promise((r) => setTimeout(r, 20));
      settle();
      const answer = await resumed;
      expect(seen).toEqual({ status: 'running', prepState: 'restoring' });
      // Nothing picks it up: no runner is handed it, no runner may claim it, and no call of its own key is authorized
      expect(runnable).not.toContain(jobId);
      expect(claim).toEqual({ ok: false, reason: 'not_ready', prep: 'restoring' });
      expect(call).toMatchObject({ ok: false, reason: 'refused' });
      expect(revived).toMatchObject({ ok: false, reason: 'refused' });
      // The room that key's call took was given straight back: a call refused for the browser costs the person nothing
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c-prep-live') }, select: { state: true, settledMicros: true } })).toEqual({ state: 'released', settledMicros: null });
      // Its room was not charged for the refused call either: the call never happened
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c-prep') } })).toBeNull();
      // Its browser is back: the job is ready, claimable, and its calls are authorized again
      expect(answer.ok).toBe(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', prepState: null, endedBy: null });
      expect((await runnableJobsPage(50)).jobs.map((one) => one.jobId)).toContain(jobId);
      const again = await claimJob(jobId, { run: 'rB', seen: (await jobOf(jobId)).ownerEpoch }, minutes(3));
      expect(again.ok).toBe(true);
      expect(await ask(await keyFor(jobId, (again as { ok: true; epoch: number }).epoch, minutes(3)), 'c-after', {}, minutes(3))).toMatchObject({ ok: true });
    });

    it('its browser could not be settled: Resume answers `not_ready`, the job stays out of reach, and the sweep brings it back', async () => {
      const { sara, jobId } = await running('g6-7-recover');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      // The machine would not bring it back and would not empty the live browser either: its state is unknown, so the job is never run on it
      (profiles.restoreProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'failed', reason: 'busy' }));
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(2))).toEqual({ ok: false, reason: 'not_ready' });
      const stuck = await jobOf(jobId);
      expect(stuck).toMatchObject({ status: 'running', prepState: 'recover', endedBy: null });
      expect((await runnableJobsPage(50)).jobs.map((one) => one.jobId)).not.toContain(jobId);
      expect(await claimJob(jobId, { run: 'rB', seen: stuck.ownerEpoch }, minutes(3))).toEqual({ ok: false, reason: 'not_ready', prep: 'recover' });
      // The sweep's restore works (the machine answers this time: the sweep's restore is the real one, not the stub above): the job becomes ready, keeps the room and the stretch it started on, and is claimable
      const answer = fake.execAnswer;
      fake.execAnswer = (command: string) => (/ACTION="restore"/.test(command) ? { stdout: 'restored=1 cookies=3 pages=1\n' } : answer(command));
      try {
        await sweepComputers(minutes(4));
      } finally {
        fake.execAnswer = answer;
      }
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'running', prepState: null, endedBy: null, reservationKey: stuck.reservationKey, pauses: 1 });
      expect((await runnableJobsPage(50)).jobs.map((one) => one.jobId)).toContain(jobId);
      expect((await claimJob(jobId, { run: 'rB', seen: after.ownerEpoch }, minutes(5))).ok).toBe(true);
    });

    it('CodeRabbit A12: a job that pauses again while its restore is in flight keeps the new pause’s marker: the old restore settles nothing and clears nothing', async () => {
      const { sara, jobId } = await running('a12-again');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      // The second pause is cut short before its park (the server stopped), so it leaves its marker on the machine, for the same job id
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('the server stopped');
      });
      (profiles.restoreProfile as jest.Mock).mockImplementationOnce(async () => {
        expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(2))).ok).toBe(true);
        return { state: 'restored', reason: null };
      });
      await resumeJob(sara.brickId, sara.id, jobId, minutes(2));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', pauses: 2 });
      // The old restore's settlement matched no row, so it is not "ready" and let go of nothing: the machine still waits for the second pause's browser
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
    });

    it('a job that carries on and still has a browser of its own waits for the machine instead of running in another job’s browser: its park is untouched and it holds no room, and it starts when the machine is free', async () => {
      const { sara, jobId } = await running('g6-7-wait-alone');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      // Another job of the person’s takes the machine while this one is paused. It only LOOKS, so the two could share the machine (a writer would make this one wait in line anyway)
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Other', writes: false }, minutes(2));
      if (!other.ok) throw new Error('not started');
      expect(await jobOf(other.job.id)).toMatchObject({ status: 'running' });
      (profiles.restoreProfile as jest.Mock).mockClear();
      // Its Resume leaves it waiting in line, with nothing held and nothing asked of the machine: it would have to run in the other job’s browser, and its own sign-ins would be thrown away for that
      expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(3))).ok).toBe(true);
      const waiting = await jobOf(jobId);
      expect(waiting).toMatchObject({ status: 'queued', queuedFor: 'busy', prepState: null, pauses: 1, reservationKey: null });
      expect((profiles.restoreProfile as jest.Mock).mock.calls).toHaveLength(0);
      // Its park is where the pause left it, so it will get its OWN sign-ins back and not the other job’s
      expect(await prisma.computerJobPause.findFirstOrThrow({ where: { jobId, n: 1 }, select: { resumedAt: true } })).toEqual({ resumedAt: null });
      // The other job ends: the line starts this one, with its own browser brought back
      expect((await cancelJob(sara.brickId, sara.id, other.job.id, minutes(4))).ok).toBe(true);
      await sweepComputers(minutes(5));
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'running', queuedFor: null, prepState: null, endedBy: null });
      expect(after.reservationKey).not.toBeNull();
      expect((profiles.restoreProfile as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('a job that carries on with NOTHING of its own kept runs beside another job as any new job does: a shared browser it signs in to again', async () => {
      const { sara, jobId } = await running('g6-7-expired');
      // Only jobs that read share a browser (a job that may sign in has it alone): this one only looks
      await prisma.computerJob.update({ where: { id: jobId }, data: { writes: false } });
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Other', writes: false }, minutes(2));
      if (!other.ok) throw new Error('not started');
      // Its park is past the hours sign-ins are kept: there is nothing of its own to wait for
      await prisma.computerJobPause.updateMany({ where: { jobId, n: 1 }, data: { at: new Date(NOW.getTime() - 30 * 3600_000) } });
      (profiles.restoreProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'fresh', reason: 'shared' }));
      expect((await resumeJob(sara.brickId, sara.id, jobId, minutes(3))).ok).toBe(true);
      // It runs, beside the other job, ready: a browser it shares and signs in to again is valid
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', prepState: null, endedBy: null });
      expect(await jobOf(other.job.id)).toMatchObject({ status: 'running' });
    });

    it('a crash between a pause and putting its browser away stops every other job on that machine until the park is finished', async () => {
      const { sara, jobId } = await running('g6-7-park');
      // The pause commits and the server stops before the park runs
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('the server stopped');
      });
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
      // The machine is awake (the pause rested it, and something woke it again): the park or the sweep settles the mark, and until then no other job starts
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working' } });
      // Another job of the person's on that machine does not start: its browser would be the paused job's
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
      if (!next.ok) throw new Error('not queued');
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'queued', queuedFor: 'busy' });
      // ...and the sweep does not start it either, while the park is unfinished
      // The sweep runs while the mark is set and the park cannot be done (it answers `failed`, CodeRabbit on #1025, 48): the sweep tries it, the mark stays and the job stays queued
      // (the sweep's own park runs the real one against the fake machine, which answers nothing: it fails, and the commands it sent prove it was tried)
      const sentBefore = fake.commands.length;
      await sweepComputers(minutes(4));
      expect(fake.commands.length).toBeGreaterThan(sentBefore);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'queued' });
      // The park is finished: the machine stops waiting and the job behind it starts
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: null } });
      await sweepComputers(minutes(5));
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'running', queuedFor: null });
    });
  });

  describe('Sentry on #1025: a pause on a machine that is not awake never locks the Brick out', () => {
    for (const state of ['resting', 'waking'] as const) {
      it(`a job paused while its machine is ${state}: the next job wakes the machine, the paused job's browser is put away FIRST, and only then does the mark go and the job take the machine (its sign-ins never reach the new job)`, async () => {
        const { sara, jobId } = await running(`s1025-${state}`);
        // The machine is not awake when the pause lands (a pause in the preparing window, an idle rest, a restart): the park cannot reach it and the settle cannot either
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: state } });
        (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'left', reason: 'not_awake' }));
        expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
        // (a wake with no start behind it: older than a start can take, so the next job wakes the machine itself)
        await ageWake(sara.brickId);
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
        const seen: Array<{ job: string; machine: string; starts: number }> = [];
        (profiles.parkProfile as jest.Mock).mockImplementationOnce(async (_bot: string, job: string) => {
          seen.push({
            job,
            machine: (await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { machine: true } })).machine,
            // No job holds the machine while its browser is put away
            starts: await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['running', 'waiting'] } } }),
          });
          return { state: 'parked', reason: null };
        });
        const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
        if (!next.ok) throw new Error('not started');
        expect(seen).toEqual([{ job: jobId, machine: 'working', starts: 0 }]);
        expect(await jobOf(next.job.id)).toMatchObject({ status: 'running', queuedFor: null });
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: null });
      });
    }

    it('CodeRabbit on #1025 (F5): the pause number the park settles is read BEFORE the park runs, so a job that resumes and pauses again meanwhile keeps its new pause’s mark (and the job behind it keeps waiting)', async () => {
      const { sara, jobId } = await running('f5-pause-number');
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'left', reason: 'not_awake' }));
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      await ageWake(sara.brickId);
      const parks: unknown[][] = [];
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async (...args: unknown[]) => {
        parks.push(args);
        // While the park ran, the job carried on and was paused again: its pause has a new number, and the mark is that later pause's now
        await prisma.computerJob.update({ where: { id: jobId }, data: { pauses: { increment: 1 } } });
        return { state: 'parked', reason: null };
      });
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
      if (!next.ok) throw new Error('not started');
      expect(parks).toHaveLength(1);
      expect(parks[0][3]).toBe(1);
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'queued', queuedFor: 'busy' });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
    });

    it('a browser that cannot be put away or emptied after the wake leaves the mark and keeps the job in line (never a job on a browser that may hold another job’s sign-ins); the machine rests again', async () => {
      const { sara, jobId } = await running('s1025-cannot');
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'left', reason: 'not_awake' }));
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'failed', reason: 'busy' }));
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
      if (!next.ok) throw new Error('not started');
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'queued', queuedFor: 'busy', reservationKey: null, startedAt: null });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: jobId });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['running', 'waiting'] } } })).toBe(0);
      // Once the park is finished the job behind it starts
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: null } });
      await sweepComputers(minutes(5));
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'running' });
    });

    it('CONTROL: with the machine awake the mark still holds every other job back, and the start does not touch the browser (the pause’s own park or the sweep settles it)', async () => {
      const { sara, jobId } = await running('s1025-awake');
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('the server stopped');
      });
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      // The pause rested the machine (nothing held it); the machine is awake again, as when another job's wake or the sweep's check found it
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working' } });
      (profiles.parkProfile as jest.Mock).mockClear();
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
      if (!next.ok) throw new Error('not started');
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'queued', queuedFor: 'busy' });
      expect((profiles.parkProfile as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('the database itself refuses a start on a Brick while a pause has its browser to put away, whichever server writes it (the trigger of migration 195)', async () => {
      const { sara, jobId } = await running('s1025-trigger');
      (profiles.parkProfile as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('the server stopped');
      });
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      const other = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Old server', writes: false, route: 'computer', expectedMicros: BigInt(0) } });
      // An older server writes the start straight away: the row is skipped (0 rows), as for a lost race
      const wrote = await prisma.computerJob.updateMany({ where: { id: other.id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
      expect(wrote.count).toBe(0);
      expect(await jobOf(other.id)).toMatchObject({ status: 'queued' });
      // The paused job's own resume is not refused by it, and once the mark is gone the other job starts
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: null } });
      expect((await prisma.computerJob.updateMany({ where: { id: other.id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } })).count).toBe(1);
    });
  });

  describe('GPT seventh note, B2: nothing is billable before readiness (the stretch starts when the job is ready, never at the claim)', () => {
    /** The seconds the person was charged across every stretch of the job (the time events in the books). */
    const chargedSeconds = async (jobId: string) => (await timeEvents(jobId)).reduce((sum, one) => sum + Number(one.quantity), 0);
    /** A job that ran its first minute, was paused, and was resumed into a browser that could not be brought back (`recover`). */
    const stuckInRecovery = async (name: string) => {
      const { sara, jobId } = await running(name);
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(1))).ok).toBe(true);
      (profiles.restoreProfile as jest.Mock).mockImplementationOnce(async () => ({ state: 'failed', reason: 'busy' }));
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(2))).toEqual({ ok: false, reason: 'not_ready' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', prepState: 'recover', stretchStarted: null });
      return { sara, jobId };
    };

    it('a resume into a restore that fails, then Pause 3 minutes later: the second stretch is 0 seconds, the first minute stays booked', async () => {
      const { sara, jobId } = await stuckInRecovery('b2-pause');
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(5))).ok).toBe(true);
      const job = await jobOf(jobId);
      expect(job.secondsRun + job.secondsBilled).toBe(60);
      expect(await chargedSeconds(jobId)).toBe(60);
      const second = (await timeEvents(jobId)).find((one) => one.eventId === pauseEventId(jobId, 2));
      expect(second === undefined || Number(second.costMicros) === 0).toBe(true);
    });

    it('the same, ended by Cancel: the stretch that never became ready is 0 seconds', async () => {
      const { sara, jobId } = await stuckInRecovery('b2-cancel');
      expect((await cancelJob(sara.brickId, sara.id, jobId, minutes(5))).ok).toBe(true);
      expect(await chargedSeconds(jobId)).toBe(60);
      const job = await jobOf(jobId);
      expect(job.secondsRun + job.secondsBilled).toBe(60);
    });

    it('the sweep recovers it successfully after 3 minutes, then 2 minutes of work and a Pause: about 2 minutes are booked for that stretch, on top of the first minute', async () => {
      const { sara, jobId } = await stuckInRecovery('b2-sweep');
      const answer = fake.execAnswer;
      fake.execAnswer = (command: string) => (/ACTION="restore"/.test(command) ? { stdout: 'restored=1 cookies=3 pages=1\n' } : answer(command));
      try {
        await sweepComputers(minutes(5));
      } finally {
        fake.execAnswer = answer;
      }
      const ready = await jobOf(jobId);
      expect(ready).toMatchObject({ status: 'running', prepState: null });
      // Billing started at the moment the browser was ready (the sweep's own time), not at the claim 3 minutes before
      expect(Math.abs(ready.stretchStarted!.getTime() - minutes(5).getTime())).toBeLessThan(5_000);
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(7))).ok).toBe(true);
      const job = await jobOf(jobId);
      expect(job.secondsRun + job.secondsBilled).toBe(60 + 120);
      expect(await chargedSeconds(jobId)).toBe(60 + 120);
    });

    it('a job that starts with nothing to restore is billed from the moment its machine is ready, and a refused ready write leaves nothing billed (CONTROL: the plain start books its whole run)', async () => {
      const { sara, jobId } = await running('b2-plain');
      const first = await jobOf(jobId);
      expect(first.stretchStarted).not.toBeNull();
      expect(Math.abs(first.stretchStarted!.getTime() - NOW.getTime())).toBeLessThan(5_000);
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(4))).ok).toBe(true);
      expect(await chargedSeconds(jobId)).toBe(240);
    });

    it('a plain start whose wake takes 3 minutes, then 2 minutes of work and a Pause: 120 seconds are booked, and the stretch starts when the machine was ready (claim + 3 minutes), not at the claim', async () => {
      const sara = await person('b2-slow');
      await giveComputer(sara.brickId, sara.id);
      // The wake takes 3 minutes of the server's clock: the readiness check itself moves it (nothing else sleeps)
      const real = Date.now.bind(Date);
      let skew = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => real() + skew);
      const spy = jest.spyOn(fake, 'ready').mockImplementation(async () => {
        skew += 3 * 60_000;
      });
      let started;
      try {
        started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Slow wake', writes: false }, NOW);
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
      if (!started.ok) throw new Error('no job');
      const jobId = started.job.id;
      const ready = await jobOf(jobId);
      expect(ready).toMatchObject({ status: 'running', prepState: null });
      // Billing starts when the machine was ready: the claim at NOW plus the 3 minutes the wake took (never at the claim)
      expect(ready.startedAt).not.toBeNull();
      expect(ready.stretchStarted!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 3 * 60_000);
      expect(ready.stretchStarted!.getTime()).toBeLessThan(NOW.getTime() + 3 * 60_000 + 10_000);
      // 2 minutes of work after it was ready, then Pause: the pause bills the rounded seconds from the readiness stamp to the pause time (120 when the stamp is exactly at minute 3; the check above accepts a stamp a few seconds later)
      expect((await pauseJob(sara.brickId, sara.id, jobId, minutes(5))).ok).toBe(true);
      const billed = Math.round((minutes(5).getTime() - ready.stretchStarted!.getTime()) / 1000);
      expect(billed).toBeGreaterThanOrEqual(110);
      expect(billed).toBeLessThanOrEqual(120);
      const job = await jobOf(jobId);
      expect(job.secondsRun + job.secondsBilled).toBe(billed);
      expect(await chargedSeconds(jobId)).toBe(billed);
    });

    it('the database refuses a job that is restoring and has a stretch started', async () => {
      const { jobId } = await running('b2-check');
      await expect(prisma.$executeRaw`UPDATE "computer_jobs" SET "prep_state" = 'restoring' WHERE "id" = ${jobId}`).rejects.toThrow(/computer_jobs_prep_unbilled/);
      expect((await jobOf(jobId)).prepState).toBeNull();
    });

    it('the person takes the machine while the job is being made ready: the job joins them with no stretch started (it is billed once it is ready)', async () => {
      const { sara, jobId } = await stuckInRecovery('b2-person');
      expect((await takeOver(sara.brickId, sara.id, minutes(3))).ok).toBe(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', prepState: 'recover', stretchStarted: null });
    });
  });

  describe('C7: a job the month or a limit paused carries on by itself when more arrives', () => {
    it('C7.0 the sweep itself carries it on (nothing else needs to ask): out of time it waits, with more it runs again on a new room', async () => {
      const { jobId, epoch } = await running('c7-sweep');
      const firstRoom = (await jobOf(jobId)).reservationKey;
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(5), { epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      await sweepComputers(minutes(6));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      await setUp();
      await sweepComputers(minutes(7));
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'running', queuedFor: null, pausedWhy: null, endedBy: null });
      expect(after.reservationKey).not.toBeNull();
      expect(after.reservationKey).not.toBe(firstRoom);
    });

    it('C7.1 more in the month: the OLDEST paused job of the person carries on first, one at a time, through a conditional flip and a NEW reservation; Brick tells once', async () => {
      const sara = await person('c7-order');
      const other = await createBrick({ ownerId: sara.id, name: 'Second Brick' });
      await giveComputer(sara.brickId, sara.id);
      await giveComputer(other.id, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Oldest' }, NOW);
      const b = await startJob({ botId: other.id, personId: sara.id, title: 'Newer' }, NOW);
      if (!a.ok || !b.ok) throw new Error('not started');
      const ea = await claimed(a.job.id, 'rA');
      const eb = await claimed(b.job.id, 'rA');
      const firstRoom = (await jobOf(a.job.id)).reservationKey;
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(a.job.id, minutes(5), { epoch: ea });
      await renewJob(b.job.id, minutes(6), { epoch: eb });
      // Still out: nothing carries on, nothing is told again, the order is kept
      expect(await carryOnPaused(minutes(7))).toBe(0);
      expect((await jobOf(a.job.id)).pausedAt).toEqual(minutes(5));
      await setUp();
      expect(await carryOnPaused(minutes(8))).toBe(1);
      expect(await jobOf(a.job.id)).toMatchObject({ status: 'running', pausedWhy: null });
      expect((await jobOf(a.job.id)).reservationKey).not.toBe(firstRoom);
      expect(await jobOf(b.job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      expect(await carryOnPaused(minutes(9))).toBe(1);
      expect(await jobOf(b.job.id)).toMatchObject({ status: 'running' });
      expect((await tellings(a.job.id)).map((one) => one.kind)).toEqual(['paused', 'carried_on']);
      const said = await told(minutes(10));
      expect(said.filter((one) => one.kind === 'carried_on').map((one) => one.jobId).sort()).toEqual([a.job.id, b.job.id].sort());
    });

    it('C7.1 a new month, and a limit raised, each carry a paused job on', async () => {
      const month = await running('c7-month');
      await setUp({ memberAllowanceMicros: 70_000 });
      await renewJob(month.jobId, minutes(5), { epoch: month.epoch });
      expect(await carryOnPaused(minutes(6))).toBe(0);
      const december = new Date('2026-12-01T00:05:00Z');
      expect(await carryOnPaused(december)).toBe(1);
      expect(await jobOf(month.jobId)).toMatchObject({ status: 'running' });
      await setUp();
      const ruled = await running('c7-rule');
      const r = await rule(ruled.sara, 10);
      await renewJob(ruled.jobId, minutes(5), { epoch: ruled.epoch });
      expect(await carryOnPaused(minutes(6))).toBe(0);
      await prisma.spendRule.update({ where: { id: r.id }, data: { capMicros: BigInt(10_000_000) } });
      expect(await carryOnPaused(minutes(7))).toBe(1);
      expect(await jobOf(ruled.jobId)).toMatchObject({ status: 'running' });
    });

    it('C7.2 a job the person paused themselves never carries on by itself', async () => {
      const { sara, jobId } = await running('c7-person');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      expect(await carryOnPaused(minutes(6))).toBe(0);
      await sweepComputers(minutes(7));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
      expect(await tellings(jobId)).toEqual([]);
    });

    it('C7.2b a job the person took over as their own pause AFTER the sweep picked it (they resumed it, then paused it) is not carried on: the flip re-reads it under its lock', async () => {
      const { sara, jobId, epoch } = await running('c7-race');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      // Right after the sweep chose it (its first read of the Brick's computer), the person's own pause replaces the month's
      const real = prisma.brickComputer.findUnique.bind(prisma.brickComputer) as unknown as (args: unknown) => Promise<unknown>;
      let fired = false;
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementation(((args: { where?: { botId?: string } }) =>
        real(args).then(async (row) => {
          if (!fired && args?.where?.botId === sara.brickId) {
            fired = true;
            await prisma.computerJob.update({ where: { id: jobId }, data: { pausedWhy: 'person', pausedAt: minutes(6) } });
          }
          return row;
        })) as never);
      try {
        expect(await carryOnPaused(minutes(6))).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
      expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused']);
    });

    it('C7.3 the Brick’s Apps changed, or a step’s outcome is not known: it stays paused and Brick asks ONCE; CONTROL: unchanged, it carries on', async () => {
      const apps = await running('c7-apps');
      const step = await running('c7-step');
      const ctl = await running('c7-ctl');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(apps.jobId, minutes(5), { epoch: apps.epoch });
      await prisma.botMcpServer.create({ data: { botId: apps.sara.brickId, name: 'New App', serverUrl: 'https://app.example.test/mcp' } });
      await renewJob(step.jobId, minutes(5), { epoch: step.epoch });
      await prisma.computerEffect.create({ data: { jobId: step.jobId, effectKey: 'send-1', kind: 'send', state: 'planned' } });
      await renewJob(ctl.jobId, minutes(5), { epoch: ctl.epoch });
      await setUp();
      expect(await carryOnPaused(minutes(6))).toBe(1);
      expect(await jobOf(ctl.jobId)).toMatchObject({ status: 'running' });
      for (const jobId of [apps.jobId, step.jobId]) {
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
        expect((await tellings(jobId)).map((one) => one.kind)).toEqual(['paused', 'can_carry_on']);
      }
      expect(await carryOnPaused(minutes(7))).toBe(0);
      expect((await tellings(apps.jobId)).map((one) => one.kind)).toEqual(['paused', 'can_carry_on']);
      const said = await told(minutes(8));
      expect(said.filter((one) => one.kind === 'can_carry_on').map((one) => one.jobId).sort()).toEqual([apps.jobId, step.jobId].sort());
      // The person says yes: their resume carries it on
      expect(await resumeJob(apps.sara.brickId, apps.sara.id, apps.jobId, minutes(9))).toMatchObject({ ok: true });
      expect(await jobOf(apps.jobId)).toMatchObject({ status: 'running' });
    });

    it('CodeRabbit D8: a job that paused AGAIN after the sweep read its blocked call is judged by that pause on a later sweep: nothing is asked or written for it from the first pause’s estimate; CONTROL: the same job with no second pause is asked', async () => {
      const again = await running('c7-again');
      const once = await running('c7-once');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(again.jobId, minutes(5), { epoch: again.epoch });
      await renewJob(once.jobId, minutes(5), { epoch: once.epoch });
      for (const jobId of [again.jobId, once.jobId]) await prisma.computerEffect.create({ data: { jobId, effectKey: 'send-1', kind: 'send', state: 'planned' } });
      await setUp();
      // Between the sweep's read of the estimate and the job's locked read, the job is paused a second time
      const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      let fired = false;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: unknown) => {
        if (typeof fn !== 'function') return original(fn, options);
        return original(async (tx: Record<string, unknown>) => {
          const jobs = tx.computerJob as { findUniqueOrThrow: (args: unknown) => Promise<unknown>; update: (args: unknown) => Promise<unknown> };
          const wrapped = new Proxy(jobs, {
            get: (target, name) =>
              name === 'findUniqueOrThrow'
                ? async (args: { where: { id: string } }) => {
                    if (!fired && args.where.id === again.jobId) {
                      fired = true;
                      await target.update({ where: { id: again.jobId }, data: { pauses: { increment: 1 } } });
                    }
                    return target.findUniqueOrThrow(args);
                  }
                : Reflect.get(target, name),
          });
          return (fn as (client: unknown) => unknown)(new Proxy(tx, { get: (target, name) => (name === 'computerJob' ? wrapped : Reflect.get(target, name)) }));
        }, options);
      }) as unknown as typeof prisma.$transaction);
      try {
        expect(await carryOnPaused(minutes(6))).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect((await tellings(again.jobId)).map((one) => one.kind)).toEqual(['paused']);
      expect(await jobOf(again.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 2 });
      expect((await tellings(once.jobId)).map((one) => one.kind)).toEqual(['paused', 'can_carry_on']);
    });

    it('C7.4 two sweeps racing the same flip start it once: one reservation, one message', async () => {
      const { jobId, epoch } = await running('c7-race');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await setUp();
      const both = await Promise.all([carryOnPaused(minutes(6)), carryOnPaused(minutes(6))]);
      expect(both.reduce((sum, n) => sum + n, 0)).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await prisma.meterReservation.count({ where: { jobId, state: 'held', reservationKey: { startsWith: 'computer:job:' } } })).toBe(1);
      expect((await tellings(jobId)).filter((one) => one.kind === 'carried_on')).toHaveLength(1);
    });

    it('Stop ends a job the month paused (nothing held, nothing more charged); its messages are never offered after', async () => {
      const { sara, jobId, epoch } = await running('c7-stop');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(jobId, minutes(5), { epoch });
      await stopJobFor(sara.brickId, sara.id, minutes(6));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await timeEvents(jobId)).toHaveLength(1);
      await setUp();
      expect(await carryOnPaused(minutes(7))).toBe(0);
      expect(await told(minutes(8))).toEqual([]);
    });
  });

  describe('CodeRabbit on #1025: the carry-on scan advances past jobs that still cannot carry on', () => {
    it('a page of jobs held by a spending rule does not hold up a later job whose month has recovered: the scan goes on from where the last sweep stopped, and starts again once past the end', async () => {
      resetCarryOnScanForTests();
      // Four jobs held by a rule they keep hitting (older), then one the month paused and that can carry on now (newer). A batch of 1 reads 4 jobs a page
      const blocked: string[] = [];
      const heldBricks: string[] = [];
      for (const [i, at] of [5, 6, 7, 8].entries()) {
        const held = await running(`scan-rule-${i}`);
        await rule(held.sara, 1_000);
        await renewJob(held.jobId, minutes(at), { epoch: held.epoch });
        expect(await jobOf(held.jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'rule' });
        blocked.push(held.jobId);
        heldBricks.push(held.sara.brickId);
      }
      const free = await running('scan-free');
      await setUp({ memberAllowanceMicros: 1_000 });
      await renewJob(free.jobId, minutes(9), { epoch: free.epoch });
      await setUp();
      expect(await jobOf(free.jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'allowance' });
      // The first sweep reads the four held jobs and carries none on; the SAME four would be read at every sweep without a cursor
      expect(await carryOnPaused(minutes(20), 1)).toBe(0);
      expect(await jobOf(free.jobId)).toMatchObject({ queuedFor: 'paused' });
      // The next sweep starts after them and reaches the job that can carry on
      expect(await carryOnPaused(minutes(21), 1)).toBe(1);
      expect(await jobOf(free.jobId)).toMatchObject({ status: 'running', pausedWhy: null });
      // Past the end the scan starts again from the oldest AT ONCE (a page shorter than a full one is the end of the list): the oldest held job's rule is lifted, and the very next sweep carries it on
      await prisma.spendRule.deleteMany({ where: { botId: heldBricks[0] } });
      expect(await carryOnPaused(minutes(22), 1)).toBe(1);
      expect(await jobOf(blocked[0])).toMatchObject({ pausedWhy: null });
      for (const jobId of blocked.slice(1)) expect(await jobOf(jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'rule' });
    });
  });

  describe('CodeRabbit on #1025 (33): the scan cursor is the last job the sweep looked at', () => {
    it('a sweep that stops because its batch is full leaves the jobs after the one it carried on to the next sweep, in order (none is skipped)', async () => {
      resetCarryOnScanForTests();
      // Five jobs the month paused (older to newer), all able to carry on now. A batch of 1 reads a page of 4 and carries on the first
      const jobs: string[] = [];
      for (const [i, at] of [5, 6, 7, 8, 9].entries()) {
        const made = await running(`cr33-${i}`);
        await setUp({ memberAllowanceMicros: 1_000 });
        await renewJob(made.jobId, minutes(at), { epoch: made.epoch });
        expect(await jobOf(made.jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'allowance' });
        await setUp();
        jobs.push(made.jobId);
      }
      const statuses = async () => Promise.all(jobs.map(async (id) => (await jobOf(id)).status));
      expect(await carryOnPaused(minutes(20), 1)).toBe(1);
      expect(await statuses()).toEqual(['running', 'queued', 'queued', 'queued', 'queued']);
      // The next sweep goes on with the SECOND job, not past the page that was read to the fifth
      expect(await carryOnPaused(minutes(21), 1)).toBe(1);
      expect(await statuses()).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
      expect(await carryOnPaused(minutes(22), 1)).toBe(1);
      expect(await statuses()).toEqual(['running', 'running', 'running', 'queued', 'queued']);
    });
  });

  describe('N14: a paused job cannot be started or un-paused by a server of the version before this (a trigger, for the mixed-version window)', () => {
    /** A job paused by the person, in line with `queued_for = 'paused'` and a reason, as the new code leaves it. */
    async function paused(name: string, why: 'person' | 'limit' = 'person') {
      const made = await running(name);
      if (why === 'person') expect((await pauseJob(made.sara.brickId, made.sara.id, made.jobId, minutes(2))).ok).toBe(true);
      else {
        // The month runs out at a renewal: the job pauses for the allowance (as C5.1)
        await setUp({ memberAllowanceMicros: 1_000 });
        expect(await renewJob(made.jobId, minutes(5), { epoch: made.epoch })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
        await setUp();
      }
      expect(await jobOf(made.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: why === 'person' ? 'person' : 'allowance' });
      return made;
    }

    it('an old-style claim (queued to running with no paused filter, as the version before wrote it) on a paused job writes 0 rows and the job stays paused', async () => {
      const { jobId } = await paused('n14-claim');
      const done = await prisma.computerJob.updateMany({ where: { id: jobId, status: 'queued' }, data: { status: 'running', queuedFor: null, startedAt: minutes(3), stretchStarted: minutes(3) } });
      expect(done.count).toBe(0);
      const waiting = await prisma.computerJob.updateMany({ where: { id: jobId, status: 'queued' }, data: { status: 'waiting' } });
      expect(waiting.count).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person' });
    });

    it('an old-style `queued_for = busy` write on a paused job (a limit pause too) writes 0 rows and it is still paused', async () => {
      for (const why of ['person', 'limit'] as const) {
        const { jobId } = await paused(`n14-busy-${why}`, why);
        const done = await prisma.computerJob.updateMany({ where: { id: jobId, status: 'queued' }, data: { queuedFor: 'busy' } });
        expect(done.count).toBe(0);
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      }
    });

    it('resume, the carry-on by itself, cancel and Stop of a paused job still work: the trigger blocks no new-code path and never an ending', async () => {
      // Resume (clears the reason in the same write that moves it off `paused`)
      const resumed = await paused('n14-resume');
      expect((await resumeJob(resumed.sara.brickId, resumed.sara.id, resumed.jobId, minutes(4))).ok).toBe(true);
      expect(await jobOf(resumed.jobId)).toMatchObject({ status: 'running', pausedWhy: null });
      // The carry-on by itself of a job the month paused
      const limited = await paused('n14-carry', 'limit');
      await prisma.meterEvent.deleteMany({});
      expect(await carryOnPaused(minutes(6))).toBeGreaterThanOrEqual(1);
      expect(await jobOf(limited.jobId)).toMatchObject({ status: expect.stringMatching(/running|queued/), pausedWhy: null });
      expect((await jobOf(limited.jobId)).queuedFor).not.toBe('paused');
      // Cancel of one paused job, and the person's Stop of another
      const cancelled = await paused('n14-cancel');
      expect((await cancelJob(cancelled.sara.brickId, cancelled.sara.id, cancelled.jobId, minutes(4))).ok).toBe(true);
      expect(await jobOf(cancelled.jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      const stopped = await paused('n14-stop');
      await stopJobFor(stopped.sara.brickId, stopped.sara.id, minutes(4));
      expect(await jobOf(stopped.jobId)).toMatchObject({ status: 'stopped' });
    });

    it('an ending of a paused job is never blocked, whatever else the write moves (a purge or an admin ending included)', async () => {
      const { jobId } = await paused('n14-end');
      const ended = await prisma.computerJob.updateMany({ where: { id: jobId }, data: { status: 'stopped', queuedFor: 'busy', endedAt: minutes(5), endedBy: 'off' } });
      expect(ended.count).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'off' });
    });
  });
});
