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
import { claimJob, giveComputer, recordFinishIntent, startJob, stopAll } from '@/lib/computer';
import { cancelJob, moveJobFirst, pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { addJobNote } from '@/lib/computer-job-notes';
import { claimCommand, commandRow } from '@/lib/computer-commands';
import * as owner from '@/lib/computer-owner';

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
