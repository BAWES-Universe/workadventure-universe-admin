/**
 * Telling a running job something new (notes), its Activity (the list of steps), and Brick's door to its own jobs (computers full plan, piece 2). Each
 * case is written with its CONTROL. Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-notes-activity-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
// Piece 1's controls are called by the door with the Brick's owner and the job: seen here as they are called
jest.mock('@/lib/computer-job-controls', () => ({
  ...jest.requireActual('@/lib/computer-job-controls'),
  pauseJob: jest.fn(async () => ({ ok: false, reason: 'taken_over' })),
  resumeJob: jest.fn(async () => ({ ok: false, reason: 'not_paused' })),
  moveJobFirst: jest.fn(async () => ({ ok: false, reason: 'not_queued' })),
  cancelJob: jest.fn(async () => ({ ok: false, reason: 'over' })),
}));

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { saveServerLimits } from '@/lib/bot-limits';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, giveComputer, recordFinishIntent, renewJob, reportProgressAs, requestHandoverAs, startJob, sweepComputers } from '@/lib/computer';
import { cutoffLockKey } from '@/lib/computer-calls';
import { addJobNote, notesSent, pendingNotes } from '@/lib/computer-job-notes';
import { appendStep, jobActivity, stepsOf } from '@/lib/computer-job-steps';
import { cancelJob, moveJobFirst, pauseJob } from '@/lib/computer-job-controls';
import { POST as control } from '@/app/api/bots/[id]/computer-jobs/control/route';
import { GET as getRunnerJob, POST as runnerAction } from '@/app/api/bots/[id]/computer-jobs/[jobId]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: unique, brickId: brick.id };
}

const setUp = () =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

/** A person with a Brick that has a job running on the pretend machine, claimed by a runner (the epoch it owns by), on turn `resp-A`. */
async function running(name: string) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  const jobId = started.job.id;
  const epoch = await claimed(jobId, 'rA');
  await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-A' } });
  return { sara, jobId, epoch };
}

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  // A job that already has an owner is claimed only once that owner stopped beating (GPT round 6, finding 3): the hold is let go first, as it runs out by itself 90 s after the owner's last beat
  await prisma.computerJob.updateMany({ where: { id: jobId, NOT: { ownerLeaseUntil: null } }, data: { ownerLeaseUntil: null } });
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};
const notesOf = (jobId: string) => prisma.computerJobNote.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });
/** Brick's door, as a tool call asks it: every control with its own command id (a retried tool call passes the same `command`). */
const doorAnswer = (botId: string, body: Record<string, unknown>, command: string | null = randomUUID()) =>
  control(new NextRequest(`http://orbit.test/api/bots/${botId}/computer-jobs/control`, { method: 'POST', body: JSON.stringify(body), ...(command ? { headers: { 'x-computer-command': command } } : {}) }), { params: Promise.resolve({ id: botId }) });
const door = async (botId: string, body: Record<string, unknown>, command?: string | null) => (await doorAnswer(botId, body, command)).json();
const aCommand = expect.objectContaining({ id: expect.any(String) });

run('notes to a running job, Activity, and Brick’s door (computers full plan, piece 2), in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  let fake: FakeComputerProvider;
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await setUp();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('a note to a running job', () => {
    it('is kept pending with the next number, cancels the turn it read once, moves the lease version and NEVER the owner epoch; CONTROL: the owner’s next renew, progress and hand-over still land', async () => {
      const { sara, jobId, epoch } = await running('n-run');
      const before = await jobOf(jobId);
      const noted = await addJobNote(sara.brickId, sara.id, jobId, '  Use 12 March instead  ', minutes(1));
      expect(noted).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      if (noted.ok) expect(noted.view.job?.id).toBe(jobId);
      expect(await pendingNotes(jobId)).toEqual([{ seq: 1, text: 'Use 12 March instead' }]);
      const after = await jobOf(jobId);
      expect(after.ownerEpoch).toBe(before.ownerEpoch);
      expect(after.leaseVersion).toBe(before.leaseVersion + 1);
      expect(after.noteSeq).toBe(1);
      expect(after.status).toBe('running');
      expect(fake.cancelledTurns).toEqual(['resp-A']);
      // The same worker carries on: nothing it does next is superseded
      expect(await renewJob(jobId, minutes(2), { epoch })).toMatchObject({ ok: true });
      expect(await reportProgressAs(jobId, { stepDone: 2, label: 'Filling the dates' }, { epoch })).toMatchObject({ applied: true, superseded: false });
      expect((await requestHandoverAs(jobId, 'answer', minutes(3), null, { epoch, generation: 0 })).refused).toBeNull();
    });

    it('cancels the turn read UNDER the job’s lock, never one read before it: a turn that started while the note waited for the lock is the one cancelled, the older one is not', async () => {
      const { sara, jobId } = await running('n-lock');
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // Another request holds the job's cutoff lock, and moves the job to its next turn before it lets go
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
          locked();
          await released;
          await tx.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-B' } });
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
      let noting: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([
          lockTaken,
          holder.then(() => {
            throw new Error('the fixture transaction ended without holding the lock');
          }),
        ]);
        noting = addJobNote(sara.brickId, sara.id, jobId, 'Skip the hotel', minutes(1));
        // The turn changes only once THIS note is blocked on the lock, however long its first reads took (CodeRabbit on #1025)
        let blocked = false;
        for (let tries = 0; tries < 250 && !blocked; tries += 1) {
          const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${cutoffLockKey(jobId)}, 0)`;
          blocked = rows[0].n > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await Promise.allSettled([holder, noting]);
      }
      expect(await noting).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      expect(fake.cancelledTurns).toEqual(['resp-B']);
    });

    it('with no turn going (between turns): kept, nothing cancelled; CONTROL: the epoch stays', async () => {
      const { sara, jobId } = await running('n-between');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: null } });
      const before = await jobOf(jobId);
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use the other email', minutes(1))).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      expect(fake.cancelledTurns).toEqual([]);
      expect((await jobOf(jobId)).ownerEpoch).toBe(before.ownerEpoch);
    });

    it('a machine that does not answer the cancel never fails the note: it is kept, the answer is ok', async () => {
      const { sara, jobId } = await running('n-failcancel');
      fake.failCancel = true;
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(1))).toMatchObject({ ok: true });
      expect(await pendingNotes(jobId)).toHaveLength(1);
    });

    it('several notes at the same moment each get their own number, in order, once each', async () => {
      const { sara, jobId } = await running('n-many');
      const said = await Promise.all([1, 2, 3, 4, 5].map((n) => addJobNote(sara.brickId, sara.id, jobId, `note ${n}`, minutes(1))));
      expect(said.every((one) => one.ok)).toBe(true);
      const notes = await notesOf(jobId);
      expect(notes.map((note) => note.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(notes.map((note) => note.text)).size).toBe(5);
      expect((await jobOf(jobId)).noteSeq).toBe(5);
    });
  });

  describe('a note to a job that waits or is not running', () => {
    it('waiting for an answer (not taken over): the note IS the answer, the wait ends and Brick carries on, lease version moves, epoch does not; nothing cancelled', async () => {
      const { sara, jobId, epoch } = await running('n-answer');
      await requestHandoverAs(jobId, 'answer', minutes(1), null, { epoch, generation: 0 });
      const before = await jobOf(jobId);
      expect(before).toMatchObject({ status: 'waiting', waitingFor: 'answer' });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Yes, the cheaper one', minutes(2))).toMatchObject({ ok: true, note: { delivery: 'answer' } });
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'running', waitingFor: null, control: 'brick', ownerEpoch: before.ownerEpoch, leaseVersion: before.leaseVersion + 1 });
      expect(fake.cancelledTurns).toEqual([]);
      // The owner carries on as before
      expect(await renewJob(jobId, minutes(3), { epoch })).toMatchObject({ ok: true });
    });

    it('waiting for the person to step in (a sign-in), not taken over: the words reach the job at once, the wait ends (delivery now)', async () => {
      const { sara, jobId, epoch } = await running('n-signin');
      await requestHandoverAs(jobId, 'signin', minutes(1), null, { epoch, generation: 0 });
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'I have no account, continue as a guest', minutes(2))).toMatchObject({ ok: true, note: { delivery: 'now' } });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', waitingFor: null });
    });

    it('a wait the note ended is never ended as unanswered by the sweep; CONTROL: the same wait with no note is', async () => {
      const answered = await running('n-sweep');
      await requestHandoverAs(answered.jobId, 'answer', NOW, null, { epoch: answered.epoch, generation: 0 });
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(answered.jobId)).reservationKey! }, data: { expiresAt: minutes(1000) } });
      await addJobNote(answered.sara.brickId, answered.sara.id, answered.jobId, 'Go ahead', minutes(1));
      const silent = await running('n-sweep-ctl');
      await requestHandoverAs(silent.jobId, 'answer', NOW, null, { epoch: silent.epoch, generation: 0 });
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(silent.jobId)).reservationKey! }, data: { expiresAt: minutes(1000) } });
      await sweepComputers(minutes(120));
      expect((await jobOf(answered.jobId)).endedBy).not.toBe('unanswered');
      expect(await jobOf(silent.jobId)).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
    });

    it('the person holds the screen: kept for the hand back, the wait is NOT ended and nothing is cancelled', async () => {
      const { sara, jobId } = await running('n-taken');
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', control: 'person', controlGeneration: { increment: 1 } } });
      const before = await jobOf(jobId);
      expect(await addJobNote(sara.brickId, sara.id, jobId, 'Then use 12 March', minutes(1))).toMatchObject({ ok: true, note: { delivery: 'after_hand_back' } });
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', leaseVersion: before.leaseVersion });
      expect(fake.cancelledTurns).toEqual([]);
      expect(await pendingNotes(jobId)).toHaveLength(1);
    });

    it('in line, or paused: kept for its first turn, nothing else changes', async () => {
      const { sara, jobId } = await running('n-queued');
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Clock' }, minutes(1));
      if (!second.ok) throw new Error('no second job');
      expect((await jobOf(second.job.id)).status).toBe('queued');
      expect(await addJobNote(sara.brickId, sara.id, second.job.id, 'Make it red', minutes(2))).toMatchObject({ ok: true, note: { delivery: 'when_it_starts' } });
      await prisma.computerJob.update({ where: { id: second.job.id }, data: { queuedFor: 'paused', pausedAt: minutes(2), pausedWhy: 'person' } });
      expect(await addJobNote(sara.brickId, sara.id, second.job.id, 'And bigger', minutes(3))).toMatchObject({ ok: true, note: { seq: 2, delivery: 'when_it_starts' } });
      expect(await jobOf(second.job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect(fake.cancelledTurns).toEqual([]);
      expect((await pendingNotes(jobId)).length).toBe(0);
    });

    it('a job that is over keeps nothing (`over`); one whose ending is decided keeps nothing and cancels nothing (`ending`); CONTROL: a live job of the same Brick keeps it', async () => {
      const over = await running('n-over');
      await prisma.computerJob.update({ where: { id: over.jobId }, data: { status: 'done', endedAt: minutes(1) } });
      expect(await addJobNote(over.sara.brickId, over.sara.id, over.jobId, 'Too late', minutes(2))).toEqual({ ok: false, reason: 'over' });
      expect(await notesOf(over.jobId)).toEqual([]);
      const ending = await running('n-ending');
      await recordFinishIntent(ending.jobId, { outcome: 'done', epoch: ending.epoch }, minutes(1));
      expect(await addJobNote(ending.sara.brickId, ending.sara.id, ending.jobId, 'One more thing', minutes(2))).toEqual({ ok: false, reason: 'ending' });
      expect(await notesOf(ending.jobId)).toEqual([]);
      expect(fake.cancelledTurns).toEqual([]);
      const live = await running('n-live');
      expect(await addJobNote(live.sara.brickId, live.sara.id, live.jobId, 'Fine', minutes(2))).toMatchObject({ ok: true });
    });

    it('only the Brick’s owner, only a job of that Brick: someone else, or a job id of another Brick, is `not_found` and keeps nothing', async () => {
      const a = await running('n-own-a');
      const b = await running('n-own-b');
      expect(await addJobNote(a.sara.brickId, b.sara.id, a.jobId, 'not mine', minutes(1))).toEqual({ ok: false, reason: 'not_found' });
      expect(await addJobNote(a.sara.brickId, a.sara.id, b.jobId, 'not this Brick', minutes(1))).toEqual({ ok: false, reason: 'not_found' });
      expect(await addJobNote(a.sara.brickId, a.sara.id, a.jobId, '   ', minutes(1))).toEqual({ ok: false, reason: 'empty' });
      expect(await notesOf(a.jobId)).toEqual([]);
      expect(await notesOf(b.jobId)).toEqual([]);
    });
  });

  describe('the runner gives the notes to the agent', () => {
    it('GET job carries the pending notes in order; `notes-sent` marks up to `through`, once; said again it marks nothing; a later note is still pending', async () => {
      const { sara, jobId, epoch } = await running('n-sent');
      await addJobNote(sara.brickId, sara.id, jobId, 'first', minutes(1));
      await addJobNote(sara.brickId, sara.id, jobId, 'second', minutes(1));
      const got = await (await getRunnerJob(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/${jobId}`), { params: Promise.resolve({ id: sara.brickId, jobId }) })).json();
      expect(got.job.notes).toEqual([{ seq: 1, text: 'first' }, { seq: 2, text: 'second' }]);
      const say = async (body: Record<string, unknown>) =>
        (await runnerAction(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/${jobId}`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: sara.brickId, jobId }) })).json();
      expect(await say({ action: 'notes-sent', epoch, through: 1 })).toEqual({ ok: true, sent: 1 });
      expect(await say({ action: 'notes-sent', epoch, through: 1 })).toEqual({ ok: true, sent: 0 });
      expect(await pendingNotes(jobId)).toEqual([{ seq: 2, text: 'second' }]);
      await addJobNote(sara.brickId, sara.id, jobId, 'third', minutes(2));
      expect(await say({ action: 'notes-sent', epoch, through: 2 })).toEqual({ ok: true, sent: 1 });
      expect(await pendingNotes(jobId)).toEqual([{ seq: 3, text: 'third' }]);
    });

    it('a worker that was replaced marks nothing (`superseded`), so the note waits for the owner; CONTROL: the owner’s mark lands', async () => {
      const { sara, jobId, epoch } = await running('n-sent-old');
      await addJobNote(sara.brickId, sara.id, jobId, 'use 12 March', minutes(1));
      const newer = await claimed(jobId, 'rB', minutes(2));
      expect(await notesSent(jobId, { through: 1, epoch })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await notesSent(jobId, { through: 1 })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await pendingNotes(jobId)).toHaveLength(1);
      expect(await notesSent(jobId, { through: 1, epoch: newer })).toEqual({ ok: true, sent: 1 });
    });
  });

  describe('Activity: the steps so far', () => {
    it('keeps each NEW step the owner reports, in order; a repeat of the step in hand adds nothing; an empty label adds nothing', async () => {
      const { sara, jobId, epoch } = await running('a-steps');
      for (const label of ['Opening the visa site', 'Opening the visa site', 'Filling the dates', null, '', 'Checking the form']) {
        await reportProgressAs(jobId, { stepDone: 1, label }, { epoch });
      }
      expect((await stepsOf(jobId)).map((step) => [step.seq, step.label])).toEqual([
        [1, 'Opening the visa site'],
        [2, 'Filling the dates'],
        [3, 'Checking the form'],
      ]);
      const activity = await jobActivity(sara.brickId, sara.id, jobId);
      expect(activity).toMatchObject({ ok: true, job: { id: jobId, title: 'Visa form', status: 'running' } });
      if (activity.ok) expect(activity.steps).toHaveLength(3);
    });

    it('shows the person’s own notes and the pauses between the steps, in time order, each with a stable key; a job paused while in line shows its pause', async () => {
      const { sara, jobId, epoch } = await running('a-mixed');
      await reportProgressAs(jobId, { stepDone: 1, label: 'Opening the visa site' }, { epoch });
      await prisma.computerJobStep.updateMany({ where: { jobId }, data: { at: minutes(1) } });
      await addJobNote(sara.brickId, sara.id, jobId, 'use 12 March', minutes(2));
      await prisma.computerJobPause.create({ data: { jobId, n: 1, why: 'person', at: minutes(3), seconds: 120 } });
      await prisma.computerJobPause.create({ data: { jobId, n: 2, why: 'allowance', at: minutes(5), seconds: 60 } });
      const activity = await jobActivity(sara.brickId, sara.id, jobId);
      if (!activity.ok) throw new Error('no activity');
      expect(activity.steps.map((line) => [line.seq, line.key, line.kind, line.label])).toEqual([
        [1, 'step:1', 'step', 'Opening the visa site'],
        [2, 'note:1', 'note', 'use 12 March'],
        [3, 'pause:1', 'pause', 'Paused by you'],
        [4, 'pause:2', 'pause', "Paused: this month's computer time is used up"],
      ]);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Clock' }, minutes(6));
      if (!second.ok) throw new Error('no second job');
      await prisma.computerJob.update({ where: { id: second.job.id }, data: { queuedFor: 'paused', pausedAt: minutes(7), pausedWhy: 'rule' } });
      const queued = await jobActivity(sara.brickId, sara.id, second.job.id);
      expect(queued).toMatchObject({ ok: true, steps: [{ seq: 1, key: 'paused:now', kind: 'pause', label: 'Paused: it reached the spending limit you set' }] });
      // Another person never sees these words
      const other = await person('a-mixed-other');
      expect(await jobActivity(sara.brickId, other.id, jobId)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('a worker that was replaced adds no step to its successor’s list; CONTROL: the owner’s step is added', async () => {
      const { jobId, epoch } = await running('a-old');
      const newer = await claimed(jobId, 'rB', minutes(1));
      await reportProgressAs(jobId, { stepDone: 1, label: 'Old worker step' }, { epoch });
      expect(await appendStep(jobId, 'Old worker step, direct', { epoch })).toBe(false);
      expect(await stepsOf(jobId)).toEqual([]);
      await reportProgressAs(jobId, { stepDone: 1, label: 'Owner step' }, { epoch: newer });
      expect((await stepsOf(jobId)).map((step) => step.label)).toEqual(['Owner step']);
    });

    it('a job that is over takes no new step, and keeps the ones it has', async () => {
      const { jobId, epoch } = await running('a-over');
      await reportProgressAs(jobId, { stepDone: 1, label: 'Step one' }, { epoch });
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'done', endedAt: minutes(1) } });
      expect(await appendStep(jobId, 'After the end', { epoch })).toBe(false);
      expect((await stepsOf(jobId)).map((step) => step.label)).toEqual(['Step one']);
    });

    it('keeps the newest steps up to the Limits value; older ones drop off', async () => {
      await saveServerLimits({ bricks: { computerSteps: 10 } }, 'admin');
      const { jobId, epoch } = await running('a-limit');
      for (let n = 1; n <= 13; n++) await reportProgressAs(jobId, { stepDone: n, label: `Step ${n}` }, { epoch });
      const steps = await stepsOf(jobId);
      expect(steps.map((step) => step.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    it('a step that looks like a secret is shown as the bar shows it, never as written', async () => {
      const { jobId, epoch } = await running('a-secret');
      await reportProgressAs(jobId, { stepDone: 1, label: 'export API_KEY=sk-live-0123456789abcdef0123456789abcdef' }, { epoch });
      const steps = await stepsOf(jobId);
      expect(steps).toHaveLength(1);
      expect(steps[0].label).not.toContain('sk-live');
    });

    it('only the owner of the Brick, only a job of that Brick', async () => {
      const a = await running('a-own-a');
      const b = await running('a-own-b');
      expect(await jobActivity(a.sara.brickId, b.sara.id, a.jobId)).toEqual({ ok: false, reason: 'not_found' });
      expect(await jobActivity(a.sara.brickId, a.sara.id, b.jobId)).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('Brick’s door', () => {
    it('only the Brick’s owner: someone else and a guest are `not_owner` and nothing is called; CONTROL: the owner’s list answers the view', async () => {
      const a = await running('d-own-a');
      const b = await running('d-own-b');
      expect(await door(a.sara.brickId, { action: 'list', personId: b.sara.uuid })).toEqual({ ok: false, reason: 'not_owner' });
      expect(await door(a.sara.brickId, { action: 'pause', personId: 'guest-1', isGuest: true, jobId: a.jobId })).toEqual({ ok: false, reason: 'not_owner' });
      expect(await door(a.sara.brickId, { action: 'pause', personId: b.sara.uuid, jobId: a.jobId })).toEqual({ ok: false, reason: 'not_owner' });
      expect(await door(a.sara.brickId, { action: 'cancel', personId: b.sara.uuid, jobId: a.jobId })).toEqual({ ok: false, reason: 'not_owner' });
      expect(cancelJob).not.toHaveBeenCalled();
      expect(pauseJob).not.toHaveBeenCalled();
      const listed = await door(a.sara.brickId, { action: 'list', personId: a.sara.uuid });
      expect(listed.ok).toBe(true);
      expect(listed.view.job.id).toBe(a.jobId);
    });

    it('note, activity and the controls go through the same library calls, with the owner and the job', async () => {
      const { sara, jobId, epoch } = await running('d-calls');
      await reportProgressAs(jobId, { stepDone: 1, label: 'Opening the visa site' }, { epoch });
      const noted = await door(sara.brickId, { action: 'note', personId: sara.uuid, jobId, text: 'use 12 March' });
      expect(noted).toMatchObject({ ok: true, note: { seq: 1, delivery: 'now' } });
      expect(await pendingNotes(jobId)).toEqual([{ seq: 1, text: 'use 12 March' }]);
      const activity = await door(sara.brickId, { action: 'activity', personId: sara.uuid, jobId });
      expect(activity).toMatchObject({ ok: true, job: { id: jobId }, steps: [{ seq: 1, kind: 'step', key: 'step:1', label: 'Opening the visa site' }, { seq: 2, kind: 'note', key: 'note:1', label: 'use 12 March' }] });
      expect(await door(sara.brickId, { action: 'pause', personId: sara.uuid, jobId })).toEqual({ ok: false, reason: 'taken_over' });
      expect(pauseJob).toHaveBeenCalledWith(sara.brickId, sara.id, jobId, expect.any(Date), aCommand);
      await door(sara.brickId, { action: 'first', personId: sara.uuid, jobId, pauseRunning: true });
      expect(moveJobFirst).toHaveBeenCalledWith(sara.brickId, sara.id, jobId, { pauseRunning: true }, expect.any(Date), aCommand);
      await door(sara.brickId, { action: 'cancel', personId: sara.uuid, jobId });
      expect(cancelJob).toHaveBeenCalledWith(sara.brickId, sara.id, jobId, expect.any(Date), aCommand);
      // A job of another Brick is not found here
      const other = await running('d-calls-other');
      expect(await door(sara.brickId, { action: 'note', personId: sara.uuid, jobId: other.jobId, text: 'x' })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('stop ends everything on the computer (the same as the person’s Stop)', async () => {
      const { sara, jobId } = await running('d-stop');
      const stopped = await door(sara.brickId, { action: 'stop', personId: sara.uuid });
      expect(stopped.ok).toBe(true);
      expect(stopped.view.job).toBeNull();
      expect((await jobOf(jobId)).status).toBe('stopped');
    });

    it('finding 4: every control needs its command id (400 `command_missing`, nothing done); list and activity do not; a retried tool call (the same id) is the same note, and an id used for another control is 400', async () => {
      const { sara, jobId } = await running('d-command');
      for (const body of [{ action: 'pause', personId: sara.uuid, jobId }, { action: 'note', personId: sara.uuid, jobId, text: 'x' }, { action: 'stop', personId: sara.uuid }]) {
        const refused = await doorAnswer(sara.brickId, body, null);
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({ ok: false, reason: 'command_missing' });
        const invalid = await doorAnswer(sara.brickId, body, 'not-a-uuid');
        expect(invalid.status).toBe(400);
      }
      expect(pauseJob).not.toHaveBeenCalled();
      expect(await pendingNotes(jobId)).toEqual([]);
      expect((await jobOf(jobId)).status).toBe('running');
      expect(await door(sara.brickId, { action: 'list', personId: sara.uuid }, null)).toMatchObject({ ok: true });
      expect(await door(sara.brickId, { action: 'activity', personId: sara.uuid, jobId }, null)).toMatchObject({ ok: true });
      const call = randomUUID();
      expect(await door(sara.brickId, { action: 'note', personId: sara.uuid, jobId, text: 'use 12 March' }, call)).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(await door(sara.brickId, { action: 'note', personId: sara.uuid, jobId, text: 'use 12 March' }, call)).toMatchObject({ ok: true, note: { seq: 1 } });
      expect(await pendingNotes(jobId)).toEqual([{ seq: 1, text: 'use 12 March' }]);
      const reused = await doorAnswer(sara.brickId, { action: 'note', personId: sara.uuid, jobId, text: 'use 13 March' }, call);
      expect(reused.status).toBe(400);
      expect(await reused.json()).toMatchObject({ ok: false, reason: 'command_reused' });
      expect(await pendingNotes(jobId)).toEqual([{ seq: 1, text: 'use 12 March' }]);
    });

    it('refuses a JSON null (and other bodies that are not objects) with a 400: no action is taken (the same family as a malformed Stop; CodeRabbit on #1025, N3)', async () => {
      const { sara } = await running('d-null');
      for (const body of ['null', ' null\n', '[]', '1', '"x"', 'true']) {
        const response = await control(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/control`, { method: 'POST', body }), { params: Promise.resolve({ id: sara.brickId }) });
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
      }
      expect(pauseJob).not.toHaveBeenCalled();
    });

    it('refuses a body it does not know (strict): no action is taken', async () => {
      const { sara, jobId } = await running('d-strict');
      const response = await control(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/control`, { method: 'POST', body: JSON.stringify({ action: 'pause', personId: sara.uuid, jobId, extra: 1 }) }), { params: Promise.resolve({ id: sara.brickId }) });
      expect(response.status).toBe(400);
      expect(pauseJob).not.toHaveBeenCalled();
    });
  });
});
