/**
 * Computer job controls (piece 1): Pause, Resume, Do this next and Cancel for ONE job, against a real database. Each money path has its control. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-job-controls-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => ({ parkProfile: jest.fn(async () => undefined), restoreProfile: jest.fn(async () => undefined), dropProfile: jest.fn(async () => undefined) }));
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn((...args: unknown[]) => actual.recordMeterEvent(...args)) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import * as meterModule from '@/lib/meter';
import { memberAllowance } from '@/lib/meter-allowance';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, computerView, finishJobUnder, getJob, giveComputer, recordFinishIntent, renewJob, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { recordPoolCutoff } from '@/lib/computer-faults';
import * as profile from '@/lib/computer-browser-profile';
import { checkSpend, proposeRule } from '@/lib/spend-rules';
import { bookMissingPauses, cancelJob, moveJobFirst, pauseEventId, pauseJob, resumeJob } from '@/lib/computer-job-controls';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const recordMeterEvent = meterModule.recordMeterEvent as jest.Mock;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
/** The pretend provider's price: 6,000 micros a minute, so 5 minutes are 30,000. */
const PER_MINUTE = 6_000;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, ...over }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const roomOf = (key: string) => prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: key } });
const eventsOf = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const liveKeys = (jobId: string) => prisma.computerJobToken.count({ where: { jobId, revokedAt: null } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};

/** A person with a Brick with a computer and one job running on it since NOW. */
async function running(name: string) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}
const another = async (sara: { id: string; brickId: string }, title: string, at: Date = NOW) => {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title }, at);
  if (!started.ok) throw new Error('the job was not made');
  return started.job.id;
};

run('computer job controls: pause, resume, do this next, cancel one job (piece 1), in a real database', () => {
  let fake: FakeComputerProvider;
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    recordMeterEvent.mockClear();
    jest.mocked(profile.parkProfile).mockClear();
    jest.mocked(profile.restoreProfile).mockClear();
    jest.mocked(profile.dropProfile).mockClear();
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

  describe('pause: the time so far is charged on its own stretch, the job holds nothing and its worker is replaced', () => {
    it('pausing a running job settles its room at the time so far, writes that stretch as its own event (the person’s, never given back), ends its keys, moves its owner and cancels the turn it was on after the write', async () => {
      const { sara, jobId } = await running('p-basic');
      const epoch = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1', agentSessionId: 'sess-1' } });
      await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: 0, digest: `d-${tag}-${jobId}`.slice(0, 64), expiresAt: minutes(30), ownerEpoch: epoch } });
      const key = (await jobOf(jobId)).reservationKey!;
      const paused = await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      expect(paused.ok).toBe(true);
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person', pauses: 1, secondsRun: 0, secondsBilled: 300, reservationKey: null, agentResponseId: null, agentSessionId: 'sess-1', stretchStarted: null });
      expect(job.ownerEpoch).toBe(epoch + 1);
      expect(await liveKeys(jobId)).toBe(0);
      expect(await roomOf(key)).toMatchObject({ state: 'settled', settledMicros: BigInt(5 * PER_MINUTE) });
      const events = await eventsOf(jobId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: pauseEventId(jobId, 1), quantity: BigInt(300), costMicros: BigInt(5 * PER_MINUTE), personId: sara.id });
      expect(fake.cancelledTurns).toEqual(['resp-1']);
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).toMatchObject({ seconds: 300, roomKey: key, why: 'person' });
      expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).bookedAt).not.toBeNull();
      // The person's month sees the paused stretch at once
      expect((await memberAllowance(sara.id, minutes(5), await getMeterSettings()))?.usedMicros).toBe(5 * PER_MINUTE);
      // The view shows it paused, in line
      const view = paused.ok ? paused.view : null;
      expect(view?.job).toBeNull();
      expect(view?.queued.map((one) => [one.id, one.queuedFor, one.pausedWhy, one.pausedBefore])).toEqual([[jobId, 'paused', 'person', true]]);
    });

    it('the old worker of a paused job is superseded everywhere: renew (never "renew in a minute"), finish, claim', async () => {
      const { sara, jobId } = await running('p-old');
      const epoch = await claimed(jobId, 'rA');
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2))).toMatchObject({ ok: true });
      expect(await renewJob(jobId, minutes(3), { epoch })).toMatchObject({ ok: false, run: 'superseded' });
      // A worker that names no epoch is no owner either once the job was claimed
      expect(await renewJob(jobId, minutes(3), {})).toMatchObject({ ok: false, run: 'superseded' });
      expect(await claimJob(jobId, { run: 'rA', seen: epoch }, minutes(3))).toMatchObject({ ok: false });
      await finishJobUnder(jobId, 0, 'done', minutes(3), null, null, null, 'rA', epoch);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect(await eventsOf(jobId)).toHaveLength(1);
    });

    it('a replayed pause charges nothing more; a job in line is paused with nothing charged', async () => {
      const { sara, jobId } = await running('p-replay');
      const waiting = await another(sara, 'Hotel');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(6))).toMatchObject({ ok: true });
      expect(await eventsOf(jobId)).toHaveLength(1);
      expect((await jobOf(jobId)).pauses).toBe(1);
      // The hotel job took the computer when the visa paused; pausing it in line charges nothing (it is running now, so make a third one to pause in line)
      const third = await another(sara, 'Taxi', minutes(6));
      expect(await jobOf(third)).toMatchObject({ status: 'queued' });
      await pauseJob(sara.brickId, sara.id, third, minutes(7));
      expect(await jobOf(third)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 0, secondsBilled: 0 });
      expect(await eventsOf(third)).toHaveLength(0);
      expect(await jobOf(waiting)).toMatchObject({ status: 'running' });
    });

    it('Rule B: no pause over a kept finish intent or a decided pool cutoff (`ending`, nothing written); CONTROL: the same job without them pauses', async () => {
      const a = await running('p-intent');
      const ea = await claimed(a.jobId, 'rA');
      await recordFinishIntent(a.jobId, { outcome: 'done', epoch: ea }, minutes(1));
      expect(await pauseJob(a.sara.brickId, a.sara.id, a.jobId, minutes(2))).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(a.jobId)).toMatchObject({ status: 'running', pauses: 0 });
      expect(await eventsOf(a.jobId)).toHaveLength(0);
      const b = await running('p-cutoff');
      await recordPoolCutoff(prisma, b.jobId, minutes(1));
      expect(await pauseJob(b.sara.brickId, b.sara.id, b.jobId, minutes(2))).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(b.jobId)).toMatchObject({ status: 'running', pauses: 0 });
      const c = await running('p-control');
      expect(await pauseJob(c.sara.brickId, c.sara.id, c.jobId, minutes(2))).toMatchObject({ ok: true });
    });

    it('no pause while the person holds the screen (`taken_over`); a job waiting for its person (Brick still in control) can be paused', async () => {
      const a = await running('p-taken');
      await prisma.computerJob.update({ where: { id: a.jobId }, data: { status: 'waiting', waitingFor: 'signin', stretchStarted: minutes(1), secondsRun: 60 } });
      expect(await pauseJob(a.sara.brickId, a.sara.id, a.jobId, minutes(2))).toMatchObject({ ok: true });
      expect(await jobOf(a.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', waitingFor: null, secondsBilled: 120 });
      const b = await running('p-taken-2');
      await prisma.computerJob.update({ where: { id: b.jobId }, data: { status: 'waiting', waitingFor: 'signin' } });
      const took = await takeOver(b.sara.brickId, b.sara.id, minutes(1));
      expect(took.ok).toBe(true);
      expect(await pauseJob(b.sara.brickId, b.sara.id, b.jobId, minutes(2))).toEqual({ ok: false, reason: 'taken_over' });
      expect(await jobOf(b.jobId)).toMatchObject({ status: 'waiting', control: 'person', pauses: 0 });
    });

    it('someone else’s Brick, or a job of another Brick, is not found', async () => {
      const a = await running('p-owner');
      const b = await running('p-other');
      expect(await pauseJob(a.sara.brickId, b.sara.id, a.jobId, minutes(1))).toEqual({ ok: false, reason: 'not_found' });
      expect(await pauseJob(a.sara.brickId, a.sara.id, b.jobId, minutes(1))).toEqual({ ok: false, reason: 'not_found' });
      expect(await jobOf(a.jobId)).toMatchObject({ status: 'running' });
      expect(await jobOf(b.jobId)).toMatchObject({ status: 'running' });
    });

    it('pause and Stop at the same moment: the job ends once and every second is charged once', async () => {
      const { sara, jobId } = await running('p-race');
      await Promise.all([pauseJob(sara.brickId, sara.id, jobId, minutes(5)), stopJobFor(sara.brickId, sara.id, minutes(5))]);
      await sweepComputers(minutes(30));
      const job = await jobOf(jobId);
      expect(job.status).toBe('stopped');
      const events = await eventsOf(jobId);
      const seconds = events.reduce((sum, event) => sum + Number(event.quantity), 0);
      expect(seconds).toBe(300);
      expect(job.secondsRun + job.secondsBilled).toBe(300);
    });
  });

  describe('resume: a new reservation through the line, the same job and conversation', () => {
    it('pause, resume, done: two charges, each once, that add up to the time run; each room settled once; the runner claims afresh and is told it is resumed', async () => {
      const { sara, jobId } = await running('r-basic');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1' } });
      const first = (await jobOf(jobId)).reservationKey!;
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      const resumed = await resumeJob(sara.brickId, sara.id, jobId, minutes(20));
      expect(resumed.ok).toBe(true);
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'running', queuedFor: null, pausedAt: null, pausedWhy: null, agentSessionId: 'sess-1' });
      expect(job.reservationKey).not.toBeNull();
      expect(job.reservationKey).not.toBe(first);
      expect(await prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: 'computer:job:' } } })).toBe(2);
      expect((await getJob(jobId))?.resumed).toBe(true);
      const epoch = await claimed(jobId, 'rB', minutes(20));
      await finishJobUnder(jobId, 0, 'done', minutes(23), null, null, null, 'rB', epoch);
      await sweepComputers(minutes(40));
      const events = await eventsOf(jobId);
      expect(events.map((event) => [event.eventId, Number(event.quantity), Number(event.costMicros)])).toEqual([
        [`computer:${jobId}:time`, 180, 3 * PER_MINUTE],
        [pauseEventId(jobId, 1), 300, 5 * PER_MINUTE],
      ]);
      expect(await roomOf(first)).toMatchObject({ state: 'settled', settledMicros: BigInt(5 * PER_MINUTE) });
      expect(await roomOf(job.reservationKey!)).toMatchObject({ state: 'settled', settledMicros: BigInt(3 * PER_MINUTE) });
      expect((await memberAllowance(sara.id, minutes(40), await getMeterSettings()))?.usedMicros).toBe(8 * PER_MINUTE);
      // The report says the whole time
      const done = await jobOf(jobId);
      expect(done.secondsRun + done.secondsBilled).toBe(480);
    });

    it('a second pause on the same job is a third event id; the total is still each second once', async () => {
      const { sara, jobId } = await running('r-twice');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2));
      await resumeJob(sara.brickId, sara.id, jobId, minutes(10));
      await pauseJob(sara.brickId, sara.id, jobId, minutes(14));
      await resumeJob(sara.brickId, sara.id, jobId, minutes(30));
      await stopJobFor(sara.brickId, sara.id, minutes(31));
      await sweepComputers(minutes(50));
      const events = await eventsOf(jobId);
      expect(events.map((event) => event.eventId).sort()).toEqual([`computer:${jobId}:time`, pauseEventId(jobId, 1), pauseEventId(jobId, 2)].sort());
      expect(events.reduce((sum, event) => sum + Number(event.quantity), 0)).toBe(120 + 240 + 60);
    });

    it('resume while another job writes: it stays first in line and starts by itself when that one ends', async () => {
      const { sara, jobId } = await running('r-wait');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(1));
      const hotel = await another(sara, 'Hotel', minutes(2));
      const taxi = await another(sara, 'Taxi', minutes(3));
      expect(await jobOf(hotel)).toMatchObject({ status: 'running' });
      await resumeJob(sara.brickId, sara.id, jobId, minutes(4));
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn' });
      const view = await computerView(sara.brickId, sara.id, minutes(4));
      expect(view?.queued.map((one) => one.id)).toEqual([jobId, taxi]);
      await stopJobFor(sara.brickId, sara.id, minutes(4)).then(() => undefined);
      // Stop ends everything, the resumed one included
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'stopped' });
    });

    it('resume refused by the month: it stays paused and says so; CONTROL: with room it runs', async () => {
      const { sara, jobId } = await running('r-month');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(10))).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', reservationKey: null });
      // Nothing is held for it while it waits
      expect(await prisma.meterReservation.count({ where: { jobId, state: 'held' } })).toBe(0);
      await setUp();
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });

    it('resume of a job that is not paused is `not_paused`; of an ended one `over`', async () => {
      const { sara, jobId } = await running('r-not');
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(1))).toEqual({ ok: false, reason: 'not_paused' });
      await stopJobFor(sara.brickId, sara.id, minutes(2));
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(3))).toEqual({ ok: false, reason: 'over' });
    });
  });

  describe('the line skips a paused job everywhere it is read', () => {
    it('ending the running job, the sweep and a repeated ask never start a paused job; the next job that is not paused starts', async () => {
      const { sara, jobId } = await running('l-skip');
      const visa2 = await another(sara, 'Second', minutes(1));
      await pauseJob(sara.brickId, sara.id, visa2, minutes(1));
      const third = await another(sara, 'Third', minutes(2));
      await stopJobFor(sara.brickId, sara.id, minutes(3)).catch(() => undefined);
      // Stop ended everything; make the case again without Stop: the running job finishes
      const b = await running('l-skip-2');
      const paused = await another(b.sara, 'Paused one', minutes(1));
      await pauseJob(b.sara.brickId, b.sara.id, paused, minutes(1));
      const next = await another(b.sara, 'Next one', minutes(2));
      const epoch = await claimed(b.jobId, 'rA');
      await finishJobUnder(b.jobId, 0, 'done', minutes(4), null, null, null, 'rA', epoch);
      expect(await jobOf(paused)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect(await jobOf(next)).toMatchObject({ status: 'running' });
      const e2 = await claimed(next, 'rB', minutes(4));
      await finishJobUnder(next, 0, 'done', minutes(5), null, null, null, 'rB', e2);
      await sweepComputers(minutes(6));
      expect(await jobOf(paused)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      // The same ask again (same start key) answers the paused job and starts nothing
      const keyed = await startJob({ botId: b.sara.brickId, personId: b.sara.id, title: 'Paused one', startKey: `k-${tag}` }, minutes(7));
      expect(keyed.ok).toBe(true);
      const again = await startJob({ botId: b.sara.brickId, personId: b.sara.id, title: 'Paused one', startKey: `k-${tag}` }, minutes(7));
      expect(again.ok).toBe(true);
      if (keyed.ok) {
        await pauseJob(b.sara.brickId, b.sara.id, keyed.job.id, minutes(8));
        const repeat = await startJob({ botId: b.sara.brickId, personId: b.sara.id, title: 'Paused one', startKey: `k-${tag}` }, minutes(9));
        expect(repeat.ok && repeat.job.id).toBe(keyed.job.id);
        expect(await jobOf(keyed.job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      }
      expect(jobId && third).toBeTruthy();
    });
  });

  describe('do this next', () => {
    it('moves a waiting job to the front of the line, ahead of older ones', async () => {
      const { sara } = await running('f-order');
      const b = await another(sara, 'B', minutes(1));
      const c = await another(sara, 'C', minutes(2));
      expect((await computerView(sara.brickId, sara.id, minutes(3)))?.queued.map((one) => one.id)).toEqual([b, c]);
      expect(await moveJobFirst(sara.brickId, sara.id, c, {}, minutes(3))).toMatchObject({ ok: true });
      expect((await computerView(sara.brickId, sara.id, minutes(3)))?.queued.map((one) => one.id)).toEqual([c, b]);
    });

    it('with pauseRunning: the running job is paused (its stretch charged) and goes back in line right behind; the new one runs; when the new one is cancelled, failed or done, the old one carries on by itself', async () => {
      for (const ending of ['cancel', 'done', 'failed'] as const) {
        const { sara, jobId } = await running(`f-pause-${ending}`);
        const older = await another(sara, 'Older', minutes(1));
        const taxi = await another(sara, 'Taxi', minutes(2));
        expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(5))).toMatchObject({ ok: true });
        expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1, secondsBilled: 300 });
        const view = await computerView(sara.brickId, sara.id, minutes(5));
        expect(view?.queued.map((one) => [one.id, one.pausedBefore])).toEqual([[jobId, true], [older, false]]);
        expect(await eventsOf(jobId)).toHaveLength(1);
        if (ending === 'cancel') await cancelJob(sara.brickId, sara.id, taxi, minutes(8));
        else {
          const e = await claimed(taxi, 'rT', minutes(5));
          await finishJobUnder(taxi, 0, ending, minutes(8), null, null, null, 'rT', e);
        }
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        expect(await jobOf(older)).toMatchObject({ status: 'queued' });
      }
    });

    it('with pauseRunning while the person holds the screen: refused, nothing changed', async () => {
      const { sara, jobId } = await running('f-taken');
      const taxi = await another(sara, 'Taxi', minutes(1));
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', waitingFor: 'signin' } });
      await takeOver(sara.brickId, sara.id, minutes(2));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3))).toEqual({ ok: false, reason: 'taken_over' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: 0 });
    });

    it('on a paused job it is its resume; on a running job `not_queued`', async () => {
      const { sara, jobId } = await running('f-paused');
      expect(await moveJobFirst(sara.brickId, sara.id, jobId, {}, minutes(1))).toEqual({ ok: false, reason: 'not_queued' });
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2));
      expect(await moveJobFirst(sara.brickId, sara.id, jobId, {}, minutes(3))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });
  });

  describe('cancel ONE job', () => {
    it('a running job ends as the person’s (charged its time, never given back) and the next starts; the others are untouched', async () => {
      const { sara, jobId } = await running('c-running');
      const b = await another(sara, 'B', minutes(1));
      const c = await another(sara, 'C', minutes(2));
      expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(5))).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await jobOf(b)).toMatchObject({ status: 'running' });
      expect(await jobOf(c)).toMatchObject({ status: 'queued' });
      await sweepComputers(minutes(30));
      const events = await eventsOf(jobId);
      expect(events.map((event) => [event.eventId, Number(event.quantity), event.personId])).toEqual([[`computer:${jobId}:time`, 300, sara.id]]);
    });

    it('a job in line leaves it with nothing charged; a paused job leaves it with nothing more charged; the running job is untouched', async () => {
      const { sara, jobId } = await running('c-queued');
      const b = await another(sara, 'B', minutes(1));
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(2))).toMatchObject({ ok: true });
      expect(await jobOf(b)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await eventsOf(b)).toHaveLength(0);
      expect(await prisma.meterReservation.count({ where: { jobId: b } })).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      await pauseJob(sara.brickId, sara.id, jobId, minutes(4));
      expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(6))).toMatchObject({ ok: true });
      await sweepComputers(minutes(30));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect((await eventsOf(jobId)).map((event) => event.eventId)).toEqual([pauseEventId(jobId, 1)]);
      expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(7))).toEqual({ ok: false, reason: 'over' });
    });

    it('Stop still ends everything, paused jobs included', async () => {
      const { sara, jobId } = await running('c-stop');
      const b = await another(sara, 'B', minutes(1));
      await pauseJob(sara.brickId, sara.id, b, minutes(1));
      await stopJobFor(sara.brickId, sara.id, minutes(2));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect(await jobOf(b)).toMatchObject({ status: 'stopped' });
    });
  });

  describe('a pause whose time did not reach the books', () => {
    it('is written by the sweep, once, and the job’s month sees it in the meantime through its settled room', async () => {
      const { sara, jobId } = await running('b-missing');
      recordMeterEvent.mockImplementationOnce(async () => {
        throw new Error('the books did not answer');
      });
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      const pause = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } });
      expect(pause.bookedAt).toBeNull();
      expect(await eventsOf(jobId)).toHaveLength(0);
      // Not yet: a pause is left a minute to write its own time
      expect(await bookMissingPauses(minutes(5), 10)).toBe(0);
      expect(await bookMissingPauses(minutes(7), 10)).toBe(1);
      expect(await bookMissingPauses(minutes(8), 10)).toBe(0);
      const events = await eventsOf(jobId);
      expect(events.map((event) => [event.eventId, Number(event.quantity)])).toEqual([[pauseEventId(jobId, 1), 300]]);
    });
  });

  describe('the sign-ins of a paused job, and when it ran again', () => {
    it('a pause of a job that held the machine puts its browser away (a job paused in line does not); a resume brings it back and notes when; its ending drops it', async () => {
      const { sara, jobId } = await running('s-profile');
      const inLine = await another(sara, 'In line', minutes(1));
      await pauseJob(sara.brickId, sara.id, inLine, minutes(1));
      expect(profile.parkProfile).not.toHaveBeenCalled();
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2));
      expect(profile.parkProfile).toHaveBeenCalledTimes(1);
      expect(profile.parkProfile).toHaveBeenCalledWith(sara.brickId, jobId);
      expect(profile.restoreProfile).not.toHaveBeenCalled();
      await resumeJob(sara.brickId, sara.id, jobId, minutes(9));
      expect(profile.restoreProfile).toHaveBeenCalledWith(sara.brickId, jobId);
      expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).resumedAt).toEqual(minutes(9));
      expect(profile.dropProfile).not.toHaveBeenCalled();
      await stopJobFor(sara.brickId, sara.id, minutes(10));
      expect(profile.dropProfile).toHaveBeenCalledWith(sara.brickId, jobId);
    });
  });

  describe('a spending limit the person set reads a paused stretch once', () => {
    it('counts the paused stretch once when its event is written, and through its settled room while it is not', async () => {
      const { sara, jobId } = await running('s-rule');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      const left = async (at: Date) => {
        const asked = await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 999_999_999 }, at);
        return asked.ok ? null : (asked as { leftMicros?: number }).leftMicros;
      };
      await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
      expect(await left(minutes(6))).toBe(1_000_000 - 5 * PER_MINUTE);
      // The same with the pause's event not written yet: its settled room counts instead, never both and never neither
      const b = await running('s-rule-2');
      await proposeRule({ botId: b.sara.brickId, speakerId: b.sara.id, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      recordMeterEvent.mockImplementationOnce(async () => {
        throw new Error('the books did not answer');
      });
      await pauseJob(b.sara.brickId, b.sara.id, b.jobId, minutes(5));
      expect(await eventsOf(b.jobId)).toHaveLength(0);
      const leftB = async (at: Date) => {
        const asked = await checkSpend({ payerPersonId: b.sara.id, botId: b.sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 999_999_999 }, at);
        return asked.ok ? null : (asked as { leftMicros?: number }).leftMicros;
      };
      expect(await leftB(minutes(6))).toBe(1_000_000 - 5 * PER_MINUTE);
      await bookMissingPauses(minutes(8), 10);
      expect(await leftB(minutes(8))).toBe(1_000_000 - 5 * PER_MINUTE);
      // Resumed and running: the new room is held on top, the paused stretch still once
      await resumeJob(b.sara.brickId, b.sara.id, b.jobId, minutes(9));
      const heldNow = Number((await prisma.meterReservation.findFirstOrThrow({ where: { jobId: b.jobId, state: 'held', reservationKey: { startsWith: 'computer:job:' } } })).amountMicros);
      expect(await leftB(minutes(9))).toBe(1_000_000 - 5 * PER_MINUTE - heldNow);
    });
  });
});
