/**
 * GPT round 6, findings 4 and 11 (Rule D, identity of a control): every control the person gives a computer job carries its own command id, so a replay returns the stored outcome and writes nothing (no second
 * pause, time event, note number or provider cancel), and "do this first" is ONE transaction, so a refusal leaves the order and the stretches intact. Each case asserts the job, its epoch and stretch, its rooms,
 * its time events and the answer. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database, in UTC and in Kuwait time:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-controls-identity-db.test.ts --runInBand
 *   TZ=Asia/Kuwait ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-controls-identity-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});
// Whether the team paused computers is the real one behind a jest.fn: a test says the computers are paused for one request
jest.mock('@/lib/capability-pause', () => {
  const actual = jest.requireActual('@/lib/capability-pause');
  return { ...actual, computersArePaused: jest.fn((...args: unknown[]) => actual.computersArePaused(...args)) };
});
// The job lock is the real one behind a jest.fn: a test runs something at the moment a control takes a job's lock (what another request could do between a selection and a commit)
jest.mock('@/lib/computer-owner', () => {
  const actual = jest.requireActual('@/lib/computer-owner');
  return { ...actual, lockJob: jest.fn((...args: unknown[]) => actual.lockJob(...args)) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, controlInternals, finishJob, giveComputer, recordFinishIntent, startJob, stopAll, stopComputerWork } from '@/lib/computer';
import { cancelJob, moveJobFirst, pauseJob, resumeJob, resumeWait } from '@/lib/computer-job-controls';
import { addJobNote } from '@/lib/computer-job-notes';
import { claimCommand, commandRow, recordResumeDecision } from '@/lib/computer-commands';
import { carryOnPaused, resetCarryOnScanForTests } from '@/lib/computer-limit-pause';
import * as owner from '@/lib/computer-owner';
import * as capabilityPause from '@/lib/capability-pause';
import { dropProfile, parkProfile } from '@/lib/computer-browser-profile';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
const realComputersArePaused = jest.requireActual('@/lib/capability-pause').computersArePaused as typeof capabilityPause.computersArePaused;
const realLockJob = jest.requireActual('@/lib/computer-owner').lockJob as typeof owner.lockJob;
const lockJob = owner.lockJob as jest.MockedFunction<typeof owner.lockJob>;
let fake: FakeComputerProvider;
const command = () => ({ id: randomUUID() });
const notesOf = (jobId: string) => prisma.computerJobNote.findMany({ where: { jobId }, orderBy: { seq: 'asc' }, select: { seq: true, text: true } });
const commandOf = (id: string) => prisma.computerJobCommand.findUnique({ where: { commandId: id } });
/**
 * Watches the reads of a stored command: `seen` resolves when one of them finds the command still pending (what a copy of a control does while it waits for the first request's answer). A request that has not
 * finished does not prove it got there, so the tests below wait for this signal, and fail if the copy ends without it (`reached`).
 */
const watchPendingReads = () => {
  let found: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => (found = resolve));
  const real = prisma.$queryRaw as unknown as (...args: unknown[]) => unknown;
  // Not bound to the root client: a transaction's client inherits the method and runs it on itself
  const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const result = real.apply(this, args);
    const first = args[0];
    const text = Array.isArray(first) ? first.join('?') : '';
    if (!text.includes('"args_hash"') || !text.includes('FROM "computer_job_commands"')) return result;
    return Promise.resolve(result).then((rows) => {
      if ((rows as Array<{ outcome?: { pending?: boolean } | null }>)[0]?.outcome?.pending === true) found();
      return rows;
    });
  } as never);
  return {
    stop: () => spy.mockRestore(),
    /** Resolves when the copy has read the pending command; rejects when the copy ended first (its own failure, or an answer given without having waited for the first request). */
    reached: (copy: Promise<unknown>) =>
      Promise.race([seen, copy.then(() => Promise.reject(new Error('the copy answered before it read the pending command')))]),
  };
};
/**
 * Waits for a gate's entry signal, racing it against the first request that is supposed to reach the gate: if that request returns or rejects before entering, the wait fails at once with that outcome
 * (never a hang until the test times out, which would also skip the cleanup).
 */
const enteredBy = (signal: Promise<void>, request: Promise<unknown>): Promise<void> =>
  Promise.race([signal, request.then(() => Promise.reject(new Error('the first request ended before it reached the gate')))]);
async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: unique, brickId: brick.id };
}
type Person = Awaited<ReturnType<typeof person>>;

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const eventsOf = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const pausesOf = (jobId: string) => prisma.computerJobPause.count({ where: { jobId } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};
/** A person with a Brick with a computer, one job running on it since NOW and claimed by its runner. */
async function running(name: string) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  const epoch = await claimed(started.job.id, 'rA');
  return { sara, jobId: started.job.id, epoch };
}
const another = async (sara: Person, title: string, at: Date = NOW) => {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title }, at);
  if (!started.ok) throw new Error('the job was not made');
  return started.job.id;
};
/** Runs `between` once, right before a control takes the lock of job `jobId` (in its own transaction: another request landing first). */
const beforeLockOf = (jobId: string, between: () => Promise<unknown>) => {
  let fired = false;
  lockJob.mockImplementation((async (tx: Parameters<typeof owner.lockJob>[0], id: string) => {
    if (!fired && id === jobId) {
      fired = true;
      await between();
    }
    return realLockJob(tx, id);
  }) as typeof owner.lockJob);
};

run('findings 4 and 11 (GPT round 6): one control, one effect, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    lockJob.mockImplementation(realLockJob);
    await setUp();
  });
  afterAll(async () => {
    lockJob.mockImplementation(realLockJob);
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('finding 11: "do this first" is atomic', () => {
    it('REPRO: the person takes the screen between the selection and the commit: `taken_over`, and the target’s rank, the running job’s stretch, epoch and time are all unchanged', async () => {
      const { sara, jobId, epoch } = await running('f11-taken');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      beforeLockOf(jobId, () => prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', control: 'person', waitingFor: 'signin' } }));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3))).toEqual({ ok: false, reason: 'taken_over' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', pauses: 0, ownerEpoch: epoch, secondsBilled: 0 });
      expect(await eventsOf(jobId)).toHaveLength(0);
      expect(await pausesOf(jobId)).toBe(0);
    });

    it('REPRO: the runner keeps its finish intent between the selection and the commit: `ending`, nothing moved', async () => {
      const { sara, jobId, epoch } = await running('f11-ending');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      beforeLockOf(jobId, () => recordFinishIntent(jobId, { outcome: 'done', epoch }, minutes(2)));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3))).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0, ownerEpoch: epoch });
      expect(await eventsOf(jobId)).toHaveLength(0);
    });

    it('two concurrent "do this first" requests serialize on the Brick’s line: the running job is paused ONCE (one stretch, one event), and the line ends in one order', async () => {
      const { sara, jobId } = await running('f11-race');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const hotel = await another(sara, 'Hotel', minutes(1));
      const [a, b] = await Promise.all([moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3)), moveJobFirst(sara.brickId, sara.id, hotel, { pauseRunning: true }, minutes(3))]);
      expect([a.ok, b.ok]).toContain(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1 });
      expect(await pausesOf(jobId)).toBe(1);
      expect(await eventsOf(jobId)).toHaveLength(1);
      const statuses = [(await jobOf(taxi)).status, (await jobOf(hotel)).status].sort();
      expect(statuses).toEqual(['queued', 'running']);
    });

    it('CONTROL: with nothing in the way it goes first and the running job waits right behind it, paused once', async () => {
      const { sara, jobId } = await running('f11-ok');
      const taxi = await another(sara, 'Taxi', minutes(1));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(5))).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1, secondsBilled: 300 });
      expect(await eventsOf(jobId)).toHaveLength(1);
    });
  });
  describe('finding 4: one control, one effect', () => {
    it('REPRO 4a: a note replayed after a new worker and a new turn keeps its number and cancels nothing new', async () => {
      const { sara, jobId } = await running('f4-note');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
      const c = command();
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(2), c)).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      expect(fake.cancelledTurns).toEqual(['resp-1']);
      // A new worker claims the job and the agent is on a new turn when the same tool call is retried
      await claimed(jobId, 'rB', minutes(3));
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-2' } });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(4), c)).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      expect(await notesOf(jobId)).toEqual([{ seq: 1, text: 'Use 12 March' }]);
      expect(await jobOf(jobId)).toMatchObject({ noteSeq: 1, agentResponseId: 'resp-2' });
      expect(fake.cancelledTurns).toEqual(['resp-1']);
      expect(await commandOf(c.id)).toMatchObject({ kind: 'note', jobId, turnResponseId: 'resp-1' });
    });

    it('two copies of one note at once (a retried tool call racing the first): one note, one number, one cancel', async () => {
      const { sara, jobId } = await running('f4-note-race');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
      const c = command();
      const [a, b] = await Promise.all([addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(2), c), addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(2), c)]);
      expect(a).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(b).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(await notesOf(jobId)).toEqual([{ seq: 1, text: 'Use 12 March' }]);
      expect(await jobOf(jobId)).toMatchObject({ noteSeq: 1 });
      expect(fake.cancelledTurns).toEqual(['resp-1']);
    });

    it('4d: a second identical note the person really sends (a new command) is a second note', async () => {
      const { sara, jobId } = await running('f4-note-twice');
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Skip the hotel', minutes(2), command())).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Skip the hotel', minutes(3), command())).toMatchObject({ ok: true, note: { seq: 2 } });
      expect(await notesOf(jobId)).toEqual([
        { seq: 1, text: 'Skip the hotel' },
        { seq: 2, text: 'Skip the hotel' },
      ]);
    });

    it('REPRO 4b: Pause, Resume, then the first Pause replayed: no second pause, stretch or time event, and the job keeps running', async () => {
      const { sara, jobId } = await running('f4-pause');
      const p = command();
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(5), p)).toMatchObject({ ok: true });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(6), command())).toMatchObject({ ok: true });
      const resumed = await jobOf(jobId);
      expect(resumed).toMatchObject({ status: 'running', pauses: 1 });
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(9), p)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 1, ownerEpoch: resumed.ownerEpoch, secondsBilled: resumed.secondsBilled });
      expect(await pausesOf(jobId)).toBe(1);
      expect(await eventsOf(jobId)).toHaveLength(1);
    });

    it('two copies of one Pause at once: one pause, one event, the same answer', async () => {
      const { sara, jobId } = await running('f4-pause-race');
      const p = command();
      const [a, b] = await Promise.all([pauseJob(sara.brickId, sara.id, jobId, minutes(5), p), pauseJob(sara.brickId, sara.id, jobId, minutes(5), p)]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 1 });
      expect(await pausesOf(jobId)).toBe(1);
      expect(await eventsOf(jobId)).toHaveLength(1);
    });

    it('a copy of a Pause that reaches the job’s lock after the first was applied AND the job resumed pauses nothing (the row is claimed before the effect)', async () => {
      const { sara, jobId } = await running('f4-pause-late-copy');
      const p = command();
      // The copy has looked (nothing kept yet) and waits for the job's lock; meanwhile the first copy pauses and the person resumes
      beforeLockOf(jobId, async () => {
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(5), p)).toMatchObject({ ok: true });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(6), command())).toMatchObject({ ok: true });
      });
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(5), p)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 1 });
      expect(await pausesOf(jobId)).toBe(1);
      expect(await eventsOf(jobId)).toHaveLength(1);
    });

    it('a Cancel refused (`over`) answers `over` again under the same command', async () => {
      const { sara } = await running('f4-cancel-over');
      const taxi = await another(sara, 'Taxi', minutes(1));
      await cancelJob(sara.brickId, sara.id, taxi, minutes(2), command());
      const c = command();
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(3), c)).toEqual({ ok: false, reason: 'over' });
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(4), c)).toEqual({ ok: false, reason: 'over' });
      expect(await commandOf(c.id)).toMatchObject({ outcome: { ok: false, reason: 'over' } });
    });

    it('a "do this first" refused AFTER it ranked the job (a pause refused under its lock) is undone whole: the rank as it was, nothing paused, the refusal kept', async () => {
      const { sara, jobId, epoch } = await running('f4-first-late-refusal');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      // The pause's own look at the running job (its second lock, after the rank was written) finds the person on the screen
      let calls = 0;
      lockJob.mockImplementation((async (tx: Parameters<typeof owner.lockJob>[0], id: string) => {
        const row = await realLockJob(tx, id);
        if (id === jobId && ++calls === 2 && row) return { ...row, control: 'person' };
        return row;
      }) as typeof owner.lockJob);
      const f = command();
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3), f)).toEqual({ ok: false, reason: 'taken_over' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0, ownerEpoch: epoch, secondsBilled: 0 });
      expect(await pausesOf(jobId)).toBe(0);
      expect(await commandOf(f.id)).toMatchObject({ outcome: { ok: false, reason: 'taken_over' } });
    });

    it('a Resume refused by the month AFTER its start was tried keeps that refusal: the same command answers `allowance` again (never ok while the job stays paused)', async () => {
      const { sara, jobId } = await running('f4-resume-refused');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      const r = command();
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(10), r)).toEqual({ ok: false, reason: 'allowance' });
      expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11), r)).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
    });

    it('CodeRabbit on #1025 (16): a copy of a Resume that arrives WHILE its start is being tried does not answer ok: it waits for the first request’s answer, and both say `allowance`; the start is tried once', async () => {
      const { sara, jobId } = await running('cr-16');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      let inStart: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (inStart = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        inStart();
        await gate;
        return realStart(...args);
      });
      const old = resumeWait.ms;
      resumeWait.ms = 10_000;
      const watch = watchPendingReads();
      let first: Promise<unknown> = Promise.resolve();
      let copy: Promise<unknown> = Promise.resolve();
      try {
        const r = command();
        first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r);
        first.catch(() => undefined);
        await enteredBy(started, first);
        let copyAnswer: unknown = 'still waiting';
        copy = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r).then((answer) => (copyAnswer = answer));
        copy.catch(() => undefined);
        // The copy has read the stored command and found it pending (it did not end before), and has had a moment to answer: it has not
        await watch.reached(copy);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(copyAnswer).toBe('still waiting');
        // The month refuses the start
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        go();
        expect(await first).toEqual({ ok: false, reason: 'allowance' });
        await copy;
        expect(copyAnswer).toEqual({ ok: false, reason: 'allowance' });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
      } finally {
        resumeWait.ms = old;
        go();
        watch.stop();
        spy.mockRestore();
        await Promise.allSettled([first, copy]);
      }
    });

    it('CodeRabbit on #1025 (23): a Resume whose request stopped after its commit (the start never finished) is settled by its copy, once, from the job as it stands once a try has decided it; the start is not tried again by the copy, and every later copy answers the same', async () => {
      const { sara, jobId } = await running('cr-23');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 300;
      resumeWait.capMs = 900;
      try {
        const r = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), r)).rejects.toThrow('the server stopped');
        // The resume was taken (the job is first in line) and its answer is still pending
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        // No try has decided it yet: the copy stores nothing (it is not a success the start may still turn into a refusal) and says the job is not ready
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11), r)).toEqual({ ok: false, reason: 'not_ready' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        // The line tries it (the sweep): once that has decided it, the copy settles the command from the job as it stands
        spy.mockImplementation(realStart);
        expect(await controlInternals.tryStart(jobId, minutes(12), { quiet: true })).toBe('running');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), r)).toMatchObject({ ok: true });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(r.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), r)).toMatchObject({ ok: true });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit A10: a copy of a Resume past its wait never stores or returns success while the first request’s start has not reached its decision: when the month then refuses that start, both answer the refusal and the job stays paused', async () => {
      const { sara, jobId } = await running('cr-a10');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      let inStart: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (inStart = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        inStart();
        await gate;
        return realStart(...args);
      });
      const old = { ...resumeWait };
      resumeWait.ms = 300;
      resumeWait.capMs = 1_200;
      let first: Promise<unknown> = Promise.resolve();
      try {
        const r = command();
        first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r);
        first.catch(() => undefined);
        await enteredBy(started, first);
        // The copy is past its wait and the start (a cold machine, say) is still on its way to a decision: nothing is stored, and the copy does not answer success
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(10), r)).toEqual({ ok: false, reason: 'not_ready' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        // The month refuses the start
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        go();
        expect(await first).toEqual({ ok: false, reason: 'allowance' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11), r)).toEqual({ ok: false, reason: 'allowance' });
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      } finally {
        go();
        await Promise.allSettled([first]);
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit A14: a "do this first" aimed at a paused job is its resume: when its request stopped after the start paused the job for the month, the copy settles it as a Resume (the refusal), never as a Pause that kept nothing (success)', async () => {
      const { sara, jobId } = await running('cr-a14');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (_id, _now, options) => {
        // The start committed the month's pause and recorded what it came to on its command, and the request stopped before it kept its answer
        await prisma.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'paused', pausedWhy: 'allowance', pausedAt: minutes(10) } });
        if (options?.decides) await recordResumeDecision(options.decides.commandId, jobId, options.decides.stretch);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      try {
        const f = command();
        await expect(moveJobFirst(sara.brickId, sara.id, jobId, {}, minutes(10), f)).rejects.toThrow('the server stopped');
        expect(await commandOf(f.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        expect(await moveJobFirst(sara.brickId, sara.id, jobId, {}, minutes(11), f)).toEqual({ ok: false, reason: 'allowance' });
        expect(await commandOf(f.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        expect(await moveJobFirst(sara.brickId, sara.id, jobId, {}, minutes(12), f)).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (N1): a pending Resume is settled from its own start: when a newer Resume took the job after it, the first one’s copy gets what the job came to before that, never the newer Resume’s outcome', async () => {
      const { sara, jobId } = await running('n1-resume');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      try {
        // Resume A is taken and its request stops before its start (the job waits in line, its answer is pending); the pause number it was taken at is on its row
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true }, stretch: 1 });
        // The person pauses it while it waits in line, then asks again (Resume B) with a month that refuses
        await pauseJob(sara.brickId, sara.id, jobId, minutes(11), command());
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        spy.mockImplementation(realStart);
        const b = command();
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), b)).toEqual({ ok: false, reason: 'allowance' });
        expect(await commandOf(b.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        // A was settled when B took the job, from the job as it stood then (a Resume that was taken): never B's refusal
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), a)).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        // A's own answer was never B's: the job is paused by B's refusal, and A said nothing of it
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (N1): a pending Resume whose own start was refused keeps that refusal when the carry-on of the month then starts the job', async () => {
      const { sara, jobId } = await running('n1-carry');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      // The start decides (the month refuses it) and the request stops before it keeps its answer
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        await realStart(...args);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      try {
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        // The month has room again: the carry-on starts the job. That start is not A's
        spy.mockImplementation(realStart);
        await setUp();
        resetCarryOnScanForTests();
        // The count is not asserted: `carryOnPaused` counts every eligible paused job in the database, and another suite's (or an earlier run's) rows would change it. This fixture job's own state is the check (CodeRabbit on #1025, d522f4b3 pass, N5)
        await carryOnPaused(minutes(20));
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(21), a)).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (N1): a job that has been paused again since a pending Resume was taken ran in between: that Resume’s copy answers success, whatever the later pause was for', async () => {
      const { sara, jobId } = await running('n1-ran');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        await realStart(...args);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      try {
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        // Its start ran (the job is running again) and the person paused it again later, and the month then refuses the next start
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        await pauseJob(sara.brickId, sara.id, jobId, minutes(15), command());
        await prisma.computerJob.update({ where: { id: jobId }, data: { pausedWhy: 'allowance' } });
        expect((await jobOf(jobId)).pauses).toBe(2);
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(16), a)).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('Opus on 14c4e407: a Resume whose own start leaves the job in line (the machine is busy) and whose request then stops is answered at once from what its start recorded, never `not_ready`', async () => {
      const { sara, jobId } = await running('rec-busy');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      // Another job runs on the machine now: the job's start finds a writer and keeps it in line
      const taxi = await another(sara, 'Taxi', minutes(3));
      expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        await realStart(...args);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      try {
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn' });
        // What the start came to is on the command (a job that stays in line is a success: the resume was taken)
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true, decided: { ok: true } } });
        // The copy answers ok at once from the record and settles the command
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(11), a)).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), a)).toMatchObject({ ok: true });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (14c4e407 pass, N14): a Resume A still waiting for room when the person pauses the job and resumes it again (B): A’s later refusal by the month never pauses B’s start; A keeps the answer it was settled with at the pause, and B’s start stays in line', async () => {
      const { sara, jobId } = await running('n14-fence');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const real = prisma.computerJobPause.findUnique.bind(prisma.computerJobPause);
      let inRoom: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (inRoom = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      let held = false;
      // A's try is held at the read right before it asks for room (the pause's blocked-call record)
      const hold = jest.spyOn(prisma.computerJobPause, 'findUnique').mockImplementation(((args: { select?: Record<string, boolean> }) => {
        if (!held && args?.select?.blockedKind) {
          held = true;
          inRoom();
          return gate.then(() => real(args as never));
        }
        return real(args as never);
      }) as never);
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      let first: Promise<unknown> = Promise.resolve();
      try {
        const a = command();
        first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), a);
        first.catch(() => undefined);
        await enteredBy(entered, first);
        // The person pauses the job in line (A is settled from the job as it stands: the Resume was taken), then resumes again (B); the team's computers are paused, so B's start stays in line
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(11), command())).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        const teamPaused = capabilityPause.computersArePaused as jest.MockedFunction<typeof capabilityPause.computersArePaused>;
        teamPaused.mockResolvedValue(true);
        try {
          expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), command())).toMatchObject({ ok: true });
        } finally {
          teamPaused.mockImplementation(realComputersArePaused);
        }
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'busy', pausedWhy: null });
        // The month now refuses, and A's start (held in its request for room) is released
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        go();
        await first;
        // A's refusal belonged to the start it began in: B's start is untouched
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'busy', pausedWhy: null });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
      } finally {
        go();
        await Promise.allSettled([first]);
        hold.mockRestore();
        Object.assign(resumeWait, old);
      }
    });

    it('CodeRabbit on #1025 (14c4e407 pass, N14): a try held while the person paused and resumed again never writes its line mark over the NEW start’s (the stale try would have put its earlier time on B’s start)', async () => {
      const { sara, jobId } = await running('n14-queue-mark');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const teamPaused = capabilityPause.computersArePaused as jest.MockedFunction<typeof capabilityPause.computersArePaused>;
      let inTry: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (inTry = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      let held = false;
      // A's try is held at its first look at whether the team paused computers (and then finds they did: it would write its mark and its reason)
      teamPaused.mockImplementation(async () => {
        if (!held) {
          held = true;
          inTry();
          await gate;
        }
        return true;
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      let first: Promise<unknown> = Promise.resolve();
      try {
        first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), command());
        first.catch(() => undefined);
        await enteredBy(entered, first);
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(11), command())).toMatchObject({ ok: true });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), command())).toMatchObject({ ok: true });
        expect((await jobOf(jobId)).lastTriedAt?.getTime()).toBe(minutes(12).getTime());
        go();
        await first;
        // B's start keeps its own mark: A's (minutes(10)) never lands on it
        expect((await jobOf(jobId)).lastTriedAt?.getTime()).toBe(minutes(12).getTime());
      } finally {
        go();
        await Promise.allSettled([first]);
        teamPaused.mockImplementation(realComputersArePaused);
        Object.assign(resumeWait, old);
      }
    });

    it('CodeRabbit on #1025 (d522f4b3 pass, N21): the queue sweep’s try for the SAME place in line never decides a Resume whose own start has not returned: its copy stores nothing and says `not_ready`, and when that start then gets the refusal both answer it', async () => {
      const { sara, jobId } = await running('n21-same-rank');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      // Another job runs on the machine now (the job's start finds a writer)
      const taxi = await another(sara, 'Taxi', minutes(3));
      expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
      const realStart = controlInternals.tryStart;
      let inStart: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (inStart = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        // Only the Resume's own try is held (the sweep's has no `decides`)
        if (args[2]?.decides) {
          inStart();
          await gate;
        }
        return realStart(...args);
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      let first: Promise<unknown> = Promise.resolve();
      try {
        const r = command();
        first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r);
        first.catch(() => undefined);
        await enteredBy(started, first);
        // The sweep tries the same place in line: it finds the writer and keeps the job in line, and marks its own decision for it
        expect(await controlInternals.tryStart(jobId, minutes(11))).toBe('queued');
        expect((await jobOf(jobId)).startDecidedAt).not.toBeNull();
        // A copy past its wait: that decision is not the Resume's, so nothing is stored and success is not answered
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), r)).toEqual({ ok: false, reason: 'not_ready' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        expect((await commandOf(r.id))?.outcome).not.toHaveProperty('decided');
        // The machine is free and the month refuses the Resume's own start
        await prisma.computerJob.update({ where: { id: taxi }, data: { status: 'done', endedAt: minutes(13), queuedFor: null, stretchStarted: null, reservationKey: null } });
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        go();
        expect(await first).toEqual({ ok: false, reason: 'allowance' });
        expect(await commandOf(r.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), r)).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        go();
        await Promise.allSettled([first]);
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it.each(['pause', 'cancel'] as const)('CodeRabbit on #1025 (d522f4b3 pass, N23): a Resume refused for the month but still pending keeps that refusal when the person then %ss the job: it is settled BEFORE the job’s reason or place changes', async (what) => {
      const { sara, jobId } = await running(`n23-${what}`);
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      // The start runs and the month refuses it, and the request stops inside it before it recorded what it came to
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (id, at, options) => {
        const rest = { ...(options ?? {}) };
        delete rest.decides;
        await realStart(id, at, rest);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      try {
        await saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        if (what === 'pause') {
          // The person's Pause of a job the month paused makes it theirs
          expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(11), command())).toMatchObject({ ok: true });
          expect(await jobOf(jobId)).toMatchObject({ queuedFor: 'paused', pausedWhy: 'person' });
        } else {
          expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(11), command())).toMatchObject({ ok: true });
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
        }
        // What A came to was kept before that: the month's refusal, never the success a later state reads as
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: false, reason: 'allowance' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(12), a)).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('Opus on 14c4e407 (N7): a Resume that RECORDED its decision keeps it when the job then goes to `recover` and is cancelled: it settles `{ok:true}` from its own record, never `not_ready`, and a copy answers the same', async () => {
      const { sara, jobId } = await running('n7-recorded');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        await realStart(...args);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      resumeWait.capMs = 600;
      try {
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true, decided: { ok: true } } });
        // The browser later is not settled, and the person cancels the job
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: 'recover', stretchStarted: null } });
        expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(12), command())).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), a)).toMatchObject({ ok: true });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), a)).toMatchObject({ ok: true });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (14c4e407 pass, N8): a Cancel whose every ending write is lost (a concurrent write moved the job each time) leaves the job live and its parked browser in place (no drop); the retry under the same id ends the job and drops the browser once', async () => {
      const { sara, jobId } = await running('n8-keep-browser');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      expect((await jobOf(jobId)).pauses).toBe(1);
      const drop = dropProfile as jest.MockedFunction<typeof dropProfile>;
      drop.mockClear();
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION n8_fail_end() RETURNS trigger AS $$ BEGIN IF NEW."status" = 'stopped' THEN RETURN NULL; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER n8_fail_end BEFORE UPDATE ON "computer_jobs" FOR EACH ROW WHEN (OLD."id" = '${jobId}') EXECUTE FUNCTION n8_fail_end()`);
      const c = command();
      try {
        expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(5), c)).toEqual({ ok: false, reason: 'not_ended' });
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
        expect(drop).not.toHaveBeenCalled();
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS n8_fail_end ON "computer_jobs"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS n8_fail_end()');
      }
      expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(6), c)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect(drop.mock.calls.filter((call) => call[1] === jobId).length).toBeGreaterThanOrEqual(1);
    });

    describe('Opus on 14c4e407: a pending Resume whose request stopped before its own start settles once the job RAN and then ended or went to the person', () => {
      type Way = 'cancel' | 'stopAll' | 'finish' | 'waiting' | 'off' | 'cancel-turn';
      /** Resume A is taken and its request stops before its start; the line's own try then starts the job (no record on A); then `way` happens to the job. */
      const ranThen = async (name: string, way: Way, prepState: 'recover' | null) => {
        const { sara, jobId } = await running(`held-${name}`);
        await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
        const realStart = controlInternals.tryStart;
        const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
          throw new Error('the server stopped');
        });
        const a = command();
        try {
          await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        } finally {
          spy.mockRestore();
        }
        expect(await realStart(jobId, minutes(11), { quiet: true })).toBe('running');
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true } });
        if (prepState) await prisma.computerJob.update({ where: { id: jobId }, data: { prepState, stretchStarted: null } });
        // `cancel-turn`: the job's first turn was sent and never named (the ending takes the machine-hold path, with its own transaction)
        if (way === 'cancel-turn') await prisma.computerJob.update({ where: { id: jobId }, data: { firstTurnSentAt: minutes(11), agentResponseId: null } });
        if (way === 'cancel' || way === 'cancel-turn') expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(12), command())).toMatchObject({ ok: true });
        else if (way === 'stopAll') expect(await stopAll(sara.brickId, sara.id, minutes(12), command())).toMatchObject({ ok: true });
        else if (way === 'off') await stopComputerWork(sara.brickId, 'off', minutes(12));
        else if (way === 'finish') await finishJob(jobId, 'done', minutes(12));
        else await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', control: 'person', waitingFor: 'signin' } });
        return { sara, jobId, a };
      };
      const old = { ...resumeWait };
      beforeEach(() => {
        resumeWait.ms = 200;
        resumeWait.capMs = 800;
      });
      afterEach(() => {
        Object.assign(resumeWait, old);
      });

      it.each(['cancel', 'stopAll', 'finish', 'off', 'cancel-turn'] as const)('a job that ran and was ended by %s: the copy answers ok at once, the command is settled, and a second copy answers the same', async (way) => {
        const { sara, jobId, a } = await ranThen(way, way, null);
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), a)).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), a)).toMatchObject({ ok: true });
      });

      it('a job that ran and was handed to the person (waiting): the copy answers ok and settles the command', async () => {
        const { sara, jobId, a } = await ranThen('waiting', 'waiting', null);
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), a)).toMatchObject({ ok: true });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), a)).toMatchObject({ ok: true });
      });

      it('CONTROL: a job ended while its browser was not settled (`recover`): A settles `not_ready`, final, and a copy returns the same', async () => {
        const { sara, jobId, a } = await ranThen('recover', 'cancel', 'recover');
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: false, reason: 'not_ready' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(13), a)).toEqual({ ok: false, reason: 'not_ready' });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(14), a)).toEqual({ ok: false, reason: 'not_ready' });
      });
    });

    it.each(['recover', 'restoring'] as const)('CodeRabbit on #1025 (d522f4b3 pass, N14): a pending Resume whose browser was not settled when the job was paused again answers `not_ready` (%s), recorded when its own start returned; a later pause or restore never changes it', async (state) => {
      const { sara, jobId } = await running(`n14-${state}`);
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      // The start carries on (the job runs) but its browser is not settled (the restore is still going, or failed): the attempt records that when its try returns, and the request stops before it kept its answer
      // (a job whose browser is not settled has no stretch counting yet: the table's own check)
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (id, at, options) => {
        const { decides, ...rest } = options ?? {};
        await realStart(id, at, rest);
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: state, stretchStarted: null } });
        if (decides) await recordResumeDecision(decides.commandId, jobId, decides.stretch);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      try {
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true, decided: { ok: false, reason: 'not_ready' } } });
        // The person pauses the job again: a pause leaves the browser state as it is
        await pauseJob(sara.brickId, sara.id, jobId, minutes(15), command());
        expect((await jobOf(jobId)).pauses).toBe(2);
        // What A came to is on its own command now, from its own start
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: false, reason: 'not_ready' } });
        // A later restore of the job (another Resume's) changes nothing of it
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: null } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(16), a)).toEqual({ ok: false, reason: 'not_ready' });
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: 'restoring' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(17), a)).toEqual({ ok: false, reason: 'not_ready' });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (d522f4b3 pass, N14) CONTROL: a pending Resume whose browser WAS ready when the job was paused again keeps its success, whatever restore or pause comes after', async () => {
      const { sara, jobId } = await running('n14-ready');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async (...args: Parameters<typeof realStart>) => {
        await realStart(...args);
        throw new Error('the server stopped');
      });
      const old = { ...resumeWait };
      resumeWait.ms = 200;
      try {
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        // The Resume's own start recorded its success BEFORE anything below changes the job (a fallback that read the later ready state could not satisfy this)
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true, decided: { ok: true } } });
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: null } });
        await pauseJob(sara.brickId, sara.id, jobId, minutes(15), command());
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true } });
        expect((await commandOf(a.id))?.outcome).not.toHaveProperty('pending');
        // The month then pauses it again and a later restore is under way: A's answer is still its own
        await prisma.computerJob.update({ where: { id: jobId }, data: { pausedWhy: 'allowance', prepState: 'restoring' } });
        expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(16), a)).toMatchObject({ ok: true });
      } finally {
        Object.assign(resumeWait, old);
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (N28): a stale try that looked at the job while it was paused never marks the NEW start of a Resume as decided (held between its look and its write; the Resume copy keeps waiting)', async () => {
      const { sara, jobId } = await running('n28-stale');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const realStart = controlInternals.tryStart;
      // The queue sweep's try: it sees the paused job, decides nothing, and is held right before its marker write
      const realUpdateMany = prisma.computerJob.updateMany.bind(prisma.computerJob);
      const held = { release: (): void => undefined };
      let reached: () => void = () => undefined;
      const atWrite = new Promise<void>((resolve) => { reached = resolve; });
      const gate = new Promise<void>((resolve) => { held.release = resolve; });
      let first = true;
      const write = jest.spyOn(prisma.computerJob, 'updateMany').mockImplementation(((args: { data?: Record<string, unknown> }) => {
        if (args?.data && 'startDecidedAt' in args.data && args.data.startDecidedAt !== null && first) {
          first = false;
          reached();
          return gate.then(() => realUpdateMany(args as never));
        }
        return realUpdateMany(args as never);
      }) as never);
      const stale = realStart(jobId, minutes(5));
      stale.catch(() => undefined);
      const old = { ...resumeWait };
      let start: jest.SpyInstance | undefined;
      try {
        // The checkpoint is inside the protected block and raced against the stale try itself: a try that fails, or returns without reaching its marker write, fails the test at once and the cleanup below still runs
        // (the gate is let go, the try joined, both spies restored) instead of a timeout that leaves the write spy installed (CodeRabbit on #1025, d522f4b3 pass, N6)
        await Promise.race([atWrite, stale.then((answer) => Promise.reject(new Error(`the stale try ended (${String(answer)}) before its marker write`)))]);
        // The Resume is taken (its own start never runs: the request stopped), the job waits in line, nothing has decided
        start = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
          throw new Error('the server stopped');
        });
        resumeWait.ms = 200;
        const a = command();
        await expect(resumeJob(sara.brickId, sara.id, jobId, minutes(10), a)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', startDecidedAt: null });
        held.release();
        await stale;
        // The stale write did not land: the new start has no decision on record, and a copy of the Resume stays pending (never a success the start may still turn into a refusal)
        expect(await jobOf(jobId)).toMatchObject({ startDecidedAt: null });
        expect(await commandOf(a.id)).toMatchObject({ outcome: { ok: true, pending: true } });
      } finally {
        held.release();
        await Promise.allSettled([stale]);
        Object.assign(resumeWait, old);
        start?.mockRestore();
        write.mockRestore();
      }
    });

    it('CodeRabbit D10: a pending Pause remembers the number of the pause it took: a copy that settles it reads exactly that pause’s row, not a later pause of the same job', async () => {
      const { sara, jobId } = await running('cr-d10');
      const c = command();
      const old = { ...resumeWait };
      resumeWait.ms = 300;
      const gate = gatedPark({ state: 'parked', reason: null });
      let first: Promise<unknown> = Promise.resolve();
      try {
        first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
        first.catch(() => undefined);
        await enteredBy(gate.wasEntered, first);
        expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true, targets: [jobId], held: [{ jobId, n: 1 }] });
        // This pause put its sign-ins away; a LATER pause of the same job (recorded before the copy settles) did not
        const row = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } });
        await prisma.computerJobPause.update({ where: { jobId_n: { jobId, n: 1 } }, data: { signInsKept: true } });
        const { id: _unused, ...rest } = row;
        void _unused;
        await prisma.computerJobPause.create({ data: { ...rest, n: 2, signInsKept: false } });
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2), c)).toMatchObject({ ok: true, signInsKept: true });
        expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
        gate.release();
        await first;
      } finally {
        gate.release();
        await Promise.allSettled([first]);
        Object.assign(resumeWait, old);
      }
    });

    it('CodeRabbit on #1025 (31): a Stop whose request stopped before the line moved keeps its answer pending; its retry moves the line, ends nothing asked for after the Stop, and then answers as a replay (without moving it again)', async () => {
      const { sara, jobId } = await running('cr-31');
      const s = command();
      const real = prisma.computerJob.findFirst.bind(prisma.computerJob) as unknown as (args: { where?: { status?: string }; orderBy?: unknown }) => Promise<unknown>;
      let moves = 0;
      let failOnce = true;
      const spy = jest.spyOn(prisma.computerJob, 'findFirst').mockImplementation(((args: { where?: { status?: string }; orderBy?: unknown }) => {
        // The look of "which job is next in line" (the line moving)
        if (args?.where?.status === 'queued' && Array.isArray(args.orderBy)) {
          moves++;
          if (failOnce) {
            failOnce = false;
            return Promise.reject(new Error('the server stopped'));
          }
        }
        return real(args);
      }) as never);
      try {
        await expect(stopAll(sara.brickId, sara.id, minutes(2), s)).rejects.toThrow('the server stopped');
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
        // Nothing final is kept: the line has not moved yet
        expect(await commandOf(s.id)).toMatchObject({ outcome: { ok: true, pending: true, targets: [jobId] } });
        // A job asked for after the Stop starts on its own and is not the Stop's
        const later = await startJob({ botId: sara.brickId, personId: sara.id, title: 'After the Stop' }, minutes(3));
        if (!later.ok) throw new Error('the job was not made');
        const movesBeforeRetry = moves;
        const retried = await stopAll(sara.brickId, sara.id, minutes(4), s);
        expect(retried).toMatchObject({ ok: true });
        expect(await jobOf(later.job.id)).toMatchObject({ status: 'running' });
        expect((await commandOf(s.id))?.outcome).toEqual({ ok: true, targets: [jobId] });
        // The retry moved the line (it looked for the next job in line: the one the first request stopped before)
        expect(moves).toBeGreaterThan(movesBeforeRetry);
        const movedBefore = moves;
        expect(await stopAll(sara.brickId, sara.id, minutes(5), s)).toMatchObject({ ok: true });
        expect(moves).toBe(movedBefore);
      } finally {
        spy.mockRestore();
      }
    });

    it('CodeRabbit on #1025 (53): a Cancel whose ending lost its race on every try keeps its answer pending (the job still holds the machine), and its retry under the same id ends it and then answers as a replay', async () => {
      const { sara, jobId } = await running('cr-53');
      const c = command();
      const spy = jest.spyOn(controlInternals, 'endByPerson').mockImplementation(async () => undefined);
      try {
        // N11 (d522f4b3 pass): the job is still live, so the Cancel is told as NOT ended (retryable), never as a success
        expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(2), c)).toEqual({ ok: false, reason: 'not_ended' });
      } finally {
        spy.mockRestore();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await commandOf(c.id)).toMatchObject({ outcome: { ok: true, pending: true, targets: [jobId] } });
      // The same command again runs the ending again
      expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(3), c)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, targets: [jobId] });
    });

    /** Holds the next browser park until `release` is called; resolves `entered` once it is being waited on. */
    const gatedPark = (result: { state: 'parked' | 'failed'; reason: string | null }) => {
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const wasEntered = new Promise<void>((resolve) => (entered = resolve));
      jest.mocked(parkProfile).mockImplementationOnce((async () => {
        entered();
        await new Promise<void>((resolve) => (release = resolve));
        return result;
      }) as unknown as typeof parkProfile);
      return { wasEntered, release: () => release() };
    };

    it('CodeRabbit on #1025 (51): a copy of a Pause that arrives while the first one is still putting the sign-ins away waits, and answers with what the first kept (never an early success without signInsKept)', async () => {
      const { sara, jobId } = await running('cr-51');
      const c = command();
      const gate = gatedPark({ state: 'parked', reason: null });
      const watch = watchPendingReads();
      let first: Promise<unknown> = Promise.resolve();
      let copy: Promise<unknown> = Promise.resolve();
      try {
        first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
        first.catch(() => undefined);
        await enteredBy(gate.wasEntered, first);
        expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true });
        let copyAnswered = false;
        copy = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c).then((answer) => {
          copyAnswered = true;
          return answer;
        });
        copy.catch(() => undefined);
        // The copy has read the stored command and found it pending (it did not end before), and has had a moment to answer: it has not
        await watch.reached(copy);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(copyAnswered).toBe(false);
        gate.release();
        expect(await first).toMatchObject({ ok: true, signInsKept: true });
        expect(await copy).toMatchObject({ ok: true, signInsKept: true });
        expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
        expect(await pausesOf(jobId)).toBe(1);
      } finally {
        gate.release();
        watch.stop();
        await Promise.allSettled([first, copy]);
      }
    });

    it('CodeRabbit on #1025 (51, O45): when the first Pause has not yet written what it kept of the sign-ins, the copy never settles it as lost: it waits, answers not_ready past the cap and stores nothing, and the first one then answers for real', async () => {
      const { sara, jobId } = await running('cr-51-stuck');
      const c = command();
      const old = { ms: resumeWait.ms, capMs: resumeWait.capMs };
      resumeWait.ms = 300;
      resumeWait.capMs = 900;
      const gate = gatedPark({ state: 'parked', reason: null });
      let first: Promise<unknown> = Promise.resolve();
      try {
        first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
        first.catch(() => undefined);
        await enteredBy(gate.wasEntered, first);
        // The pause row has no word yet on what was kept (null): that is not "nothing was kept"
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2), c)).toEqual({ ok: false, reason: 'not_ready' });
        expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true });
        gate.release();
        expect(await first).toMatchObject({ ok: true, signInsKept: true });
        expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
      } finally {
        resumeWait.ms = old.ms;
        resumeWait.capMs = old.capMs;
        gate.release();
        await Promise.allSettled([first]);
      }
      expect(await pausesOf(jobId)).toBe(1);
    });

    it('CodeRabbit on #1025 (51): "do this first" with a running job to pause keeps its answer pending until that job’s sign-ins are put away; a copy waits for it', async () => {
      const { sara, jobId } = await running('cr-51-first');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const c = command();
      const gate = gatedPark({ state: 'parked', reason: null });
      const watch = watchPendingReads();
      let first: Promise<unknown> = Promise.resolve();
      let copy: Promise<unknown> = Promise.resolve();
      try {
        first = moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(2), c);
        first.catch(() => undefined);
        await enteredBy(gate.wasEntered, first);
        expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true, targets: [jobId] });
        let copyAnswered = false;
        copy = moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(2), c).then((answer) => {
          copyAnswered = true;
          return answer;
        });
        copy.catch(() => undefined);
        // The copy has read the stored command and found it pending (it did not end before), and has had a moment to answer: it has not
        await watch.reached(copy);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(copyAnswered).toBe(false);
        gate.release();
        expect(await first).toMatchObject({ ok: true, signInsKept: true });
        expect(await copy).toMatchObject({ ok: true, signInsKept: true });
        expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
      } finally {
        gate.release();
        watch.stop();
        await Promise.allSettled([first, copy]);
      }
    });

    it('CodeRabbit on #1025 (51): a Pause of a job that only waited in line is answered in its own transaction (final, nothing pending)', async () => {
      const { sara } = await running('cr-51-queued');
      const waiting = await another(sara, 'Taxi', minutes(1));
      const c = command();
      expect(await pauseJob(sara.brickId, sara.id, waiting, minutes(2), c)).toMatchObject({ ok: true });
      expect((await commandOf(c.id))?.outcome).toEqual({ ok: true });
    });

    it('CodeRabbit on #1025 (52): a job that tries to start while "do this first" is deciding waits on the Brick’s line lock: it cannot become a holder the command did not see, and it starts only after the command committed', async () => {
      const { sara, jobId } = await running('cr-52');
      // Nobody holds the machine: the first job is back in line (as if it had been waiting), and a second is the target
      const target = await another(sara, 'Taxi', minutes(1));
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'queued', queuedFor: 'turn', reservationKey: null, stretchStarted: null, startedAt: null } });
      const seenDuring: string[] = [];
      let late: Promise<unknown> = Promise.resolve();
      try {
        // The moment the command has its locks (the holders it will pause were read under the line lock), the first job tries to start
        beforeLockOf(target, async () => {
          let ended: Error | null = null;
          let reached = false;
          const met = new Promise<void>((resolve) => {
            controlInternals.onLineBusy = (botId) => {
              if (botId === sara.brickId) {
                reached = true;
                resolve();
              }
            };
          });
          late = controlInternals.tryStart(jobId, minutes(2));
          // Observed from the moment it starts: a start that ends (or fails) before it reaches the lock fails the wait, whichever way it ended
          late.then(
            () => (ended = new Error('the competing start ended without waiting on the line lock')),
            (error) => (ended = error instanceof Error ? error : new Error(String(error))),
          );
          // The start finds THIS Brick's line lock held by the command and keeps trying for it (a try-lock, so it never waits while holding the computer's row): the seam says it reached the held line, and it has neither ended nor started
          await Promise.race([met, late.then(() => undefined, () => undefined)]);
          expect((() => ended)()).toBeNull();
          expect(reached).toBe(true);
          seenDuring.push((await jobOf(jobId)).status);
        });
        const answer = await moveJobFirst(sara.brickId, sara.id, target, { pauseRunning: true }, minutes(2), command());
        expect(answer).toMatchObject({ ok: true });
        // Held back by the line lock for the whole command
        expect(seenDuring).toEqual(['queued']);
        await late;
      } finally {
        controlInternals.onLineBusy = () => undefined;
        await Promise.allSettled([late]);
      }
    });

    it('a Stop’s command id used again on the owner’s OTHER Brick is `command_reused`, and stops nothing there', async () => {
      const { sara, jobId } = await running('f4-stop-two-bricks');
      const second = await createBrick({ ownerId: sara.id, name: 'Second Brick' });
      await giveComputer(second.id, sara.id);
      const there = await startJob({ botId: second.id, personId: sara.id, title: 'Hotel' }, NOW);
      if (!there.ok) throw new Error('the job was not made');
      const s = command();
      expect(await stopAll(sara.brickId, sara.id, minutes(2), s)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect(await stopAll(second.id, sara.id, minutes(3), s)).toEqual({ ok: false, reason: 'command_reused' });
      expect(await jobOf(there.job.id)).toMatchObject({ status: 'running' });
    });

    it('REPRO 4c: a delayed Resume replayed after the job was paused again leaves it paused', async () => {
      const { sara, jobId } = await running('f4-resume');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const r = command();
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(3), r)).toMatchObject({ ok: true });
      await pauseJob(sara.brickId, sara.id, jobId, minutes(6), command());
      const pausedAgain = await jobOf(jobId);
      expect(pausedAgain).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 2 });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(8), r)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 2, ownerEpoch: pausedAgain.ownerEpoch, queueRank: pausedAgain.queueRank });
      expect(await eventsOf(jobId)).toHaveLength(2);
    });

    it('REPRO 4c: a delayed "do this first" replayed after its job was paused leaves it paused (and pauses nothing else)', async () => {
      const { sara, jobId } = await running('f4-first');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const f = command();
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3), f)).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
      await pauseJob(sara.brickId, sara.id, taxi, minutes(5), command());
      const visa = await jobOf(jobId);
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(7), f)).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 1 });
      expect(await jobOf(jobId)).toMatchObject({ status: visa.status, pauses: visa.pauses, ownerEpoch: visa.ownerEpoch });
      expect(await eventsOf(jobId)).toHaveLength(1);
      expect(await eventsOf(taxi)).toHaveLength(1);
    });

    it('a "do this first" refused under its locks keeps the refusal: the same command answers it again, and nothing moved', async () => {
      const { sara, jobId, epoch } = await running('f4-first-refused');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      beforeLockOf(jobId, () => recordFinishIntent(jobId, { outcome: 'done', epoch }, minutes(2)));
      const f = command();
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3), f)).toEqual({ ok: false, reason: 'ending' });
      expect(await commandOf(f.id)).toMatchObject({ outcome: { ok: false, reason: 'ending' } });
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(4), f)).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0 });
    });

    it('REPRO 4c: a Cancel replayed answers what it came to (done), not "over"', async () => {
      const { sara } = await running('f4-cancel');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const c = command();
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(2), c)).toMatchObject({ ok: true });
      const ended = await jobOf(taxi);
      expect(ended).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(4), c)).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'stopped', endedAt: ended.endedAt });
    });

    it('a Cancel whose first request stopped half way: the same command finishes ending THAT job only', async () => {
      const { sara, jobId } = await running('f4-cancel-half');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const c = command();
      await claimCommand(c, commandRow(sara.brickId, sara.id, taxi, 'cancel'), { ok: true, pending: true, targets: [taxi] });
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(2), c)).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'stopped' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await commandOf(c.id)).toMatchObject({ outcome: { ok: true, targets: [taxi] } });
    });

    it('REPRO: a Stop replayed never ends a job started after it', async () => {
      const { sara, jobId } = await running('f4-stop');
      const s = command();
      expect(await stopAll(sara.brickId, sara.id, minutes(2), s)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      const later = await another(sara, 'Hotel', minutes(3));
      expect(await jobOf(later)).toMatchObject({ status: 'running' });
      expect(await stopAll(sara.brickId, sara.id, minutes(4), s)).toMatchObject({ ok: true });
      expect(await jobOf(later)).toMatchObject({ status: 'running' });
    });

    it('a Stop whose first request stopped half way: the same command ends the jobs it named, never one started after it', async () => {
      const { sara, jobId } = await running('f4-stop-half');
      const s = command();
      await claimCommand(s, commandRow(sara.brickId, sara.id, null, 'stop'), { ok: true, pending: true, targets: [jobId] });
      const later = await another(sara, 'Hotel', minutes(1));
      expect(await jobOf(later)).toMatchObject({ status: 'queued' });
      expect(await stopAll(sara.brickId, sara.id, minutes(2), s)).toMatchObject({ ok: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped' });
      expect(await jobOf(later)).toMatchObject({ status: 'running' });
    });

    it('CONTROL: a Stop without a command (the 0.4.3 game) ends everything there now, as before', async () => {
      const { sara, jobId } = await running('f4-stop-old');
      const later = await another(sara, 'Hotel', minutes(1));
      expect(await stopAll(sara.brickId, sara.id, minutes(2))).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).status).toBe('stopped');
      expect((await jobOf(later)).status).toBe('stopped');
    });

    it('the same command id for another control is refused (`command_reused`) and writes nothing', async () => {
      const { sara, jobId } = await running('f4-reused');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const c = command();
      expect(await pauseJob(sara.brickId, sara.id, taxi, minutes(2), c)).toMatchObject({ ok: true });
      expect(await cancelJob(sara.brickId, sara.id, taxi, minutes(3), c)).toEqual({ ok: false, reason: 'command_reused' });
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(3), c)).toEqual({ ok: false, reason: 'command_reused' });
      expect(await stopAll(sara.brickId, sara.id, minutes(3), c)).toEqual({ ok: false, reason: 'command_reused' });
      const n = command();
      await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(4), n);
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 13 March', minutes(5), n)).toEqual({ ok: false, reason: 'command_reused' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0, noteSeq: 1 });
      expect(await notesOf(jobId)).toEqual([{ seq: 1, text: 'Use 12 March' }]);
    });

    it('CONTROL: the controls without a command id work as before', async () => {
      const { sara, jobId } = await running('f4-none');
      expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2))).toMatchObject({ ok: true });
      expect(await resumeJob(sara.brickId, sara.id, jobId, minutes(3))).toMatchObject({ ok: true });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(4))).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(5))).toMatchObject({ ok: true, note: { seq: 2 } });
      expect(await prisma.computerJobCommand.count({ where: { botId: sara.brickId } })).toBe(0);
    });
  });
});
