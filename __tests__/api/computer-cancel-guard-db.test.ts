/**
 * Cancel guard: a Cancel that carries `expected: 'not_started'` (the person was told the job had not started, so nothing was asked) is refused as `started` when the job has started since, against a real database.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-cancel-guard-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});

jest.mock('@/lib/computer-commands', () => {
  const actual = jest.requireActual('@/lib/computer-commands');
  return { ...actual, seenCommand: jest.fn((...args: unknown[]) => actual.seenCommand(...args)) };
});

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { machineDoesSignIns } from '../helpers/working-signins';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { controlInternals, giveComputer, notStartedYet, startJob } from '@/lib/computer';
import { cancelJob, moveJobFirst, pauseJob, resumeWait } from '@/lib/computer-job-controls';
import * as commands from '@/lib/computer-commands';
import { getSessionUser } from '@/lib/auth-session';
import { POST as CONTROL } from '@/app/api/bots/[id]/computer-jobs/control/route';
import { POST as PANEL } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/cancel/route';

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
  await giveComputer(brick.id, user.id);
  return { id: user.id, uuid: unique, brickId: brick.id };
}
type Person = Awaited<ReturnType<typeof person>>;

const setUp = () =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const commandsOf = (jobId: string) => prisma.$queryRaw<Array<{ outcome: unknown }>>`SELECT "outcome" FROM "computer_job_commands" WHERE "job_id" = ${jobId}`;

/** A job that holds the machine (A) and one waiting in line behind it, never started (B). */
async function lineOf2(name: string) {
  const sara = await person(name);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the first job did not start');
  const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hotel' }, minutes(1));
  if (!second.ok || second.job.status !== 'queued') throw new Error('the second job did not wait in line');
  return { sara, a: started.job.id, b: second.job.id };
}

const control = async (sara: Person, body: Record<string, unknown>, command: string = randomUUID()) => {
  const res = await CONTROL(
    new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/control`, { method: 'POST', body: JSON.stringify({ personId: sara.uuid, ...body }), headers: { 'content-type': 'application/json', 'x-computer-command': command } }),
    { params: Promise.resolve({ id: sara.brickId }) },
  );
  return { status: res.status, body: await res.json() };
};

/** Runs `gap` right before the next ending of a job in line is tried: the moment between the person being told "not started" and the cancel landing. */
function inTheGap(gap: () => Promise<void>) {
  const real = controlInternals.endByPerson;
  let armed = true;
  return jest.spyOn(controlInternals, 'endByPerson').mockImplementation(async (...args) => {
    if (armed) {
      armed = false;
      await gap();
    }
    return real(...args);
  });
}

run('cancel guard: a Cancel told "not started" never ends a job that started, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    // (jest.restoreAllMocks in the cases below wipes the passthrough, so it is set again before every case)
    jest.mocked(commands.seenCommand).mockImplementation((...args) => jest.requireActual('@/lib/computer-commands').seenCommand(...args));
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    const fake = new FakeComputerProvider();
    machineDoesSignIns(fake);
    setComputerProviderForTests(fake);
    await setUp();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('the library', () => {
    it('a job still waiting in line is cancelled as before, with nothing charged', async () => {
      const { sara, a, b } = await lineOf2('g-waiting');
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(2), undefined, 'not_started')).toMatchObject({ ok: true });
      expect(await jobOf(b)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await prisma.meterEvent.count({ where: { jobId: b } })).toBe(0);
      expect(await jobOf(a)).toMatchObject({ status: 'running' });
    });

    it('a job that already holds the machine is refused as `started`, and runs on', async () => {
      const { sara, a } = await lineOf2('g-running');
      expect(await cancelJob(sara.brickId, sara.id, a, minutes(2), undefined, 'not_started')).toEqual({ ok: false, reason: 'started' });
      expect(await jobOf(a)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('a paused job (it ran, and is back in line) is refused as `started`', async () => {
      const { sara, a, b } = await lineOf2('g-paused');
      await pauseJob(sara.brickId, sara.id, a, minutes(2));
      expect(await jobOf(a)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect(await cancelJob(sara.brickId, sara.id, a, minutes(3), undefined, 'not_started')).toEqual({ ok: false, reason: 'started' });
      expect(await jobOf(a)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
      expect((await jobOf(b)).status).not.toBe('stopped');
    });

    it('THE GAP: a job in line starts after the person was asked and before the cancel lands: refused, it keeps running', async () => {
      const { sara, a, b } = await lineOf2('g-gap');
      // The machine frees (the job ahead is cancelled) and the next in line starts, between the look and the ending
      inTheGap(async () => {
        expect(await cancelJob(sara.brickId, sara.id, a, minutes(3))).toMatchObject({ ok: true });
        expect(await jobOf(b)).toMatchObject({ status: 'running' });
      });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(4), undefined, 'not_started')).toEqual({ ok: false, reason: 'started' });
      expect(await jobOf(b)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('THE WRITE: a job that started AND went back in line paused in the gap is still in line, and is not ended either (the ending\'s own write checks it)', async () => {
      const { sara, a, b } = await lineOf2('g-write');
      inTheGap(async () => {
        await cancelJob(sara.brickId, sara.id, a, minutes(3));
        expect(await pauseJob(sara.brickId, sara.id, b, minutes(4))).toMatchObject({ ok: true });
        expect(await jobOf(b)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 1 });
      });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(5), undefined, 'not_started')).toEqual({ ok: false, reason: 'started' });
      expect(await jobOf(b)).toMatchObject({ status: 'queued', queuedFor: 'paused', endedBy: null });
    });

    it('without `expected` the same job in the same gap is cancelled as it always was (nothing changes for callers that asked first)', async () => {
      const { sara, a, b } = await lineOf2('g-compat');
      inTheGap(async () => {
        await cancelJob(sara.brickId, sara.id, a, minutes(3));
      });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(4))).toMatchObject({ ok: true });
      expect(await jobOf(b)).toMatchObject({ status: 'stopped', endedBy: 'person' });
    });

    it('THE WRITE ITSELF: the job starts and is paused between the ending\'s own read and its write: not ended (the WHERE guard)', async () => {
      const { sara, a, b } = await lineOf2('g-write-itself');
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
      let armed = true;
      jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation((async (args: { where?: { id?: string }; select?: unknown }) => {
        const row = await real(args as never);
        // endJob's own read (no select): the row it returns is the stale one, the job moves before the write
        if (armed && args?.where?.id === b && !args.select) {
          armed = false;
          await cancelJob(sara.brickId, sara.id, a, minutes(3));
          expect((await real({ where: { id: b } }))?.status).toBe('running');
          expect(await pauseJob(sara.brickId, sara.id, b, minutes(4))).toMatchObject({ ok: true });
        }
        return row;
      }) as never);
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(5), undefined, 'not_started')).toEqual({ ok: false, reason: 'started' });
      jest.restoreAllMocks();
      expect(await jobOf(b)).toMatchObject({ status: 'queued', queuedFor: 'paused', endedBy: null });
    });

    it('a refusal found AFTER the command was claimed is kept: the job ends later and a retry of the same id still answers started', async () => {
      const { sara, a, b } = await lineOf2('r-kept-after-claim');
      const command = randomUUID();
      inTheGap(async () => {
        await cancelJob(sara.brickId, sara.id, a, minutes(3));
      });
      expect(await control(sara, { action: 'cancel', jobId: b, expected: 'not_started' }, command)).toEqual({ status: 200, body: { ok: false, reason: 'started' } });
      jest.restoreAllMocks();
      await cancelJob(sara.brickId, sara.id, b, minutes(5));
      expect(await control(sara, { action: 'cancel', jobId: b, expected: 'not_started' }, command)).toEqual({ status: 200, body: { ok: false, reason: 'started' } });
    });

    it('notStartedYet: each field on its own means started (the game\'s hasStarted)', () => {
      const base = { status: 'queued', queuedFor: null as string | null, pauses: 0 as number | null, stepDone: 0 };
      expect(notStartedYet(base)).toBe(true);
      expect(notStartedYet({ ...base, status: 'running' })).toBe(false);
      expect(notStartedYet({ ...base, queuedFor: 'paused' })).toBe(false);
      expect(notStartedYet({ ...base, pauses: 1 })).toBe(false);
      expect(notStartedYet({ ...base, stepDone: 1 })).toBe(false);
      expect(notStartedYet({ ...base, pauses: null })).toBe(true);
    });

    it('a job that ended already is `over`, not `started`', async () => {
      const { sara, b } = await lineOf2('g-over');
      await cancelJob(sara.brickId, sara.id, b, minutes(2));
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(3), undefined, 'not_started')).toEqual({ ok: false, reason: 'over' });
    });
  });

  describe('two copies of one command (CodeRabbit on #1038)', () => {
    const PENDING = (jobId: string) => ({ ok: true as const, pending: true as const, targets: [jobId] });
    const rowOf = (sara: Person, jobId: string, expected?: 'not_started') => commands.commandRow(sara.brickId, sara.id, jobId, 'cancel', expected ? { expected } : {}, 0);
    const storedOf = async (jobId: string) => (await commandsOf(jobId))[0]?.outcome;

    it('keepFinalOutcome: a pending outcome becomes final once; the first final outcome stays and the loser is told what is stored', async () => {
      const { sara, a } = await lineOf2('k-final');
      const command = { id: randomUUID() };
      await commands.claimCommand(command, rowOf(sara, a), PENDING(a));
      expect(await commands.keepFinalOutcome(command, { ok: false, reason: 'started' })).toBeNull();
      expect(await commands.keepFinalOutcome(command, { ok: true, targets: [a] })).toEqual({ ok: false, reason: 'started' });
      expect(await storedOf(a)).toEqual({ ok: false, reason: 'started' });
    });

    it('finding 2, the success lands second: a cancel that ends the job after another copy kept `started` answers `started`, and a retry still does', async () => {
      const { sara, b } = await lineOf2('k-success-second');
      const command = { id: randomUUID() };
      inTheGap(async () => {
        // the other copy kept its final answer while this one was between its claim and its ending
        expect(await commands.keepFinalOutcome(command, { ok: false, reason: 'started' })).toBeNull();
      });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(3), command, 'not_started')).toEqual({ ok: false, reason: 'started' });
      jest.restoreAllMocks();
      expect(await storedOf(b)).toEqual({ ok: false, reason: 'started' });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(4), command, 'not_started')).toEqual({ ok: false, reason: 'started' });
    });

    it('finding 2, the refusal lands second: a copy that finds the job started after another copy kept its success answers that success, and the stored success stays', async () => {
      const { sara, a, b } = await lineOf2('k-refusal-second');
      const command = { id: randomUUID() };
      inTheGap(async () => {
        await cancelJob(sara.brickId, sara.id, a, minutes(3));
        expect(await commands.keepFinalOutcome(command, { ok: true, targets: [b] })).toBeNull();
      });
      expect(await cancelJob(sara.brickId, sara.id, b, minutes(4), command, 'not_started')).toMatchObject({ ok: true });
      expect(await storedOf(b)).toEqual({ ok: true, targets: [b] });
    });

    it('finding 1, started: a duplicate that lost the claim to a copy that has not answered is refused `started` (after waiting for it), not answered with the computer', async () => {
      const { sara, a } = await lineOf2('d-started');
      const command = { id: randomUUID() };
      await commands.claimCommand(command, rowOf(sara, a, 'not_started'), PENDING(a));
      // this copy looked (and found nothing stored) before the other copy claimed
      jest.mocked(commands.seenCommand).mockResolvedValueOnce(null);
      const wait = resumeWait.ms;
      resumeWait.ms = 300;
      try {
        expect(await cancelJob(sara.brickId, sara.id, a, minutes(3), command, 'not_started')).toEqual({ ok: false, reason: 'started' });
      } finally {
        resumeWait.ms = wait;
      }
      expect(await jobOf(a)).toMatchObject({ status: 'running', endedBy: null });
      // nothing was stored by this copy: the other copy's mark is still pending
      expect(await storedOf(a)).toMatchObject({ pending: true });
    });

    it('finding 1, over: the same for a job that already ended', async () => {
      const { sara, b } = await lineOf2('d-over');
      await cancelJob(sara.brickId, sara.id, b, minutes(2));
      const command = { id: randomUUID() };
      await commands.claimCommand(command, rowOf(sara, b), PENDING(b));
      jest.mocked(commands.seenCommand).mockResolvedValueOnce(null);
      const wait = resumeWait.ms;
      resumeWait.ms = 300;
      try {
        expect(await cancelJob(sara.brickId, sara.id, b, minutes(3), command)).toEqual({ ok: false, reason: 'over' });
      } finally {
        resumeWait.ms = wait;
      }
    });

    it('finding 1, the copy answers what the other copy finally stored (it waits for it)', async () => {
      const { sara, a } = await lineOf2('d-waits');
      const command = { id: randomUUID() };
      await commands.claimCommand(command, rowOf(sara, a, 'not_started'), PENDING(a));
      jest.mocked(commands.seenCommand).mockResolvedValueOnce(null);
      setTimeout(() => void commands.keepFinalOutcome(command, { ok: true, targets: [a] }), 250);
      expect(await cancelJob(sara.brickId, sara.id, a, minutes(3), command, 'not_started')).toMatchObject({ ok: true });
    });

    it('a control whose row is claimed with NO outcome yet (pause, do this first) still keeps its outcome: the shared keepOutcome is unchanged', async () => {
      const one = await lineOf2('d-null-pause');
      const pauseCommand = { id: randomUUID() };
      expect(await pauseJob(one.sara.brickId, one.sara.id, one.a, minutes(3), pauseCommand)).toMatchObject({ ok: true });
      expect(await pauseJob(one.sara.brickId, one.sara.id, one.a, minutes(4), pauseCommand)).toMatchObject({ ok: true });
      expect((await storedOf(one.a)) ?? null).not.toBeNull();
      const two = await lineOf2('d-null-first');
      const firstCommand = { id: randomUUID() };
      expect(await moveJobFirst(two.sara.brickId, two.sara.id, two.b, { pauseRunning: true }, minutes(5), firstCommand)).toMatchObject({ ok: true });
      expect((await storedOf(two.b)) ?? null).not.toBeNull();
    });
  });

  describe('the person\'s own panel route (/api/bricks/:id/computer/jobs/:jobId/cancel)', () => {
    const panel = async (sara: Person, jobId: string, body?: string, command: string = randomUUID()) => {
      jest.mocked(getSessionUser).mockResolvedValue({ id: sara.id } as never);
      const res = await PANEL(
        new NextRequest(`http://orbit.test/api/bricks/${sara.brickId}/computer/jobs/${jobId}/cancel`, { method: 'POST', ...(body === undefined ? {} : { body }), headers: { 'x-computer-command': command } }),
        { params: Promise.resolve({ id: sara.brickId, jobId }) },
      );
      return { status: res.status, body: await res.json() };
    };

    it('a Cancel with `expected: not_started` on a job that started is 409 `started`, nothing is cancelled, and a retry of the same command answers the same', async () => {
      const { sara, a } = await lineOf2('p-started');
      const command = randomUUID();
      const first = await panel(sara, a, JSON.stringify({ expected: 'not_started' }), command);
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ reason: 'started' });
      expect((await panel(sara, a, JSON.stringify({ expected: 'not_started' }), command)).status).toBe(409);
      expect(await jobOf(a)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('THE GAP through the panel: a job in line starts after the person was asked and before the cancel lands: 409 `started`, it keeps running', async () => {
      const { sara, a, b } = await lineOf2('p-gap');
      inTheGap(async () => {
        await cancelJob(sara.brickId, sara.id, a, minutes(3));
        expect(await jobOf(b)).toMatchObject({ status: 'running' });
      });
      const answer = await panel(sara, b, JSON.stringify({ expected: 'not_started' }));
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ reason: 'started' });
      expect(await jobOf(b)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('a job still waiting in line is cancelled with it; without a body the Cancel is as it always was, even on a job that holds the machine', async () => {
      const { sara, a, b } = await lineOf2('p-plain');
      expect((await panel(sara, b, JSON.stringify({ expected: 'not_started' }))).status).toBe(200);
      expect(await jobOf(b)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect((await panel(sara, a)).status).toBe(200);
      expect(await jobOf(a)).toMatchObject({ status: 'stopped', endedBy: 'person' });
    });

    it('a body Orbit does not understand is a 400, never a plain cancel', async () => {
      const { sara, a } = await lineOf2('p-bad');
      for (const body of ['{"expected":"running"}', '{"expected":null}', '{"expected":"not_started","x":1}', '{not json', '[]']) expect((await panel(sara, a, body)).status).toBe(400);
      expect(await jobOf(a)).toMatchObject({ status: 'running' });
    });
  });

  describe('the door the game calls', () => {
    it('a cancel with `expected: not_started` on a job that started answers 200 { ok: false, reason: started }, and a retry of the same command answers the same', async () => {
      const { sara, a } = await lineOf2('r-started');
      const command = randomUUID();
      expect(await control(sara, { action: 'cancel', jobId: a, expected: 'not_started' }, command)).toEqual({ status: 200, body: { ok: false, reason: 'started' } });
      expect(await control(sara, { action: 'cancel', jobId: a, expected: 'not_started' }, command)).toEqual({ status: 200, body: { ok: false, reason: 'started' } });
      expect(await jobOf(a)).toMatchObject({ status: 'running', endedBy: null });
      expect(await commandsOf(a)).toHaveLength(1);
    });

    it('the same command id given without the expectation is another control: refused, nothing cancelled', async () => {
      const { sara, a } = await lineOf2('r-reused');
      const command = randomUUID();
      await control(sara, { action: 'cancel', jobId: a, expected: 'not_started' }, command);
      expect(await control(sara, { action: 'cancel', jobId: a }, command)).toEqual({ status: 400, body: { ok: false, reason: 'command_reused' } });
      expect(await jobOf(a)).toMatchObject({ status: 'running' });
    });

    it('a job still waiting in line is cancelled through the door; a cancel without `expected` is exactly as before, even on a job that holds the machine', async () => {
      const { sara, a, b } = await lineOf2('r-plain');
      const waiting = await control(sara, { action: 'cancel', jobId: b, expected: 'not_started' });
      expect(waiting.status).toBe(200);
      expect(waiting.body.ok).toBe(true);
      expect(await jobOf(b)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      const asked = await control(sara, { action: 'cancel', jobId: a });
      expect(asked.status).toBe(200);
      expect(asked.body.ok).toBe(true);
      expect(await jobOf(a)).toMatchObject({ status: 'stopped', endedBy: 'person' });
    });

    it('an expectation Orbit does not know is a 400, never a plain cancel', async () => {
      const { sara, a } = await lineOf2('r-bad');
      for (const expected of ['running', '', null, 5]) {
        const answer = await control(sara, { action: 'cancel', jobId: a, expected });
        expect(answer.status).toBe(400);
      }
      expect(await jobOf(a)).toMatchObject({ status: 'running' });
    });
  });
});
