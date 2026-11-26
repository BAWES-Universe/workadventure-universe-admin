/**
 * Post-0.5.0: a pause of a running job during a take-over. A take-over leader's stop holds the Brick computer's row for up to 120 s (inside the provider's stop), and every pause writes that row inside a 15 s transaction that already
 * holds the job's locks: before this patch each of them timed out (P2028) and did not happen. Now each waits for the row BEFORE its transaction opens, holding nothing, and then pauses as it always did. Every test holds the row the way
 * a leader's stop does (a connection that locked it and does not let go for 17 s) and fails on the head before this patch.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-pause-under-takeover-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { moveJobFirst, pauseJob, pauseJobAs } from '@/lib/computer-job-controls';
import { pauseForLimit } from '@/lib/computer-limit-pause';
import { giveComputer, renewJob, startJob } from '@/lib/computer';
import * as Sentry from '@sentry/nextjs';
import { isRowBusy, isTransactionTimeout, pauseWhenRowFree, setRowLockWaitForTests, setRowRetryBudgetForTests, takeRowOrYield, untilRowFree } from '@/lib/computer-power';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
let fake: FakeComputerProvider;

type Owner = { id: string; brickId: string; ref: string };
async function owner(name: string): Promise<Owner> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id, ref: `fake-${brick.id}` };
}

const settings = (memberAllowanceMicros = 1_000_000) => saveMeterSettings({ memberAllowanceMicros, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.$executeRawUnsafe('DELETE FROM computer_power_ops');
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A connection that locks the Brick computer's row and keeps it (a take-over leader's stop does exactly this across the provider's stop), until `release()`. */
async function leaderHolds(botId: string, forMs: number) {
  let release: () => void = () => undefined;
  let locked: () => void = () => undefined;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 90_000 },
  );
  await lockTaken;
  const timer = setTimeout(() => release(), forMs);
  return {
    release: async () => {
      clearTimeout(timer);
      release();
      await holder;
    },
    held: holder,
  };
}

const jobOf = (id: string) => prisma.computerJob.findUniqueOrThrow({ where: { id } });

run('Post-0.5.0: a pause during a take-over leader\'s stop waits for the computer\'s row and then pauses', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await seedGiveBackLimits();
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await settings();
    // The leader's hold is 17 s: the wait for the row is kept longer than that (as in production, where it is longer than the 120 s hold)
    setRowLockWaitForTests(20_000);
  });
  afterEach(() => {
    setRowLockWaitForTests(null);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  async function running(name: string) {
    const sara = await owner(name);
    const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Work', writes: false }, NOW);
    if (!started.ok || started.job.status !== 'running') throw new Error(`no running job: ${JSON.stringify(started)}`);
    return { sara, job: await jobOf(started.job.id) };
  }

  it('the person\'s own Pause waits for the leader\'s stop (17 s, longer than the 15 s a pause transaction lasts), then pauses: the stretch is charged, nothing is lost', async () => {
    const { sara, job } = await running('person');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      const result = await pauseJob(sara.brickId, sara.id, job.id, new Date(job.stretchStarted!.getTime() + 60_000));
      expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
      expect(result).toMatchObject({ ok: true });
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'person', pauses: 1, reservationKey: null });
    // The job kept running while the pause waited: the 17 s are priced too (asked 60 s into the stretch, written about 77 s in), never the 60 s of the ask
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeGreaterThanOrEqual(76);
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeLessThanOrEqual(82);
  }, 60_000);

  it('a pause of the job\'s own kind (pauseJobAs) waits and then pauses', async () => {
    const { sara, job } = await running('as');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      const result = await pauseJobAs(job.id, 'person', new Date(job.stretchStarted!.getTime() + 30_000));
      expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
      expect(result).toMatchObject({ ok: true, kind: 'held' });
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pauses: 1 });
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeGreaterThanOrEqual(46);
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeLessThanOrEqual(52);
  }, 60_000);

  it('a pause for the month or a limit (a refused model call) waits and then pauses', async () => {
    const { sara, job } = await running('limit');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      const result = await pauseForLimit(job.id, 'allowance', new Date(job.stretchStarted!.getTime() + 45_000));
      expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
      expect(result).toBe('paused');
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', pauses: 1 });
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeGreaterThanOrEqual(61);
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeLessThanOrEqual(67);
  }, 60_000);

  it('a renewal the month refuses waits for the leader\'s stop and then pauses the job in the same renewal (it no longer fails with a timeout)', async () => {
    const { sara, job } = await running('renewal');
    await settings(1_000);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      const answered = await renewJob(job.id, new Date(job.stretchStarted!.getTime() + 300_000));
      expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
      expect(answered).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', pauses: 1 });
    // The pause yielded at once and the renewal waited for the row outside any transaction: the wait is priced (300 s asked, written about 317 s in)
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeGreaterThanOrEqual(316);
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeLessThanOrEqual(322);
    expect(errors.mock.calls.map((call) => call.join(' ')).filter((line) => /P2028|expired transaction/i.test(line))).toEqual([]);
  }, 80_000);

  it('a renewal that does not pause is not held up by the leader\'s stop: it answers at once (the wait is only for a pause)', async () => {
    const { sara, job } = await running('renewalfree');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      expect(await renewJob(job.id, new Date(job.stretchStarted!.getTime() + 60_000))).toMatchObject({ ok: true });
      expect(Date.now() - began).toBeLessThan(3_000);
    } finally {
      await leader.release();
    }
  }, 60_000);

  it('a machine found asleep under a billed job (a machine pause) waits for the leader\'s stop, then sends the job back in line at its last proof', async () => {
    const { sara, job } = await running('machine');
    const began = job.stretchStarted!.getTime();
    expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
    await fake.stop(sara.ref);
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const asked = Date.now();
      expect(await renewJob(job.id, new Date(began + 420_000))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(Date.now() - asked).toBeGreaterThanOrEqual(16_000);
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1, secondsBilled: 120 });
  }, 80_000);

  it('"do this first" that pauses the running job waits for the row BEFORE it takes the line, so the line stays free: another "do this first" is answered at once, and the first one still goes through', async () => {
    const { sara, job: a } = await running('first');
    const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: true }, NOW);
    const c = await startJob({ botId: sara.brickId, personId: sara.id, title: 'C', writes: true }, NOW);
    if (!b.ok || !c.ok) throw new Error('no jobs');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const began = Date.now();
      const pausing = moveJobFirst(sara.brickId, sara.id, b.job.id, { pauseRunning: true }, new Date(a.stretchStarted!.getTime() + 60_000));
      await sleep(1_500);
      // Without a pause nothing is written to the row, so it is not held up, and the line is not held by the one waiting for the row
      const asked = Date.now();
      expect(await moveJobFirst(sara.brickId, sara.id, c.job.id, {}, NOW)).toEqual(expect.objectContaining({}));
      expect(Date.now() - asked).toBeLessThan(2_000);
      const first = await pausing;
      expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
      expect(first).toMatchObject({ ok: true });
    } finally {
      await leader.release();
    }
    expect(await jobOf(a.id)).toMatchObject({ status: 'queued', queuedFor: 'turn', pausedWhy: null, pauses: 1 });
    expect(Number((await jobOf(a.id)).secondsBilled)).toBeGreaterThanOrEqual(76);
    expect(Number((await jobOf(a.id)).secondsBilled)).toBeLessThanOrEqual(82);
  }, 80_000);

  it('no deadlock: a pause and a start blocked on the row at once both settle, and no deadlock or expired transaction is logged (run 3 times)', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let round = 0; round < 3; round++) {
      const { sara, job } = await running(`nodead${round}`);
      const leader = await leaderHolds(sara.brickId, 2_500);
      try {
        const [paused, started] = await Promise.all([pauseJob(sara.brickId, sara.id, job.id, new Date(job.stretchStarted!.getTime() + 20_000)), startJob({ botId: sara.brickId, personId: sara.id, title: 'Next', writes: false }, NOW)]);
        expect(paused).toMatchObject({ ok: true });
        expect(started).toMatchObject({ ok: true });
      } finally {
        await leader.release();
      }
    }
    expect(errors.mock.calls.map((call) => call.join(' ')).filter((line) => /40P01|deadlock|expired transaction|P2028/i.test(line))).toEqual([]);
  }, 80_000);

  it('Opus F1: a refused renewal waiting behind a leader\'s stop never holds the meter lock: an unrelated Brick\'s renewal answers at once meanwhile, and the refused one still pauses afterwards', async () => {
    const { sara, job } = await running('f1a');
    const { job: other } = await running('f1b');
    await settings(1_000);
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const refused = renewJob(job.id, new Date(job.stretchStarted!.getTime() + 300_000));
      await sleep(3_000);
      const asked = Date.now();
      await renewJob(other.id, new Date(other.stretchStarted!.getTime() + 60_000));
      expect(Date.now() - asked).toBeLessThan(2_000);
      expect(await refused).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
    } finally {
      await leader.release();
    }
    expect(await jobOf(job.id)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', pauses: 1 });
  }, 80_000);

  it('Opus F2: in a real take-over the jobs are the person\'s before the stop, so the person\'s Pause and a "do this first" answer `taken_over` at once, not after the leader\'s whole hold', async () => {
    const { sara, job } = await running('f2');
    await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'waiting', control: 'person' } });
    const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Queued', writes: true }, NOW);
    if (!queued.ok) throw new Error('no job');
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      const asked = Date.now();
      const paused = await pauseJob(sara.brickId, sara.id, job.id, new Date(job.stretchStarted!.getTime() + 60_000));
      expect(Date.now() - asked).toBeLessThan(2_000);
      expect(paused).toMatchObject({ ok: false, reason: 'taken_over' });
      const first = Date.now();
      expect(await moveJobFirst(sara.brickId, sara.id, queued.job.id, { pauseRunning: true }, NOW)).toMatchObject({ ok: false, reason: 'taken_over' });
      expect(Date.now() - first).toBeLessThan(2_000);
      // A job in line has no row to write: pausing it does not wait either
      const inLine = Date.now();
      await pauseJob(sara.brickId, sara.id, queued.job.id, NOW);
      expect(Date.now() - inLine).toBeLessThan(2_000);
    } finally {
      await leader.release();
    }
  }, 60_000);

  it('Opus F3: a Restart first holding the row and wanting the job, and a pause holding the job and wanting the row, never deadlock (the pause yields): both finish with no 40P01', async () => {
    const { sara, job } = await running('f3');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let restarted = false;
    const restart = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
        await sleep(1_500);
        await tx.$executeRaw`UPDATE "computer_jobs" SET "lease_version" = "lease_version" WHERE "id" = ${job.id}`;
        restarted = true;
      },
      { timeout: 60_000 },
    );
    await sleep(300);
    const paused = await pauseJobAs(job.id, 'person', new Date(job.stretchStarted!.getTime() + 20_000));
    await restart;
    expect(restarted).toBe(true);
    expect(paused).toMatchObject({ ok: true, kind: 'held' });
    expect(errors.mock.calls.map((call) => call.join(' ')).filter((line) => /40P01|deadlock/i.test(line))).toEqual([]);
  }, 60_000);

  it('Opus F4: a limit pause that finds the row taken on every try is seen in Sentry, and the job keeps running', async () => {
    const { job } = await running('f4');
    const real = prisma.$transaction.bind(prisma);
    let calls = 0;
    // Every try fails with a timeout (until the count that bounds them is used up); the waits between them (the even calls) are the real ones
    jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls % 2 === 1) return Promise.reject(new Prisma.PrismaClientKnownRequestError('Transaction API error: timeout', { code: 'P2028', clientVersion: 'test' }));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const answered = await pauseForLimit(job.id, 'allowance', new Date(job.stretchStarted!.getTime() + 45_000));
    jest.restoreAllMocks();
    expect(answered).toBe('not');
    expect(errors).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: expect.objectContaining({ step: 'limit-pause' }) }));
    expect(await jobOf(job.id)).toMatchObject({ status: 'running', pauses: 0 });
  }, 60_000);

  it('CodeRabbit: the job that starts next on the machine starts when the pause was written, never before it: the wait for the row is not billed twice', async () => {
    const { sara, job } = await running('overlap');
    const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next', writes: true }, NOW);
    if (!next.ok) throw new Error('no job');
    expect(next.job.status).toBe('queued');
    const asked = new Date(job.stretchStarted!.getTime() + 60_000);
    const leader = await leaderHolds(sara.brickId, 17_000);
    try {
      expect(await pauseJobAs(job.id, 'person', asked)).toMatchObject({ ok: true, kind: 'held' });
    } finally {
      await leader.release();
    }
    const pause = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } });
    expect(pause.at.getTime()).toBeGreaterThanOrEqual(asked.getTime() + 16_000);
    const started = await jobOf(next.job.id);
    expect(started.status).not.toBe('queued');
    expect(started.startedAt!.getTime()).toBeGreaterThanOrEqual(pause.at.getTime());
  }, 80_000);

  it('CodeRabbit: the pause is dated after every lock is held: a pause that waited 3 s for the job\'s own lock is dated 3 s later, though it took the computer\'s row at once', async () => {
    const { job } = await running('joblock');
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS one FROM "computer_jobs" WHERE "id" = ${job.id} FOR UPDATE`;
        locked();
        await new Promise<void>((resolve) => (release = resolve));
      },
      { timeout: 30_000 },
    );
    await lockTaken;
    setTimeout(() => release(), 3_000);
    const asked = new Date(job.stretchStarted!.getTime() + 60_000);
    expect(await pauseJobAs(job.id, 'person', asked)).toMatchObject({ ok: true, kind: 'held' });
    await holder;
    const pause = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } });
    expect(pause.at.getTime()).toBeGreaterThanOrEqual(asked.getTime() + 2_800);
    expect(Number((await jobOf(job.id)).secondsBilled)).toBeGreaterThanOrEqual(62);
  }, 60_000);

  describe('the wait itself', () => {
    it('untilRowFree waits for a held row and holds nothing afterwards: the row can be locked at once when it returns', async () => {
      const sara = await owner('until');
      const leader = await leaderHolds(sara.brickId, 2_000);
      try {
        const began = Date.now();
        await untilRowFree(sara.brickId);
        expect(Date.now() - began).toBeGreaterThanOrEqual(1_800);
      } finally {
        await leader.release();
      }
      const again = Date.now();
      await prisma.$transaction((tx) => tx.$queryRaw`SELECT 1 FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE NOWAIT`, { timeout: 3_000, maxWait: 3_000 });
      expect(Date.now() - again).toBeLessThan(1_000);
    }, 30_000);

    const timeout = () => new Prisma.PrismaClientKnownRequestError('Transaction API error: timeout', { code: 'P2028', clientVersion: 'test' });

    it('a try that timed out (the row was taken again between the wait and the transaction) is tried again after another wait, and a try that did not time out is never repeated', async () => {
      const sara = await owner('retry');
      const tries = jest.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce('paused');
      expect(await pauseWhenRowFree(sara.brickId, NOW, tries)).toBe('paused');
      expect(tries).toHaveBeenCalledTimes(2);
      const other = jest.fn().mockRejectedValue(new Error('something else'));
      await expect(pauseWhenRowFree(sara.brickId, NOW, other)).rejects.toThrow('something else');
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('Sentry on #1040: a row that is taken again and again (more than three times) is waited for each time and the pause still happens, instead of ending in an error after the third try', async () => {
      const sara = await owner('many');
      const busy = () => new Error('could not obtain lock on row in relation "brick_computers"');
      const tries = jest.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(busy()).mockRejectedValueOnce(timeout()).mockRejectedValueOnce(busy()).mockRejectedValueOnce(timeout()).mockResolvedValueOnce('paused');
      expect(await pauseWhenRowFree(sara.brickId, NOW, tries)).toBe('paused');
      expect(tries).toHaveBeenCalledTimes(6);
    });

    it('a pause that keeps failing is the caller\'s once its time is up (and never more than the count): the last failure is thrown', async () => {
      const sara = await owner('budget');
      setRowRetryBudgetForTests(80);
      try {
        const slow = jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw timeout();
        });
        const failed = await pauseWhenRowFree(sara.brickId, NOW, slow).catch((error: unknown) => error);
        expect(isTransactionTimeout(failed)).toBe(true);
        expect(slow).toHaveBeenCalledTimes(2);
      } finally {
        setRowRetryBudgetForTests(null);
      }
      const forever = jest.fn().mockRejectedValue(timeout());
      const failedAlways = await pauseWhenRowFree(sara.brickId, NOW, forever).catch((error: unknown) => error);
      expect(isTransactionTimeout(failedAlways)).toBe(true);
      expect(forever).toHaveBeenCalledTimes(25);
    });

    it('a pause that asks for the row while another holds it yields at once instead of waiting (Postgres 55P03), and the error is recognised as a busy row', async () => {
      const sara = await owner('nowait');
      const leader = await leaderHolds(sara.brickId, 3_000);
      try {
        const began = Date.now();
        const failed = await prisma.$transaction((tx) => takeRowOrYield(tx, sara.brickId), { timeout: 10_000, maxWait: 10_000 }).catch((error: unknown) => error);
        expect(Date.now() - began).toBeLessThan(1_000);
        expect(isRowBusy(failed)).toBe(true);
        expect(isRowBusy(new Error('something else'))).toBe(false);
      } finally {
        await leader.release();
      }
    }, 30_000);

    it('a row that was busy is waited for and the same pause tried again', async () => {
      const sara = await owner('busyretry');
      const tries = jest.fn().mockRejectedValueOnce(new Error('could not obtain lock on row in relation "brick_computers"')).mockResolvedValueOnce('paused');
      expect(await pauseWhenRowFree(sara.brickId, NOW, tries)).toBe('paused');
      expect(tries).toHaveBeenCalledTimes(2);
    });
  });
});
