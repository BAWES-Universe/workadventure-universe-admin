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
import { isTransactionTimeout, pauseWhenRowFree, setRowLockWaitForTests, untilRowFree } from '@/lib/computer-power';

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
    // The first try waited 15 s inside its transaction and timed out, the second waited for the row: both waits are priced (300 s asked, written about 317 s in)
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

    it('a third timeout is the caller\'s: three tries at most', async () => {
      const sara = await owner('three');
      const tries = jest.fn().mockRejectedValue(timeout());
      const failed = await pauseWhenRowFree(sara.brickId, NOW, tries).catch((error: unknown) => error);
      expect(isTransactionTimeout(failed)).toBe(true);
      expect(tries).toHaveBeenCalledTimes(3);
    });

    it('with waitFirst false the first try goes straight in (a renewal that does not pause never waits)', async () => {
      const sara = await owner('direct');
      const leader = await leaderHolds(sara.brickId, 3_000);
      try {
        const began = Date.now();
        expect(await pauseWhenRowFree(sara.brickId, NOW, async () => 'done', false)).toBe('done');
        expect(Date.now() - began).toBeLessThan(1_000);
      } finally {
        await leader.release();
      }
    }, 30_000);
  });
});
