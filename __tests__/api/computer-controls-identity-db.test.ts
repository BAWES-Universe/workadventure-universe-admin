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
import { claimJob, controlInternals, giveComputer, recordFinishIntent, startJob, stopAll } from '@/lib/computer';
import { cancelJob, moveJobFirst, pauseJob, resumeJob, resumeWait } from '@/lib/computer-job-controls';
import { addJobNote } from '@/lib/computer-job-notes';
import { claimCommand, commandRow } from '@/lib/computer-commands';
import * as owner from '@/lib/computer-owner';
import { parkProfile } from '@/lib/computer-browser-profile';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
const realLockJob = jest.requireActual('@/lib/computer-owner').lockJob as typeof owner.lockJob;
const lockJob = owner.lockJob as jest.MockedFunction<typeof owner.lockJob>;
let fake: FakeComputerProvider;
const command = () => ({ id: randomUUID() });
const notesOf = (jobId: string) => prisma.computerJobNote.findMany({ where: { jobId }, orderBy: { seq: 'asc' }, select: { seq: true, text: true } });
const commandOf = (id: string) => prisma.computerJobCommand.findUnique({ where: { commandId: id } });

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
      try {
        const r = command();
        const first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r);
        await started;
        let copyAnswer: unknown = 'still waiting';
        const copy = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r).then((answer) => (copyAnswer = answer));
        // The copy has had every chance to answer: it has not (the stored answer is still pending)
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
        spy.mockRestore();
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
      try {
        const r = command();
        const first = resumeJob(sara.brickId, sara.id, jobId, minutes(10), r);
        await started;
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
        Object.assign(resumeWait, old);
        go();
        spy.mockRestore();
      }
    });

    it('CodeRabbit A14: a "do this first" aimed at a paused job is its resume: when its request stopped after the start paused the job for the month, the copy settles it as a Resume (the refusal), never as a Pause that kept nothing (success)', async () => {
      const { sara, jobId } = await running('cr-a14');
      await pauseJob(sara.brickId, sara.id, jobId, minutes(2), command());
      const spy = jest.spyOn(controlInternals, 'tryStart').mockImplementation(async () => {
        // The start committed the month's pause, and the request stopped before it kept its answer
        await prisma.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'paused', pausedWhy: 'allowance', pausedAt: minutes(10) } });
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

    it('CodeRabbit D10: a pending Pause remembers the number of the pause it took: a copy that settles it reads exactly that pause’s row, not a later pause of the same job', async () => {
      const { sara, jobId } = await running('cr-d10');
      const c = command();
      const old = { ...resumeWait };
      resumeWait.ms = 300;
      const gate = gatedPark({ state: 'parked', reason: null });
      try {
        const first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
        await gate.wasEntered;
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
        Object.assign(resumeWait, old);
        gate.release();
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
        const retried = await stopAll(sara.brickId, sara.id, minutes(4), s);
        expect(retried).toMatchObject({ ok: true });
        expect(await jobOf(later.job.id)).toMatchObject({ status: 'running' });
        expect((await commandOf(s.id))?.outcome).toEqual({ ok: true, targets: [jobId] });
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
        expect(await cancelJob(sara.brickId, sara.id, jobId, minutes(2), c)).toMatchObject({ ok: true });
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
      const first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
      await gate.wasEntered;
      expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true });
      let copyAnswered = false;
      const copy = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c).then((answer) => {
        copyAnswered = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(copyAnswered).toBe(false);
      gate.release();
      expect(await first).toMatchObject({ ok: true, signInsKept: true });
      expect(await copy).toMatchObject({ ok: true, signInsKept: true });
      expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
      expect(await pausesOf(jobId)).toBe(1);
    });

    it('CodeRabbit on #1025 (51): when the first Pause never finishes putting the sign-ins away, the copy settles the answer once (kept: false), and the first one then returns that same answer', async () => {
      const { sara, jobId } = await running('cr-51-stuck');
      const c = command();
      const old = resumeWait.ms;
      resumeWait.ms = 300;
      const gate = gatedPark({ state: 'parked', reason: null });
      try {
        const first = pauseJob(sara.brickId, sara.id, jobId, minutes(2), c);
        await gate.wasEntered;
        expect(await pauseJob(sara.brickId, sara.id, jobId, minutes(2), c)).toMatchObject({ ok: true, signInsKept: false });
        expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: false });
        gate.release();
        expect(await first).toMatchObject({ ok: true, signInsKept: false });
      } finally {
        resumeWait.ms = old;
      }
      expect(await pausesOf(jobId)).toBe(1);
    });

    it('CodeRabbit on #1025 (51): "do this first" with a running job to pause keeps its answer pending until that job’s sign-ins are put away; a copy waits for it', async () => {
      const { sara, jobId } = await running('cr-51-first');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const c = command();
      const gate = gatedPark({ state: 'parked', reason: null });
      const first = moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(2), c);
      await gate.wasEntered;
      expect((await commandOf(c.id))?.outcome).toMatchObject({ ok: true, pending: true, targets: [jobId] });
      let copyAnswered = false;
      const copy = moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(2), c).then((answer) => {
        copyAnswered = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(copyAnswered).toBe(false);
      gate.release();
      expect(await first).toMatchObject({ ok: true, signInsKept: true });
      expect(await copy).toMatchObject({ ok: true, signInsKept: true });
      expect((await commandOf(c.id))?.outcome).toEqual({ ok: true, signInsKept: true });
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
      // The moment the command has its locks (the holders it will pause were read under the line lock), the first job tries to start
      beforeLockOf(target, async () => {
        late = controlInternals.tryStart(jobId, minutes(2));
        await new Promise((resolve) => setTimeout(resolve, 800));
        seenDuring.push((await jobOf(jobId)).status);
      });
      const answer = await moveJobFirst(sara.brickId, sara.id, target, { pauseRunning: true }, minutes(2), command());
      expect(answer).toMatchObject({ ok: true });
      // Held back by the line lock for the whole command
      expect(seenDuring).toEqual(['queued']);
      await late;
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
