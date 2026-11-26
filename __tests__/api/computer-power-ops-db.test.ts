/**
 * Post-0.5.0 patch 2, B (GPT's eighth note): a provider stop already in flight must never leave a replacement billed on a machine that the stop then puts to sleep. Agent37 has no operation id, so the fence is Orbit's own, in
 * two layers, each tested here against a real database and the pretend provider made to hold a stop the way a slow provider does:
 *  1. serial power operations per machine: every stop or sleep is recorded before it is sent, and a wake takes its ticket only when none of the machine's can still land (a dead sender's stop counts for a bounded life);
 *  2. billing only on a machine proved awake: a renewal reads the machine, and one found asleep ends the stretch at the last proof, prices only the proved seconds and sends the job back in line.
 * Every test here fails on e12af5b7 (the certified chain before this patch).
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-power-ops-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});

// A wrapper that behaves as the real `readControl` unless a test says otherwise (the one test of a hand back that finds no control row)
jest.mock('@/lib/computer-control', () => {
  const actual = jest.requireActual('@/lib/computer-control');
  return { ...actual, readControl: jest.fn(actual.readControl) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits } from '../helpers/give-back-limits';
import { waitUntilBlockedOnLock } from '../helpers/db-blocked';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { moveJobFirst } from '@/lib/computer-job-controls';
import { controlInternals, wakeTimingForTests } from '@/lib/computer';
import { finishJob, giveComputer, handBack, recoverControl, renewJob, requestHandover, settleTurnHold, startJob, sweepComputers, takeOver, setWakeTimingForTests, takeWakeTicketForTests, wakeIfStopped } from '@/lib/computer';
import { beginTransition, readControl } from '@/lib/computer-control';
import { startTurn } from '@/lib/computer-broker';
import { endPowerOp, openPowerOpOf, powerTiming, underPowerOp, PROVIDER_MARGIN_MS, recordPowerOp, setPowerTimingForTests, setRowLockWaitForTests } from '@/lib/computer-power';
import { LONGEST_ACCOUNT_CALL_MS } from '@/lib/agent37/client';
import { costOfSeconds } from '@/lib/computer-values';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

/** The pretend provider, able to hold a stop after it was sent (the provider got it and acts on it only when released), the way a slow Agent37 stop lands after its claim. */
class HeldStops extends FakeComputerProvider {
  /** How many of the next stop calls are held. */
  holdNext = 0;
  readonly held: Array<() => void> = [];
  /** How many of the next sleep calls are held. */
  holdRest = 0;
  async rest(ref: string): Promise<void> {
    if (this.holdRest > 0) {
      this.holdRest--;
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    return super.rest(ref);
  }
  /** The next wake calls that are held BEFORE they reach the machine (a wake request that is slow to arrive). */
  holdWake = 0;
  readonly heldWake: Array<() => void> = [];
  async wake(ref: string, options?: { stillMine?: () => Promise<boolean> }): Promise<void> {
    if (this.holdWake > 0) {
      this.holdWake--;
      await new Promise<void>((resolve) => this.heldWake.push(resolve));
    }
    await super.wake(ref, this.pausedAfterCheck(options));
    // The start was SENT: it passed the check of the start's wake (a test reads this to see that nothing was sent)
    this.wakeSent.push(ref);
    if (this.failWakeAfterLanding) {
      this.failWakeAfterLanding = false;
      throw new Error('The pretend provider started the machine and then did not find it healthy');
    }
  }
  /** How many of the next calls pause right AFTER their first successful stillMine check (a sender that is slow to send after the check). */
  holdAfterCheck = 0;
  readonly heldAfterCheck: Array<() => void> = [];
  private pausedAfterCheck<T extends { stillMine?: () => Promise<boolean> } | undefined>(options: T): T {
    if (!options?.stillMine || this.holdAfterCheck <= 0) return options;
    this.holdAfterCheck--;
    const check = options.stillMine;
    let paused = false;
    return {
      ...options,
      stillMine: async () => {
        const ok = await check();
        if (ok && !paused) {
          paused = true;
          await new Promise<void>((resolve) => this.heldAfterCheck.push(resolve));
        }
        return ok;
      },
    };
  }
  /** The wake calls that were sent to the machine (a call refused by the start's own check never gets here). */
  readonly wakeSent: string[] = [];
  /** The next wake call reaches the machine (it is awake) and then rejects. */
  failWakeAfterLanding = false;
  /** The next readiness checks that are held (a wake that is slow to finish). */
  holdReady = 0;
  readonly heldReady: Array<() => void> = [];
  async ready(ref: string, options?: { freshBoot?: boolean; stillMine?: () => Promise<boolean> }): ReturnType<FakeComputerProvider['ready']> {
    if (this.holdReady > 0) {
      this.holdReady--;
      await new Promise<void>((resolve) => this.heldReady.push(resolve));
    }
    if (this.failReadyAfterHold) {
      this.failReadyAfterHold = false;
      throw new Error('The pretend provider failed on ready');
    }
    return super.ready(ref, this.pausedAfterCheck(options));
  }
  /** The held readiness check fails when it is released (the late wake could not be made ready). */
  failReadyAfterHold = false;
  async stop(ref: string): Promise<void> {
    if (this.holdNext > 0) {
      this.holdNext--;
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    return super.stop(ref);
  }
}
let fake: HeldStops;

type Owner = { id: string; brickId: string; ref: string };
async function owner(name: string): Promise<Owner> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id, ref: `fake-${brick.id}` };
}

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.$executeRawUnsafe('DELETE FROM computer_power_ops');
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const until = async (what: () => Promise<boolean> | boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The watch time of an abandoned wake's turn hold has passed (the hold's date is now behind the clock). */
const watchPassed = (sara: { brickId: string }) => prisma.$executeRaw`UPDATE "brick_computers" SET "turn_unproven_since" = ((NOW() AT TIME ZONE 'UTC') - interval '1 second') WHERE "bot_id" = ${sara.brickId} AND "turn_unproven_since" IS NOT NULL`;
const machineOf = async (sara: Owner) => prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
const callNames = () => fake.calls.map((call) => call.name).filter((name) => name === 'stop' || name === 'wake');

run('Post-0.5.0 B: a stop already sent never leaves a replacement billed on a machine it then puts to sleep', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await seedGiveBackLimits();
    fake = new HeldStops();
    setComputerProviderForTests(fake);
    setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 1_500, waitMs: 8_000, pollMs: 20 });
    await setUp();
  });
  afterEach(() => {
    for (const release of fake.held.splice(0)) release();
    setPowerTimingForTests(null);
    setWakeTimingForTests(null);
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('the bounded life of a dead sender is the client’s longest call plus the margin, on top of the beat it missed', () => {
    setPowerTimingForTests(null);
    expect(LONGEST_ACCOUNT_CALL_MS).toBe(4 * 30_000 + 1_000 + 3_000 + 8_000);
    // a stop or a sleep makes two calls in a row (it looks the machine up, then sends), so a sender whose beats fail can still POST after both
    expect(powerTiming().deadLifeMs).toBe(powerTiming().staleMs + 2 * LONGEST_ACCOUNT_CALL_MS + PROVIDER_MARGIN_MS);
  });

  describe('layer 1: serial power operations', () => {
    it('(a) GPT’s trace: a claimed stop is held, the sweep’s stop proves the machine asleep, a replacement asks to wake: it waits for the held stop to return, then wakes, and ends awake with nothing billed before readiness', async () => {
      const sara = await owner('held');
      // A's start: the machine wakes and is not ready, so A's own (claimed) stop is sent, and the provider holds it
      fake.failNext.ready = true;
      fake.holdNext = 1;
      const a = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.held.length === 1);
      expect((await machineOf(sara)).machine).toBe('stopping');
      // The sweep issues another stop and sees the machine asleep
      await sweepComputers(NOW);
      expect((await machineOf(sara)).machine).toBe('stopped');
      expect(await fake.awake(sara.ref)).toBe(false);
      // B, the replacement, asks to wake it: it does not while A's stop can still land
      const bWall = Date.now();
      const b = startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
      await sleep(400);
      expect(callNames()).toEqual(['wake', 'stop']);
      expect((await machineOf(sara)).machine).toBe('stopped');
      // A's stop lands now
      const landedWall = Date.now();
      fake.held.splice(0).forEach((release) => release());
      const [startedA, startedB] = await Promise.all([a, b]);
      expect(startedA).toEqual({ ok: false, reason: 'broken_start' });
      expect(startedB).toMatchObject({ ok: true, job: { status: 'running' } });
      // A's stop landed before B's wake: the machine is awake under B, and Orbit says so
      expect(callNames()).toEqual(['wake', 'stop', 'stop', 'wake']);
      expect(await fake.awake(sara.ref)).toBe(true);
      expect((await machineOf(sara)).machine).toBe('working');
      // B's billing began only at its own readiness, after A's stop landed: nothing before it is billable
      const jobB = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'B' } });
      expect(jobB.stretchStarted).not.toBeNull();
      expect(jobB.stretchStarted!.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(landedWall - bWall - 5);
      expect(jobB.secondsRun).toBe(0);
      // Every operation is closed
      expect(await openPowerOpOf(prisma, sara.ref)).toBeNull();
    });

    it('a replacement that finds the machine `stopping` proves it asleep itself, then waits for the held stop and wakes (it no longer fails on its own stale read)', async () => {
      const sara = await owner('stale');
      fake.failNext.ready = true;
      fake.holdNext = 1;
      const a = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.held.length === 1);
      const b = startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
      await until(async () => (await machineOf(sara)).machine === 'stopped');
      await sleep(300);
      expect(callNames()).toEqual(['wake', 'stop']);
      fake.held.splice(0).forEach((release) => release());
      const [, startedB] = await Promise.all([a, b]);
      expect(startedB).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(callNames()).toEqual(['wake', 'stop', 'stop', 'wake']);
      expect(await fake.awake(sara.ref)).toBe(true);
      expect((await machineOf(sara)).machine).toBe('working');
    });

    it('(a, other order) a stop that returned before the replacement asked: the replacement wakes at once', async () => {
      const sara = await owner('returned');
      fake.failNext.ready = true;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect(await openPowerOpOf(prisma, sara.ref)).toBeNull();
      const began = Date.now();
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW)).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(Date.now() - began).toBeLessThan(2_000);
      expect(await fake.awake(sara.ref)).toBe(true);
    });

    it('the ticket and the record exclude each other: a recorded stop refuses the ticket; a ticket taken first makes a claimed stop send nothing', async () => {
      const sara = await owner('order');
      // The machine exists and is stopped
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const seen = await machineOf(sara);
      // Stop first: the ticket is refused while it is open, and taken once it is done
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      const refused = await takeWakeTicketForTests(sara.brickId, 'waking', 'stopped', { epoch: seen.wakeEpoch });
      expect(refused).toMatchObject({ open: { id: op, kind: 'stop', live: true } });
      expect((await machineOf(sara)).wakeEpoch).toBe(seen.wakeEpoch);
      await endPowerOp(op);
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'stopped', { epoch: seen.wakeEpoch })).toBe(seen.wakeEpoch + 1);
      // Ticket first: the sweep SELECTS the machine `stopping` and is held there; a wake takes its ticket from that state; then the sweep goes on, and its stop claim writes nothing (the machine is `waking`): no stop is sent or recorded
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopping' } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      const original = prisma.brickComputer.findMany.bind(prisma.brickComputer);
      let selected: () => void = () => undefined;
      let go: () => void = () => undefined;
      const sweepSelected = new Promise<void>((resolve) => (selected = resolve));
      const gate = new Promise<void>((resolve) => (go = resolve));
      let selectedStopping = false;
      const spy = jest.spyOn(prisma.brickComputer, 'findMany').mockImplementation((async (args: Parameters<typeof original>[0]) => {
        const rows = await original(args);
        if ((args?.where as { machine?: string } | undefined)?.machine === 'stopping' && rows.some((row) => row.botId === sara.brickId)) {
          selectedStopping = true;
          selected();
          await gate;
        }
        return rows;
      }) as typeof prisma.brickComputer.findMany);
      try {
        const sweeping = sweepComputers(NOW);
        await sweepSelected;
        expect(selectedStopping).toBe(true);
        const current = await machineOf(sara);
        expect(current.machine).toBe('stopping');
        expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'stopping', { epoch: current.wakeEpoch })).toBe(current.wakeEpoch + 1);
        go();
        await sweeping;
      } finally {
        go();
        spy.mockRestore();
      }
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
      expect((await machineOf(sara)).machine).toBe('waking');
      expect(await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM computer_power_ops WHERE provider_ref = ${sara.ref} AND done_at IS NULL`).toEqual([{ n: BigInt(0) }]);
    });

    it('a start, a claimed stop and a recorded stop that arrive while a leader\'s stop holds the computer\'s row wait for it (longer than Prisma\'s own 5 s), and are not taken for failures', async () => {
      const sara = await owner('lockwait');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const seen = await machineOf(sara);
      // Another connection holds the row for longer than the default transaction time, as a leader's stop does while the provider answers
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 30_000 },
      );
      await lockTaken;
      setTimeout(() => release(), 6_500);
      const began = Date.now();
      const ticket = await takeWakeTicketForTests(sara.brickId, 'waking', 'stopped', { epoch: seen.wakeEpoch });
      expect(Date.now() - began).toBeGreaterThanOrEqual(6_000);
      expect(ticket).toBe(seen.wakeEpoch + 1);
      await holder;
    }, 40_000);

    it('a start whose claim takes the computer\'s row waits for a leader\'s stop that holds it longer than 15 s, then claims (it no longer gives up with a timeout)', async () => {
      const sara = await owner('claimwait');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working' } });
      setRowLockWaitForTests(20_000);
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 },
      );
      try {
        await lockTaken;
        setTimeout(() => release(), 17_000);
        const began = Date.now();
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
        expect(Date.now() - began).toBeGreaterThanOrEqual(16_000);
        expect(started).toMatchObject({ ok: true, job: { status: 'running' } });
      } finally {
        release();
        await holder;
        setRowLockWaitForTests(null);
      }
    }, 80_000);

    it('a start waiting for the computer\'s row behind a leader\'s stop does not hold the line lock: a "do this first" request meanwhile is answered, and the start still goes on once the stop lets go', async () => {
      const sara = await owner('lineheld');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no jobs');
      setRowLockWaitForTests(20_000);
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 },
      );
      try {
        await lockTaken;
        // A third start reaches the machine's claim and waits for the row behind the holder
        let thirdSettled = false;
        const third = startJob({ botId: sara.brickId, personId: sara.id, title: 'C', writes: false }, NOW).finally(() => (thirdSettled = true));
        // The checkpoint: the database itself shows the third start's claim waiting on the computer's row. A start that exited before this fails the test instead of passing it by luck
        await waitUntilBlockedOnLock(1);
        expect(thirdSettled).toBe(false);
        setTimeout(() => release(), 17_000);
        const asked = Date.now();
        // The start's wait for the row must not hold the line: this is answered at once, not after the 15 s a "do this first" transaction lasts
        const first = await moveJobFirst(sara.brickId, sara.id, b.job.id, {}, NOW);
        expect(first).toMatchObject({ ok: true });
        expect(Date.now() - asked).toBeLessThan(2_000);
        // The intended reorder: B is now first in line (ahead of A's turn and of every other job waiting)
        const queued = await prisma.computerJob.findMany({ where: { botId: sara.brickId, status: 'queued' }, select: { id: true, queueRank: true }, orderBy: [{ queueRank: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
        expect(queued[0]?.id).toBe(b.job.id);
        expect(thirdSettled).toBe(false);
        expect(await third).toMatchObject({ ok: true });
      } finally {
        release();
        await holder;
        setRowLockWaitForTests(null);
      }
    }, 80_000);

    it('a start and a "do this first" that pauses the running job, both blocked on the computer\'s row, never deadlock: both settle, and no deadlock or expired transaction is logged', async () => {
      const sara = await owner('nodeadlock');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: true }, NOW);
      if (!a.ok || !b.ok) throw new Error('no jobs');
      expect(b.job.status).toBe('queued');
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 30_000 },
      );
      try {
        await lockTaken;
        setTimeout(() => release(), 3_000);
        const [third, first] = await Promise.all([
          startJob({ botId: sara.brickId, personId: sara.id, title: 'C', writes: false }, NOW),
          moveJobFirst(sara.brickId, sara.id, b.job.id, { pauseRunning: true }, NOW),
        ]);
        expect(third).toMatchObject({ ok: true });
        expect(first).toMatchObject({ ok: true });
        expect(errors.mock.calls.map((call) => call.join(' ')).filter((line) => /40P01|deadlock|expired transaction|P2028/i.test(line))).toEqual([]);
      } finally {
        errors.mockRestore();
        release();
        await holder;
      }
    }, 60_000);

    it('an operation recorded by a transaction that waited for the computer\'s row is stamped when it was written, not when the transaction began: it is born live', async () => {
      const sara = await owner('born');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${sara.brickId} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 30_000 },
      );
      await lockTaken;
      setTimeout(() => release(), 2_000);
      const began = Date.now();
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      await holder;
      const [row] = await prisma.$queryRaw<Array<{ sent: Date; beat: Date }>>`SELECT "sent_at" AS sent, "beat_at" AS beat FROM "computer_power_ops" WHERE "id" = ${op}`;
      // Written after the wait (about 2 s in), never at the transaction's start
      expect(row.sent.getTime()).toBeGreaterThanOrEqual(began + 1_800);
      expect(row.beat.getTime()).toBeGreaterThanOrEqual(row.sent.getTime());
      expect(await openPowerOpOf(prisma, sara.ref)).toMatchObject({ kind: 'stop', live: true });
    }, 40_000);

    describe('a rest of ours that threw can still land: nothing is started under it', () => {
      async function idleAfterJob(sara: Owner) {
        expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      }

      it('the rest throws: the row stays `resting`; a start inside the margin waits for the operation, wakes the machine only after it is done, and runs on an awake machine', async () => {
        const sara = await owner('rest-threw');
        setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 3_000, waitMs: 8_000, pollMs: 20, marginMs: 800 });
        await idleAfterJob(sara);
        const rest = jest.spyOn(fake, 'rest').mockRejectedValueOnce(new Error('the request timed out'));
        expect(await controlInternals.restIfUnheld(sara.brickId, NOW)).toBe(false);
        rest.mockRestore();
        expect(await machineOf(sara)).toMatchObject({ machine: 'resting' });
        expect(await openPowerOpOf(prisma, sara.ref)).toMatchObject({ kind: 'rest', live: true });
        // The wake is sent only once nothing of ours can land
        const openAtWake: Array<boolean> = [];
        const original = fake.wake.bind(fake);
        const wake = jest.spyOn(fake, 'wake').mockImplementation(async (ref: string) => {
          openAtWake.push((await openPowerOpOf(prisma, ref)) !== null);
          return original(ref);
        });
        try {
          const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
          expect(started).toMatchObject({ ok: true, job: { status: 'running' } });
        } finally {
          wake.mockRestore();
        }
        expect(openAtWake).toEqual([false]);
        expect(await fake.awake(sara.ref)).toBe(true);
        expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
      });

      it('guard: a `working` row with a dead sender\'s operation still inside its life: the start goes back in line holding nothing, and nothing is woken', async () => {
        const sara = await owner('working-open');
        setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 3_000, waitMs: 8_000, pollMs: 20, marginMs: 800 });
        await idleAfterJob(sara);
        await recordPowerOp(sara.brickId, sara.ref, 'stop');
        await sleep(powerTiming().staleMs + 100);
        expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
        const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
        expect(started).toMatchObject({ ok: true, job: { status: 'queued', queuedFor: 'busy' } });
        const jobB = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'B' } });
        expect(jobB).toMatchObject({ status: 'queued', reservationKey: null, stretchStarted: null, startedAt: null });
        expect(await prisma.meterReservation.count({ where: { jobId: jobB.id, state: 'held' } })).toBe(0);
        expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore);
      });

      it('the stuck-rest sweep keeps a 6-minute-old claim while a sleep of ours can still land (a dead sender\'s inside its life), and lets it go once that life is past', async () => {
        const sara = await owner('stuck-rest');
        setPowerTimingForTests({ beatMs: 50, staleMs: 400, deadLifeMs: 2_000, waitMs: 8_000, pollMs: 20, marginMs: 800 });
        await idleAfterJob(sara);
        const claimedAt = new Date(NOW.getTime() - 6 * 60_000);
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting', restClaimedAt: claimedAt } });
        await recordPowerOp(sara.brickId, sara.ref, 'rest');
        await sleep(powerTiming().staleMs + 100);
        await sweepComputers(NOW);
        expect(await machineOf(sara)).toMatchObject({ machine: 'resting', restClaimedAt: claimedAt });
        await sleep(powerTiming().deadLifeMs);
        await sweepComputers(NOW);
        const after = await machineOf(sara);
        // Let go (back to `working`, and possibly rested again by the same sweep under a newer claim): never the old claim
        expect(after.restClaimedAt?.getTime() ?? null).not.toBe(claimedAt.getTime());
      });
    });

    it('a turn hold\'s stop is claimed against the state it saw: a wake that takes its ticket AFTER the state was read and BEFORE the claim gets no stop sent under it (the interleaving is held at the provider look between the two)', async () => {
      const sara = await owner('holdclaim');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working', turnUnprovenSince: NOW } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      let tookTicket: number | null | object = null;
      // settleTurnHold has read `working` (a stoppable state) and now looks at the machine: a replacement's wake takes its ticket right here, before the stop is claimed
      const look = jest.spyOn(fake, 'awake').mockImplementationOnce(async () => {
        const seen = await machineOf(sara);
        tookTicket = await takeWakeTicketForTests(sara.brickId, 'waking', 'working', { epoch: seen.wakeEpoch });
        return false;
      });
      try {
        expect(await settleTurnHold(sara.brickId)).toBe(false);
      } finally {
        look.mockRestore();
      }
      expect(typeof tookTicket).toBe('number');
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
      expect(await openPowerOpOf(prisma, sara.ref)).toBeNull();
      expect((await machineOf(sara)).machine).toBe('waking');
    });

    it('a turn hold on a machine that is `waking` with a beat that is still fresh is left alone (a live wake)', async () => {
      const sara = await owner('holdwaking');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking', turnUnprovenSince: NOW } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
      expect((await machineOf(sara)).machine).toBe('waking');
    });

    it.each(['waking', 'restoring'] as const)('CodeRabbit on #1040: a turn hold on a machine whose `%s` wake was abandoned (no beat for the whole stale time, no job) is stopped and lifted, never left to hold every start in line for ever', async (state) => {
      const sara = await owner(`abandoned-${state}`);
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: state, turnUnprovenSince: NOW } });
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = ((NOW() AT TIME ZONE 'UTC') - interval '10 minutes') WHERE "bot_id" = ${sara.brickId}`;
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      // The stop of an abandoned wake is proved, and the hold stays for the watch time: the wake call that was in flight may still land
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 1);
      const held = await machineOf(sara);
      expect(held.machine).toBe('stopped');
      expect(held.turnUnprovenSince!.getTime()).toBeGreaterThan(Date.now() + 30_000);
      // Inside the watch time the machine is stopped again every pass and the hold stays; once it has passed, one more proved stop lifts it
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 2);
      await watchPassed(sara);
      expect(await settleTurnHold(sara.brickId)).toBe(true);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 3);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
    });

    it('CodeRabbit on #1040: an abandoned wake that was stopped and then RESUMES (it only missed its beats) writes nothing over the stop: the machine stays asleep and the stale wake\'s ticket is gone', async () => {
      const sara = await owner('abandoned-resumes');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdReady = 1;
      // A start wakes the machine and its readiness check is slow: the wake is in flight, and misses its beats
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldReady.length === 1);
      const ticket = (await machineOf(sara)).wakeEpoch;
      expect((await machineOf(sara)).machine).toBe('waking');
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      await sleep(600);
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: expect.any(Date) });
      expect((await machineOf(sara)).wakeEpoch).toBeGreaterThan(ticket);
      // The original wake comes back: its ticket is no longer the Brick's, so it writes nothing over the stop; no job needs the machine any more, so it is not woken again for nobody (Sentry on #1040)
      fake.heldReady.splice(0).forEach((release) => release());
      await starting;
      // (the stop after the resumed wake's own look: `ready` may have restarted the machine, so a start that lost its ticket stops what the row calls stopped, Opus on #1040)
      expect(callNames()).toEqual(['wake', 'wake', 'stop', 'stop']);
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    it('Opus on #1040: a wake call that reaches the provider inside the watch time after the stop of an abandoned wake (its sender may be dead) is stopped again by the next pass, and the hold lifts only after the watch time', async () => {
      const sara = await owner('abandoned-dead-sender');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking', turnUnprovenSince: NOW } });
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = ((NOW() AT TIME ZONE 'UTC') - interval '10 minutes') WHERE "bot_id" = ${sara.brickId}`;
      // The abandoned wake's stop is proved; its hold is pushed out
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await fake.awake(sara.ref)).toBe(false);
      // The dead sender's wake call lands now (nothing of its own will ever clean up after it)
      await fake.wake(sara.ref);
      expect(await fake.awake(sara.ref)).toBe(true);
      // Inside the watch time: the next pass stops it again and the hold stays
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await fake.awake(sara.ref)).toBe(false);
      expect((await machineOf(sara)).turnUnprovenSince).not.toBeNull();
      // After the watch time, a stop sent after it lifts the hold
      await watchPassed(sara);
      expect(await settleTurnHold(sara.brickId)).toBe(true);
      expect(await fake.awake(sara.ref)).toBe(false);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
    });

    it('Opus on #1040: a live sender whose beats failed and whose `ready` restarts the machine after the stop of its abandoned wake was proved leaves the machine asleep (nobody wants it)', async () => {
      const sara = await owner('abandoned-ready-restarts');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdReady = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldReady.length === 1);
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      await sleep(600);
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await fake.awake(sara.ref)).toBe(false);
      // `ready` restarts the machine after the stop was proved, and returns
      await fake.wake(sara.ref);
      expect(await fake.awake(sara.ref)).toBe(true);
      fake.heldReady.splice(0).forEach((release) => release());
      await starting;
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    describe('Opus on #1040: a start sends a power call only while it still owns its wake (stillMine: a fenced beat before every call)', () => {
      /** A computer that has worked and has no mark saved: its next wake asks for a fresh boot (the restart `ready` waits for). */
      const freshBootReady = async (name: string, timing: { beatMs: number; staleMs: number }) => {
        const sara = await owner(name);
        expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        setWakeTimingForTests(timing);
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped', markBootId: null } });
        fake.freshBoots.length = 0;
        fake.wakeSent.length = 0;
        return sara;
      };

      it('the restart of `ready` that comes after the stop of an abandoned wake was proved and its watch passed is never sent, and the machine stays asleep', async () => {
        const sara = await freshBootReady('stillmine-abandoned-restart', { beatMs: 60_000, staleMs: 400 });
        fake.holdReady = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldReady.length === 1);
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
        await sleep(600);
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        await watchPassed(sara);
        // The sender is alive, was only slow, and now sends its restart
        fake.heldReady.splice(0).forEach((release) => release());
        await starting;
        expect(fake.freshBoots).toEqual([]);
        expect(await fake.awake(sara.ref)).toBe(false);
        expect((await machineOf(sara)).machine).toBe('stopped');
      }, 30_000);

      it('a replacement owns the row: the start that lost its wake sends it no stop and no start, its job is NOT failed and the row is NOT written broken (it looks again)', async () => {
        const sara = await freshBootReady('stillmine-replaced', { beatMs: 60_000, staleMs: 120_000 });
        fake.holdReady = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldReady.length === 1);
        const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
        // Another start took the wake over (its ticket is the next number) and is waking the machine itself
        await prisma.$executeRaw`UPDATE "brick_computers" SET "wake_epoch" = "wake_epoch" + 1, "machine" = 'waking', "updated_at" = (NOW() AT TIME ZONE 'UTC') WHERE "bot_id" = ${sara.brickId}`;
        fake.heldReady.splice(0).forEach((release) => release());
        // The replacement finishes its wake while the old start looks again
        await sleep(300);
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId, title: 'A', status: 'failed' } })).toBe(0);
        expect((await machineOf(sara)).machine).toBe('waking');
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working' } });
        await expect(starting).resolves.toMatchObject({ ok: true });
        expect(fake.freshBoots).toEqual([]);
        expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId, title: 'A', status: 'failed' } })).toBe(0);
        expect((await machineOf(sara)).machine).toBe('working');
      }, 30_000);

      it('the start of a wake that was given up on (the stop of the abandoned wake proved, the watch passed) is never sent', async () => {
        const sara = await freshBootReady('stillmine-abandoned-wake', { beatMs: 60_000, staleMs: 400 });
        fake.holdWake = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldWake.length === 1);
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
        await sleep(600);
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        await watchPassed(sara);
        fake.heldWake.splice(0).forEach((release) => release());
        await starting;
        expect(fake.wakeSent).toEqual([]);
        expect(await fake.awake(sara.ref)).toBe(false);
      }, 30_000);

      it('CodeRabbit on #1040, the exact sequence: the check passed, the sender is paused, the wake is given up on and its hold lifted, the start returns late: it is told at once and the machine it started is stopped (not left running through the wait for health)', async () => {
        const sara = await freshBootReady('stillmine-paused-after-check', { beatMs: 60_000, staleMs: 400 });
        fake.holdAfterCheck = 1;
        const healthHeld: Array<() => void> = [];
        // What the real provider does after its start: it waits for the machine to be healthy
        fake.afterStartForTests = () => new Promise<void>((resolve) => healthHeld.push(resolve));
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldAfterCheck.length === 1);
        // The check passed (a beat was written); the sender is paused. Nobody beats any more: the wake is given up on and its hold is lifted after the watch time
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
        await sleep(600);
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        await watchPassed(sara);
        expect(await settleTurnHold(sara.brickId)).toBe(true);
        expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
        const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
        const callsBefore = fake.calls.length;
        // The sender resumes: its start reaches the machine (awake), and it is told it lost its wake as soon as the request returned
        fake.heldAfterCheck.splice(0).forEach((release) => release());
        await until(() => fake.calls.filter((call) => call.name === 'stop').length > stopsBefore, 4_000);
        expect(await fake.awake(sara.ref)).toBe(false);
        // Nothing waited for the machine to be healthy under a wake that was lost
        expect(healthHeld).toEqual([]);
        await starting;
        // After the late start, the provider is asked for exactly one thing: one stop (no readiness step, no second start)
        expect(fake.calls.slice(callsBefore).map((call) => call.name)).toEqual(['stop']);
        expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 1);
        // The row is proved stopped, the hold stays lifted, nothing was written `working` or `broken`, no job was made ready or failed
        expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
        expect(await prisma.computerJob.findMany({ where: { botId: sara.brickId, title: 'A' }, select: { status: true, stretchStarted: true } })).toEqual([{ status: 'done', stretchStarted: null }]);
        fake.afterStartForTests = null;
      }, 30_000);

      it('the same when a replacement wake owns the machine meanwhile: the late start is NOT stopped (the machine is the replacement\'s) and the old start looks again', async () => {
        const sara = await freshBootReady('stillmine-paused-replaced', { beatMs: 60_000, staleMs: 120_000 });
        fake.holdAfterCheck = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldAfterCheck.length === 1);
        const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
        // A replacement took the wake over and is waking the machine itself
        await prisma.$executeRaw`UPDATE "brick_computers" SET "wake_epoch" = "wake_epoch" + 1, "machine" = 'waking', "updated_at" = (NOW() AT TIME ZONE 'UTC') WHERE "bot_id" = ${sara.brickId}`;
        fake.heldAfterCheck.splice(0).forEach((release) => release());
        await sleep(400);
        expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
        expect(await fake.awake(sara.ref)).toBe(true);
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'working' } });
        await expect(starting).resolves.toMatchObject({ ok: true });
        expect(await fake.awake(sara.ref)).toBe(true);
        expect((await machineOf(sara)).machine).toBe('working');
      }, 30_000);

      it('a start that still owns its wake sends the restart once, as before', async () => {
        const sara = await freshBootReady('stillmine-normal', { beatMs: 60_000, staleMs: 120_000 });
        await expect(startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).resolves.toMatchObject({ ok: true });
        expect(fake.freshBoots).toEqual([sara.ref]);
        expect(fake.wakeSent).toEqual([sara.ref]);
        expect((await machineOf(sara)).machine).toBe('working');
      }, 30_000);

      it('the check is a WRITE: a start whose check just landed is not claimed by the sweep for the stale time, and is claimed after it', async () => {
        const sara = await freshBootReady('stillmine-is-a-beat', { beatMs: 60_000, staleMs: 800 });
        fake.holdWake = 1;
        fake.holdReady = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldWake.length === 1);
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
        // Its beat is stale by now (no beat has come)
        await sleep(1000);
        const ticket = (await machineOf(sara)).wakeEpoch;
        // The wake call is released: the check before the start is a beat, so the wake is live again
        fake.heldWake.splice(0).forEach((release) => release());
        await until(() => fake.heldReady.length === 1);
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        expect(await machineOf(sara)).toMatchObject({ machine: 'waking', wakeEpoch: ticket });
        // Left without a beat for the stale time, it is claimed
        await sleep(1000);
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        expect((await machineOf(sara)).wakeEpoch).toBeGreaterThan(ticket);
        fake.heldReady.splice(0).forEach((release) => release());
        await starting;
      }, 30_000);

      it('a check that cannot be written (the database does not answer) is a no: nothing is sent to the machine', async () => {
        const sara = await freshBootReady('stillmine-db-down', { beatMs: 60_000, staleMs: 120_000 });
        const real = prisma.$executeRaw.bind(prisma);
        const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation(((strings: unknown, ...values: unknown[]) =>
          Array.isArray(strings) && strings.join('?').includes(`"machine" IN ('waking', 'restoring')`) ? Promise.reject(new Error('The database did not answer')) : (real as (...args: unknown[]) => unknown)(strings, ...values)) as unknown as typeof prisma.$executeRaw);
        try {
          await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW).catch(() => undefined);
        } finally {
          spy.mockRestore();
        }
        expect(fake.wakeSent).toEqual([]);
        expect(fake.freshBoots).toEqual([]);
        expect(await fake.awake(sara.ref)).toBe(false);
      }, 30_000);
    });

    it('Opus on #1040: an ordinary turn hold on a `stopped` machine lifts after one proved stop', async () => {
      const sara = await owner('hold-stopped');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped', turnUnprovenSince: NOW } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      expect(await settleTurnHold(sara.brickId)).toBe(true);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 1);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
    });

    it('Opus on #1040: a wake is judged abandoned only after its late call can no longer land (stale time beyond a beat plus the provider margin)', () => {
      const { beatMs, staleMs, watchMs } = wakeTimingForTests();
      expect(staleMs).toBeGreaterThan(beatMs + PROVIDER_MARGIN_MS);
      // Opus on #1040: a power call is sent only right after a fenced beat, so the stop of an abandoned wake lands `staleMs` after it at the soonest, and a call retried by the client lands at the latest the longest account call plus the margin after it
      expect(watchMs).toBe(LONGEST_ACCOUNT_CALL_MS + PROVIDER_MARGIN_MS);
      expect(staleMs + watchMs).toBeGreaterThanOrEqual(LONGEST_ACCOUNT_CALL_MS + PROVIDER_MARGIN_MS);
    });

    it('CodeRabbit on #1040: an abandoned wake whose wake call reaches the provider only AFTER the stop was proved stops the machine it woke, and does not wake it again for nobody', async () => {
      const sara = await owner('abandoned-wake-lands-after-stop');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdWake = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldWake.length === 1);
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      await sleep(600);
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: expect.any(Date) });
      const stopsAfterProof = fake.calls.filter((call) => call.name === 'stop').length;
      // The wake call reaches the machine now, after the stop was proved
      fake.heldWake.splice(0).forEach((release) => release());
      await starting;
      // The machine it woke was stopped (one more stop); no job needs it, so it is not woken again
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsAfterProof + 1);
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    it('CodeRabbit on #1040: an abandoned wake whose wake call reaches the provider after the stop was proved, starts the machine and then rejects, leaves no machine awake', async () => {
      const sara = await owner('abandoned-wake-lands-then-rejects');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdWake = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldWake.length === 1);
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      await sleep(600);
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      const stopsAfterProof = fake.calls.filter((call) => call.name === 'stop').length;
      fake.failWakeAfterLanding = true;
      fake.heldWake.splice(0).forEach((release) => release());
      await starting;
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsAfterProof + 1);
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    it('Opus on #1040: a single start whose wake call reached the machine and then rejects (Agent37 started it and its health wait ran out) stops it: the row is not left `broken` with the machine awake', async () => {
      const sara = await owner('wake-rejects-single');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      await fake.stop(sara.ref);
      fake.failWakeAfterLanding = true;
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 1);
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    it('Opus on #1040: a computer turned off while a start\'s wake call is slow (the stop moves no wake number), whose readiness then fails, is not left awake', async () => {
      const sara = await owner('turned-off-during-wake');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdWake = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldWake.length === 1);
      // Turn off computer: the machine is stopped and the row says so, under the same wake number
      const ticket = (await machineOf(sara)).wakeEpoch;
      await fake.stop(sara.ref);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      expect((await machineOf(sara)).wakeEpoch).toBe(ticket);
      fake.failNext.ready = true;
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      fake.heldWake.splice(0).forEach((release) => release());
      await starting.catch(() => undefined);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBeGreaterThan(stopsBefore);
      expect(await fake.awake(sara.ref)).toBe(false);
    }, 30_000);

    it('Opus on #1040: a late wake stop that read `stopping` when the row has since proved `stopped` still sends its stop (the claim takes either state)', async () => {
      const sara = await owner('late-wake-flip');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdWake = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldWake.length === 1);
      await fake.stop(sara.ref);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      // The late wake's look at the row (only machine and provider ref selected) sees `stopping`; the row says `stopped` by the time it claims
      const original = prisma.brickComputer.findUnique.bind(prisma.brickComputer);
      let flipped = false;
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementation(((args: Parameters<typeof original>[0]) => {
        const keys = Object.keys((args as { select?: Record<string, boolean> }).select ?? {}).sort().join(',');
        if (keys === 'machine,providerRef,wakeEpoch' && !flipped) {
          flipped = true;
          return Promise.resolve({ machine: 'stopping', providerRef: sara.ref, wakeEpoch: -1 }) as ReturnType<typeof original>;
        }
        return original(args);
      }) as unknown as typeof prisma.brickComputer.findUnique);
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      try {
        fake.heldWake.splice(0).forEach((release) => release());
        await starting.catch(() => undefined);
      } finally {
        spy.mockRestore();
      }
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBeGreaterThan(stopsBefore);
    }, 30_000);

    it('Sentry on #1040: a computer turned off while a start\'s wake call is slow is stopped, and is woken again only when a job still needs it', async () => {
      for (const wanted of [true, false]) {
        const sara = await owner(`turned-off-wanted-${wanted}`);
        expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
        fake.holdWake = 1;
        const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
        await until(() => fake.heldWake.length === 1);
        await fake.stop(sara.ref);
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
        // The job the start serves ends with the turn-off, or it is still there (a job that needs its computer)
        if (!wanted) await prisma.computerJob.updateMany({ where: { botId: sara.brickId, status: { in: ['running', 'waiting'] } }, data: { status: 'done', endedAt: NOW } });
        const wakesBefore = fake.calls.filter((call) => call.name === 'wake' && call.ref === sara.ref).length;
        fake.heldWake.splice(0).forEach((release) => release());
        await starting.catch(() => undefined);
        const wakes = fake.calls.filter((call) => call.name === 'wake' && call.ref === sara.ref).length - wakesBefore;
        // The held call itself is one wake; a job that still needs the machine wakes it once more
        expect(wakes).toBe(wanted ? 2 : 1);
      }
    }, 30_000);

    it('Opus on #1040: a start whose wake call lands late never stops a machine a replacement woke since (the row is `waking`)', async () => {
      const sara = await owner('late-wake-replaced');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdWake = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldWake.length === 1);
      // A replacement took the dead wake over and is waking the machine itself: the row is `waking` under the next number
      await sleep(500);
      const seen = await machineOf(sara);
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: seen.wakeEpoch, staleMs: 400 })).toBe(seen.wakeEpoch + 1);
      await fake.wake(sara.ref);
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      fake.heldWake.splice(0).forEach((release) => release());
      await starting.catch(() => undefined);
      // The replacement's wake is stale in this test (nothing beats it), so the start may take it over and wake again: it never stops it
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
    }, 30_000);

    it('Opus on #1040: an abandoned wake that was stopped, whose late wake then lands at the provider and fails to be ready, leaves no machine awake: its ticket claims nothing, so the machine is stopped against the state the row has', async () => {
      const sara = await owner('abandoned-late-wake-fails');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'first', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      setWakeTimingForTests({ beatMs: 60_000, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      fake.holdReady = 1;
      const starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      await until(() => fake.heldReady.length === 1);
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      await sleep(600);
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(await fake.awake(sara.ref)).toBe(false);
      // The wake that was given up on still lands at the provider (the machine is awake again), and its readiness check fails
      await fake.wake(sara.ref);
      expect(await fake.awake(sara.ref)).toBe(true);
      fake.failReadyAfterHold = true;
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      fake.heldReady.splice(0).forEach((release) => release());
      await starting;
      expect(await fake.awake(sara.ref)).toBe(false);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBeGreaterThan(stopsBefore);
    }, 30_000);

    it('CodeRabbit on #1040: an abandoned wake that a replacement takes over between the read and the claim is never stopped under the replacement', async () => {
      const sara = await owner('abandoned-replaced');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking', turnUnprovenSince: NOW } });
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = ((NOW() AT TIME ZONE 'UTC') - interval '10 minutes') WHERE "bot_id" = ${sara.brickId}`;
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      // settleTurnHold has read the row and counted the jobs holding the machine (none): the replacement's takeover lands right here, before the stop is claimed
      const original = prisma.computerJob.count.bind(prisma.computerJob);
      const look = jest.spyOn(prisma.computerJob, 'count').mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
        const counted = await original(args);
        const seen = await machineOf(sara);
        // A replacement start takes the dead wake over (its beat has been missed for the whole stale time) and wakes it itself
        await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: seen.wakeEpoch, staleMs: 60_000 });
        return counted;
      }) as typeof prisma.computerJob.count);
      try {
        expect(await settleTurnHold(sara.brickId)).toBe(false);
      } finally {
        look.mockRestore();
      }
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
      expect((await machineOf(sara)).machine).toBe('waking');
    });

    it('CodeRabbit on #1040: a hand back whose wake finds a stop of ours still open after even the extended wait keeps its jobs and stays pending: no job ends, the machine is not marked broken, and the sweep finishes it once the stop is done', async () => {
      const sara = await owner('handback-inflight');
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 300, waitMs: 300, pollMs: 20 });
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      // The fence stopped the machine, and a stop of ours is still in flight (a live sender, beating): it outlasts the hand back's whole wait
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      let release: () => void = () => undefined;
      const inFlight = underPowerOp(op, () => new Promise<void>((resolve) => (release = resolve)));
      try {
        const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
        expect(await handBack(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'in_progress' });
        // Nothing was tried, so nothing failed: the job is Brick's again and running, the machine is as it was, and the return waits
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'running', control: 'brick', stretchStarted: null });
        expect(await machineOf(sara)).toMatchObject({ machine: 'stopped' });
        expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore);
        expect(await readControl(sara.brickId)).toMatchObject({ state: 'returning' });
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ controlLeaseUntil: null });
      } finally {
        release();
        await inFlight;
      }
      // The stop is done: the sweep finishes the return, the machine is woken for the job, and control is Brick's
      await endPowerOp(op).catch(() => undefined);
      expect(await recoverControl(NOW)).toBeGreaterThanOrEqual(1);
      expect(await readControl(sara.brickId)).toMatchObject({ state: 'agent' });
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
      // Opus on #1040, F1: the stopped time of the pending window was never billed: the stretch was banked when the return went pending and starts again now that the machine is back
      const resumed = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(resumed).toMatchObject({ status: 'running', control: 'brick' });
      expect(resumed.stretchStarted).not.toBeNull();
      expect(resumed.stretchStarted!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }, 30_000);

    it('Opus on #1040, F1: a hand back that wakes a stopped machine does not bill the wait or the wake: the stretch so far is banked and starts again at readiness', async () => {
      const sara = await owner('handback-wake-unbilled');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      // The stretch ran for 100 s before the fence stopped the machine (the stop op it sent is the last moment the machine was awake)
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: new Date(Date.now() - 100_000) } });
      await prisma.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at", "done_at") SELECT ${randomUUID()}, ${sara.brickId}, ${sara.ref}, 'stop', t.at, t.at, t.at FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS at) t`;
      const before = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(before.stretchStarted).not.toBeNull();
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      // Banked up to the moment the machine was stopped, and the stretch starts again when it answers (now), not at the take-over
      expect(after.secondsRun).toBeGreaterThanOrEqual(99);
      expect(after.stretchStarted).not.toBeNull();
      expect(after.stretchStarted!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
    }, 30_000);

    it('Sentry on #1040: a hand back that finds the machine awake does not start the stretch of a job whose browser is still being brought back', async () => {
      const sara = await owner('handback-prep-unbilled');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      // The job is running but not ready: its browser is restoring, so no time is booked yet
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { prepState: 'restoring', stretchStarted: null } });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'running', prepState: 'restoring', stretchStarted: null });
    }, 30_000);

    it('Opus on #1040, N1: only the stretches the wake banked start again: a job whose own start has not marked it ready, and one whose browser is being brought back, stay without a stretch', async () => {
      const sara = await owner('wake-banks-only-its-own');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      // Two jobs beside it that have no stretch and were not banked: one mid-start (its own ready write is still to land) and one restoring its browser
      const midStart = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'mid-start', status: 'running', writes: false, startedAt: NOW } });
      const restoring = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'restoring', status: 'running', writes: false, startedAt: NOW, prepState: 'restoring' } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      expect(await wakeIfStopped(sara.brickId)).toBe('up');
      const [aAfter, midAfter, restoringAfter] = await Promise.all([a.job.id, midStart.id, restoring.id].map((id) => prisma.computerJob.findUniqueOrThrow({ where: { id } })));
      expect(aAfter.stretchStarted).not.toBeNull();
      expect(aAfter.stretchStarted!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(midAfter).toMatchObject({ stretchStarted: null, awakeProvedAt: null });
      expect(restoringAfter).toMatchObject({ stretchStarted: null, awakeProvedAt: null, prepState: 'restoring' });
      // The job whose start was in flight can still be marked ready by its own start
      expect(await prisma.$executeRaw`UPDATE "computer_jobs" SET "stretch_started" = NOW() WHERE "id" = ${midStart.id} AND "stretch_started" IS NULL`).toBe(1);
    }, 30_000);

    it('Opus on #1040, N2: a job found beside one the machine was lost under is banked only to its last awake proof, never to now', async () => {
      const sara = await owner('wake-banks-to-proof');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      // Its stretch began ten minutes ago, the machine was last proved awake a minute into it, and it was found stopped (nobody sent that stop)
      const began = new Date(Date.now() - 600_000);
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: began, awakeProvedAt: new Date(began.getTime() + 60_000) } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      expect(await wakeIfStopped(sara.brickId)).toBe('up');
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(60);
      expect(after.stretchStarted!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }, 30_000);

    it('Opus on #1040, N3: a hand back long after the fence stopped the machine banks the stretch only to the moment the stop was sent, not to the hand back', async () => {
      const sara = await owner('handback-long-after-stop');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      // The stretch began 1000 s ago; our stop was sent 400 s ago; the person held the computer since, and hands it back now
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: new Date(Date.now() - 1_000_000), awakeProvedAt: null } });
      await prisma.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at", "done_at") VALUES (${randomUUID()}, ${sara.brickId}, ${sara.ref}, 'stop', (clock_timestamp() AT TIME ZONE 'UTC') - interval '400 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '400 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '399 seconds')`;
      // The sweep stopped the machine again on two later passes (it records an operation each time, the machine being down already): they say nothing of when it went down (Opus on #1040, N4)
      await prisma.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at", "done_at") SELECT ${randomUUID()}, ${sara.brickId}, ${sara.ref}, 'stop', (clock_timestamp() AT TIME ZONE 'UTC') - interval '200 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '200 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '199 seconds'`;
      await prisma.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at", "done_at") SELECT ${randomUUID()}, ${sara.brickId}, ${sara.ref}, 'stop', (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '29 seconds'`;
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      // 1000 s - 400 s = 600 s of the stretch ran before the stop (a second either way for the clocks), not the 1000 s a bank at the hand back would give
      expect(after.secondsRun).toBeGreaterThanOrEqual(598);
      expect(after.secondsRun).toBeLessThanOrEqual(603);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Sentry on #1040: a job banked while its machine was stopped starts its stretch again when ANOTHER start wakes the machine, not only the hand back that banked it', async () => {
      const sara = await owner('banked-woken-by-other');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      if (!a.ok) throw new Error('no job');
      // A return went pending: A is Brick's again, banked (no stretch, its awake proof kept), and the machine is stopped
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      // A different start (a read-only job) wakes the machine
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
      expect(b).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
      const aAfter = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(aAfter.secondsRun).toBe(100);
      expect(aAfter.stretchStarted).not.toBeNull();
      expect(aAfter.stretchStarted!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }, 30_000);

    it('Sentry on #1040: a turn asking for a machine that is already working again starts the stretch of a job banked while it was stopped', async () => {
      const sara = await owner('banked-found-working');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      expect((await machineOf(sara)).machine).toBe('working');
      expect(await wakeIfStopped(sara.brickId)).toBe('up');
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(100);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Opus on #1040, N4: a job running beside one the machine was lost under is banked to its last awake proof even when the sweep has stopped the machine again since (its retry is no proof of when it went down)', async () => {
      const sara = await owner('wake-banks-past-sweep-retry');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      const began = new Date(Date.now() - 600_000);
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: began, awakeProvedAt: new Date(began.getTime() + 60_000) } });
      // The sweep's retry on a `stopping` machine: an operation sent 30 s ago, long after the machine went down
      await prisma.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at", "done_at") SELECT ${randomUUID()}, ${sara.brickId}, ${sara.ref}, 'stop', (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds', (clock_timestamp() AT TIME ZONE 'UTC') - interval '29 seconds'`;
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      expect(await wakeIfStopped(sara.brickId)).toBe('up');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).secondsRun).toBe(60);
    }, 30_000);

    it('Opus on #1040, N5: a return whose machine is found waking (a wake of another path) does not start the banked stretches until the machine works', async () => {
      const sara = await owner('banked-not-on-waking');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      // The return went pending earlier and left the job banked; since then the machine was set waking by another path whose wake has lost its beat
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      setWakeTimingForTests({ beatMs: 100, staleMs: 400 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking' } });
      const seenAtWake: Array<Date | null> = [];
      const wake = fake.wake.bind(fake);
      fake.wake = async (ref: string) => {
        seenAtWake.push((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).stretchStarted);
        return wake(ref);
      };
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      // The machine was woken (the stale wake taken over) and the stretch was still paused while it was waking; it runs now that the machine works
      expect(seenAtWake).toEqual([null]);
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(100);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Opus and Sentry on #1040: a runner\'s turn start on a job banked while its machine was stopped, which another path has since woken, starts its stretch again and is admitted, instead of answering "starting" for good', async () => {
      const sara = await owner('turn-banked-working');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      expect((await machineOf(sara)).machine).toBe('working');
      const answer = await startTurn(a.job.id, 'carry on');
      expect(answer).not.toMatchObject({ ok: false, reason: 'starting' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(100);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Sentry on #1040: a machine that is still `working` with a stop of ours in flight does not restart the banked stretches (the stop lands on it); once nothing can land they start again', async () => {
      const sara = await owner('banked-working-stop-inflight');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      expect((await machineOf(sara)).machine).toBe('working');
      // A stop was sent and is recorded; the row does not say so yet
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      expect(await wakeIfStopped(sara.brickId, { ms: 300, dead: false })).toBe('pending');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).stretchStarted).toBeNull();
      await endPowerOp(op);
      expect(await wakeIfStopped(sara.brickId, { ms: 300, dead: false })).toBe('up');
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(100);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Sentry on #1040: a stop in flight that lands while the banked jobs wait leaves the machine stopped: it is looked at again and woken, and the stretches start once it works', async () => {
      const sara = await owner('banked-working-stop-lands');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      setTimeout(() => {
        void prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } }).then(() => endPowerOp(op));
      }, 150);
      const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
      expect(await wakeIfStopped(sara.brickId, { ms: 5_000, dead: false })).toBe('up');
      expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore + 1);
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } });
      expect(after.secondsRun).toBe(100);
      expect(after.stretchStarted).not.toBeNull();
    }, 30_000);

    it('Opus on #1040, N6: a machine that was not stopped and cannot be brought up for a banked job leaves the banked job banked, ends no job on the Brick and does not write over the row', async () => {
      const sara = await owner('banked-wake-fails-not-stopped');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      if (!a.ok) throw new Error('no job');
      // A is banked; a second job beside it is working with its own stretch; the machine rests and its wake fails
      const b = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'B', status: 'running', writes: false, startedAt: NOW, stretchStarted: new Date(Date.now() - 10_000) } });
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { stretchStarted: null, secondsRun: 100, awakeProvedAt: new Date(Date.now() - 100_000) } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      fake.wake = async () => {
        throw new Error('the wake failed');
      };
      expect(await wakeIfStopped(sara.brickId)).toBe('pending');
      const [aAfter, bAfter] = await Promise.all([a.job.id, b.id].map((id) => prisma.computerJob.findUniqueOrThrow({ where: { id } })));
      expect(aAfter).toMatchObject({ status: 'running', stretchStarted: null, secondsRun: 100 });
      expect(bAfter).toMatchObject({ status: 'running', endedAt: null });
      expect((await machineOf(sara)).machine).not.toBe('broken');
    }, 30_000);

    it('Opus on #1040, F3: a hand back whose transition was left by a dead leader and whose wake stays pending answers in progress at once; it does not resume again and again past the deadline', async () => {
      const sara = await owner('handback-resume-pending');
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 300, waitMs: 300, pollMs: 20 });
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      let release: () => void = () => undefined;
      const inFlight = underPowerOp(op, () => new Promise<void>((resolve) => (release = resolve)));
      // A hand back whose leader died after beginning it: the lease is gone, so the next request resumes it
      const row = await readControl(sara.brickId);
      expect(await beginTransition(sara.brickId, 'human_ready', row?.epoch ?? 0, 'returning')).not.toBeNull();
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      try {
        const began = Date.now();
        expect(await handBack(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'in_progress' });
        // One wait (about 0.6 s), not one wait after another until the 45 s deadline
        expect(Date.now() - began).toBeLessThan(5_000);
      } finally {
        release();
        await inFlight;
        await endPowerOp(op).catch(() => undefined);
      }
    }, 30_000);

    it('Opus on #1040, F2: a runner\'s turn start on a job that is Brick\'s and running on a stopped machine wakes it (waiting only for a live stop), answers "starting" while a stop can still land, and never answers no_machine for good', async () => {
      const sara = await owner('turn-wakes');
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 300, waitMs: 300, pollMs: 20 });
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      // A hand back left pending: the machine is stopped, the job is Brick's and running, a stop of ours can still land
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      let release: () => void = () => undefined;
      const inFlight = underPowerOp(op, () => new Promise<void>((resolve) => (release = resolve)));
      const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
      try {
        expect(await startTurn(a.job.id, 'carry on')).toEqual({ ok: false, reason: 'starting' });
        expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore);
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'running', control: 'brick' });
      } finally {
        release();
        await inFlight;
        await endPowerOp(op).catch(() => undefined);
      }
      // The stop is done: the runner asks again, the machine is woken, and the answer is no longer "no machine"
      const again = await startTurn(a.job.id, 'carry on');
      expect(again).not.toMatchObject({ ok: false, reason: 'no_machine' });
      expect(fake.calls.filter((call) => call.name === 'wake').length).toBeGreaterThan(wakesBefore);
      expect(await machineOf(sara)).toMatchObject({ machine: 'working' });
    }, 30_000);

    it('Sentry on #1040: a hand back that finds no control row to lead and cannot wake the machine yet (a stop of ours still open) answers in progress, never as done', async () => {
      const sara = await owner('handback-norow');
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 300, waitMs: 300, pollMs: 20 });
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
      if (!a.ok) throw new Error('no job');
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      let release: () => void = () => undefined;
      const inFlight = underPowerOp(op, () => new Promise<void>((resolve) => (release = resolve)));
      // The control row is read as missing (the path a hand back takes when it has no transition to lead)
      (readControl as jest.Mock).mockResolvedValueOnce(null);
      try {
        expect(await handBack(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'in_progress' });
        expect(await machineOf(sara)).toMatchObject({ machine: 'stopped' });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'running' });
      } finally {
        release();
        await inFlight;
        await endPowerOp(op).catch(() => undefined);
      }
    }, 30_000);

    it('a stop that threw may still land: its operation stays open (beating) for the provider\'s margin after the call returned, then closes by itself, and nothing waits for it', async () => {
      const sara = await owner('threw');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 1_500, waitMs: 8_000, pollMs: 20, marginMs: 700 });
      const stop = jest.spyOn(fake, 'stop').mockRejectedValue(new Error('the request timed out'));
      try {
        const began = Date.now();
        expect(await settleTurnHold(sara.brickId)).toBe(false);
        // The request path came back at once, with the operation still open and live
        expect(Date.now() - began).toBeLessThan(500);
        expect(await openPowerOpOf(prisma, sara.ref)).toMatchObject({ kind: 'stop', live: true });
        await until(async () => (await openPowerOpOf(prisma, sara.ref)) === null, 4_000);
        expect(Date.now() - began).toBeGreaterThanOrEqual(650);
      } finally {
        stop.mockRestore();
      }
    });

    it('a stop that returned is closed at once, as before', async () => {
      const sara = await owner('returned');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { turnUnprovenSince: NOW } });
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 1_500, waitMs: 8_000, pollMs: 20, marginMs: 5_000 });
      expect(await settleTurnHold(sara.brickId)).toBe(true);
      expect(await openPowerOpOf(prisma, sara.ref)).toBeNull();
    });

    it.each(['resting', 'broken'] as const)('a turn hold on a machine that is `%s` is stopped and lifted, never left to hold every start in line for ever', async (state) => {
      const sara = await owner(`hold-${state}`);
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: state, turnUnprovenSince: NOW } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      expect(await settleTurnHold(sara.brickId)).toBe(true);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore + 1);
      expect(await machineOf(sara)).toMatchObject({ machine: 'stopped', turnUnprovenSince: null });
    });

    it('a turn hold on a machine that is restoring (a park\'s wake has no job) is left alone: nothing is stopped under it', async () => {
      const sara = await owner('hold-restoring');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'restoring', turnUnprovenSince: NOW } });
      const stopsBefore = fake.calls.filter((call) => call.name === 'stop').length;
      expect(await settleTurnHold(sara.brickId)).toBe(false);
      expect(fake.calls.filter((call) => call.name === 'stop').length).toBe(stopsBefore);
      expect(await machineOf(sara)).toMatchObject({ machine: 'restoring' });
    });

    it('(b) a stop whose sender died counts as in flight for its bounded life: the replacement goes back in line holding nothing, and wakes only after that life', async () => {
      const sara = await owner('dead');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await fake.stop(sara.ref);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      // A sender recorded its stop and died: no beat, never done
      const recordedWall = Date.now();
      await recordPowerOp(sara.brickId, sara.ref, 'stop');
      await sleep(powerTiming().staleMs + 100);
      const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
      expect(started).toMatchObject({ ok: true, job: { status: 'queued', queuedFor: 'busy' } });
      const jobB = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'B' } });
      expect(jobB).toMatchObject({ status: 'queued', queuedFor: 'busy', reservationKey: null, stretchStarted: null, startedAt: null });
      expect(await prisma.meterReservation.count({ where: { jobId: jobB.id, state: 'held' } })).toBe(0);
      expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore);
      expect((await machineOf(sara)).machine).toBe('stopped');
      // Within the life, the sweep's try leaves it in line
      if (Date.now() - recordedWall < powerTiming().deadLifeMs - 300) {
        await sweepComputers(at(60));
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobB.id } })).status).toBe('queued');
        expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore);
      }
      // After it, the next try wakes the machine
      await sleep(Math.max(0, recordedWall + powerTiming().deadLifeMs + 200 - Date.now()));
      await sweepComputers(at(120));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobB.id } })).status).toBe('running');
      expect(fake.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore + 1);
      expect(await fake.awake(sara.ref)).toBe(true);
    });

    it('a live stop that outlasts the wait sends the replacement back in line holding nothing', async () => {
      setPowerTimingForTests({ beatMs: 50, staleMs: 600, deadLifeMs: 1_500, waitMs: 300, pollMs: 20 });
      const sara = await owner('rest');
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW)).toMatchObject({ ok: true });
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'done', endedAt: NOW } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
      // A live stop of ours (its sender beats) is open for longer than the start waits
      const op = await recordPowerOp(sara.brickId, sara.ref, 'stop');
      const beat = setInterval(() => void prisma.$executeRaw`UPDATE computer_power_ops SET beat_at = (NOW() AT TIME ZONE 'UTC') WHERE id = ${op}`, 50);
      try {
        expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW)).toMatchObject({ ok: true, job: { status: 'queued', queuedFor: 'busy' } });
      } finally {
        clearInterval(beat);
      }
      await endPowerOp(op);
      await sweepComputers(at(60));
      expect(await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'B' } })).toMatchObject({ status: 'running' });
    });
  });

  describe('layer 1: a sleep is a power operation too', () => {
    it('CodeRabbit on #1036 (found on #1040): a job that starts while the machine\'s sleep is held is woken ONCE, through the wake ticket: the finished sleep\'s own look at the holders sends no second, bare wake beside the start\'s', async () => {
      const sara = await owner('sleep-one-wake');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!started.ok) throw new Error('no job');
      const epochBefore = (await machineOf(sara)).wakeEpoch;
      const wakesBefore = fake.calls.filter((call) => call.name === 'wake').length;
      fake.holdRest = 1;
      const finishing = finishJob(started.job.id, 'done', at(30));
      await until(() => fake.held.length === 1);
      const b = startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, at(31));
      await sleep(400);
      fake.held.splice(0).forEach((release) => release());
      await finishing;
      expect(await b).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(fake.calls.filter((call) => call.name === 'wake').length - wakesBefore).toBe(1);
      expect(await machineOf(sara)).toMatchObject({ machine: 'working', wakeEpoch: epochBefore + 1 });
      expect(await fake.awake(sara.ref)).toBe(true);
    });

    it('a job ends and its machine’s sleep is held: a new job waits for the sleep to return before it wakes the machine, and ends on an awake machine', async () => {
      const sara = await owner('sleep');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!started.ok) throw new Error('no job');
      fake.holdRest = 1;
      const finishing = finishJob(started.job.id, 'done', at(30));
      await until(() => fake.held.length === 1);
      expect((await machineOf(sara)).machine).toBe('resting');
      const b = startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, at(31));
      await sleep(400);
      // The wake waits: the sleep of the job before can still land
      expect(fake.calls.filter((call) => call.name === 'wake')).toHaveLength(1);
      fake.held.splice(0).forEach((release) => release());
      await finishing;
      expect(await b).toMatchObject({ ok: true, job: { status: 'running' } });
      const order = fake.calls.map((call) => call.name).filter((name) => name === 'rest' || name === 'wake');
      expect(order.slice(0, 3)).toEqual(['wake', 'rest', 'wake']);
      expect(await fake.awake(sara.ref)).toBe(true);
      expect((await machineOf(sara)).machine).toBe('working');
    });
  });

  describe('layer 2: billing only on a machine proved awake', () => {
    async function workingJob(sara: Owner) {
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Work' }, NOW);
      if (!started.ok || started.job.status !== 'running') throw new Error(`no running job: ${JSON.stringify(started)}`);
      return prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } });
    }

    it('(c) a late stop lands after readiness: the next renewal finds the machine asleep, ends the stretch at the last proof, bills exactly the proved seconds and sends the job back in line', async () => {
      const sara = await owner('late');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      const room = job.reservationKey!;
      // A renewal proves the machine awake 120 s into the stretch
      const proof = new Date(began + 120_000);
      expect(await renewJob(job.id, proof)).toMatchObject({ ok: true });
      // The late stop lands: the provider says asleep, Orbit still says working
      await fake.stop(sara.ref);
      expect((await machineOf(sara)).machine).toBe('working');
      // The next renewal, 300 s further on, finds it
      const found = new Date(began + 420_000);
      expect(await renewJob(job.id, found)).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1, secondsRun: 0, stretchStarted: null, reservationKey: null, secondsBilled: 120, pausedWhy: null });
      const pause = await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } });
      expect(pause).toMatchObject({ why: 'machine', seconds: 120, roomKey: room });
      // The room is settled at the proved seconds' price, the rest given back in the same commit, and the books carry exactly that
      const price = costOfSeconds(120, fake.microsPerMinute())!;
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
      const booked = await prisma.meterEvent.findFirst({ where: { eventId: `computer:${job.id}:time:1` } });
      expect(booked).toMatchObject({ quantity: BigInt(120), unit: 'second', costMicros: BigInt(price) });
      // The machine is not used until a recorded stop proves it asleep; then the job carries on by itself, on a machine woken under the fence
      expect((await machineOf(sara)).machine).toBe('stopping');
      await sweepComputers(new Date(began + 480_000));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'running' });
      expect(await fake.awake(sara.ref)).toBe(true);
      expect((await machineOf(sara)).machine).toBe('working');
    });

    it('a hand-over that carried the stretch past the proof gives that time back: only the proved seconds are priced', async () => {
      const sara = await owner('handover');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      expect(await renewJob(job.id, new Date(began + 60_000))).toMatchObject({ ok: true });
      await fake.stop(sara.ref);
      // A hand-over after the stop landed counts the stretch on into seconds_run (180 s), and moves the stretch start
      expect(await requestHandover(job.id, 'answer', new Date(began + 180_000))).not.toBeNull();
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'waiting', secondsRun: 180 });
      expect(await renewJob(job.id, new Date(began + 300_000))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'queued', secondsBilled: 60 });
      expect(await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } })).toMatchObject({ why: 'machine', seconds: 60 });
    });

    it('a look that does not answer extends the room but proves nothing: a machine then found asleep is billed only to the proof before', async () => {
      const sara = await owner('unknown');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      expect(await renewJob(job.id, new Date(began + 30_000))).toMatchObject({ ok: true });
      const look = jest.spyOn(fake, 'awake').mockRejectedValueOnce(new Error('the provider did not answer'));
      expect(await renewJob(job.id, new Date(began + 90_000))).toMatchObject({ ok: true });
      look.mockRestore();
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).awakeProvedAt).toEqual(new Date(began + 30_000));
      await fake.stop(sara.ref);
      expect(await renewJob(job.id, new Date(began + 150_000))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'queued', secondsBilled: 30 });
    });

    it('Opus fix 1: the person takes the screen while the machine is being read, and it reads asleep: their take-over stands, the renewal goes on as usual and proves nothing', async () => {
      const sara = await owner('takeover');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      expect(await renewJob(job.id, new Date(began + 30_000))).toMatchObject({ ok: true });
      await fake.stop(sara.ref);
      const look = jest.spyOn(fake, 'awake').mockImplementationOnce(async () => {
        // The take-over lands between the look and the pause
        await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'waiting', control: 'person', leaseVersion: { increment: 1 } } });
        return false;
      });
      try {
        expect(await renewJob(job.id, new Date(began + 90_000))).toMatchObject({ ok: true });
      } finally {
        look.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'waiting', control: 'person', pauses: 0, awakeProvedAt: new Date(began + 30_000) });
      expect(await prisma.computerJobPause.count({ where: { jobId: job.id } })).toBe(0);
    });

    it('CodeRabbit on #1040: the person takes the machine and hands it back while it is being read, and the look said asleep: the old look pauses nothing, and the renewal goes on under the current state', async () => {
      const sara = await owner('handed-back');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      expect(await renewJob(job.id, new Date(began + 30_000))).toMatchObject({ ok: true });
      await fake.stop(sara.ref);
      const look = jest.spyOn(fake, 'awake').mockImplementationOnce(async () => {
        // Between the look and the pause the person took the screen and handed it back (both move the control generation); the job is Brick's and running again
        await prisma.computerJob.update({ where: { id: job.id }, data: { controlGeneration: { increment: 2 }, leaseVersion: { increment: 2 } } });
        return false;
      });
      try {
        expect(await renewJob(job.id, new Date(began + 90_000))).toMatchObject({ ok: true });
      } finally {
        look.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'running', control: 'brick', pauses: 0, awakeProvedAt: new Date(began + 30_000) });
      expect(await prisma.computerJobPause.count({ where: { jobId: job.id } })).toBe(0);
    });

    it('Opus fix 2: a look that never answers is given up within a few seconds, well inside the runner’s 8 s, and proves nothing', async () => {
      const sara = await owner('silent');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      const look = jest.spyOn(fake, 'awake').mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      const asked = Date.now();
      try {
        expect(await renewJob(job.id, new Date(began + 60_000))).toMatchObject({ ok: true });
      } finally {
        look.mockRestore();
      }
      expect(Date.now() - asked).toBeLessThan(5_000);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'running', awakeProvedAt: null });
    });

    describe('only the proved seconds are priced, at the rate as of the proof', () => {
      /** A lease whose price rose after the proof: the rate doubles 180 s into the lease (the proof is 120 s in). */
      async function priceRises(room: string) {
        const lease = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room }, select: { terms: true } });
        const first = (lease.terms as Array<{ at: number; micros: number; stretchMs: number }>)[0];
        await prisma.meterReservation.update({ where: { reservationKey: room }, data: { terms: [first, { at: first.at + 180_000, micros: first.micros * 2, stretchMs: first.stretchMs }] } });
        return costOfSeconds(120, (first.micros * 60_000) / first.stretchMs)!;
      }

      it('a machine found asleep at a renewal: the room is settled and the books are written at the rate before the rise, however late it was found', async () => {
        const sara = await owner('priced-pause');
        const job = await workingJob(sara);
        const began = job.stretchStarted!.getTime();
        expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
        const price = await priceRises(job.reservationKey!);
        await fake.stop(sara.ref);
        expect(await renewJob(job.id, new Date(began + 360_000))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey! } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findFirst({ where: { eventId: `computer:${job.id}:time:1` } })).toMatchObject({ quantity: BigInt(120), costMicros: BigInt(price) });
        expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } })).pricedUntil).toEqual(new Date(began + 120_000));
      });

      it('the same after a hand-over carried seconds into seconds_run: the proof is where the stretch began plus the proved seconds, not where this stretch started', async () => {
        const sara = await owner('priced-handover');
        const job = await workingJob(sara);
        const began = job.stretchStarted!.getTime();
        expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
        expect(await requestHandover(job.id, 'answer', new Date(began + 150_000))).not.toBeNull();
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ secondsRun: 150 });
        const price = await priceRises(job.reservationKey!);
        await fake.stop(sara.ref);
        expect(await renewJob(job.id, new Date(began + 360_000))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey! } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findFirst({ where: { eventId: `computer:${job.id}:time:1` } })).toMatchObject({ quantity: BigInt(120), costMicros: BigInt(price) });
        expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: job.id, n: 1 } } })).pricedUntil).toEqual(new Date(began + 120_000));
      });

      it('an unanswered ending found asleep: the room, the books and the sweep that writes a missing line all price 120 s at the rate before the rise', async () => {
        const sara = await owner('priced-ending');
        const job = await workingJob(sara);
        const began = job.stretchStarted!.getTime();
        expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
        expect(await requestHandover(job.id, 'details', new Date(began + 180_000))).not.toBeNull();
        const price = await priceRises(job.reservationKey!);
        await fake.stop(sara.ref);
        const endAt = new Date(began + 180_000 + 61 * 60_000);
        await sweepComputers(endAt);
        const ended = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'unanswered', secondsRun: 120, pricedUntil: new Date(began + 120_000) });
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey! } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findFirst({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toMatchObject({ quantity: BigInt(120), costMicros: BigInt(price) });
        // The line never got written: the sweep writes it from the job, at the same price
        await prisma.meterEvent.deleteMany({ where: { eventId: { startsWith: `computer:${job.id}:time` } } });
        await sweepComputers(new Date(endAt.getTime() + 30 * 60_000));
        expect(await prisma.meterEvent.findFirst({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toMatchObject({ quantity: BigInt(120), costMicros: BigInt(price) });
      });

      it('an unanswered ending found asleep whose room was never settled: the sweep that closes the lapsed room settles it at 120 s at the rate before the rise, as the books are', async () => {
        const sara = await owner('priced-lapsed');
        const job = await workingJob(sara);
        const began = job.stretchStarted!.getTime();
        expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
        expect(await requestHandover(job.id, 'details', new Date(began + 180_000))).not.toBeNull();
        const price = await priceRises(job.reservationKey!);
        await fake.stop(sara.ref);
        const endAt = new Date(began + 180_000 + 61 * 60_000);
        await sweepComputers(endAt);
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'stopped', endedBy: 'unanswered', secondsRun: 120, pricedUntil: new Date(began + 120_000) });
        // The ending's settlement did not get through: the room is still held and lapses; the books line is missing too
        await prisma.meterReservation.update({ where: { reservationKey: job.reservationKey! }, data: { state: 'held', settledMicros: null, closedAt: null, expiresAt: new Date(endAt.getTime() - 60_000) } });
        await prisma.meterEvent.deleteMany({ where: { eventId: { startsWith: `computer:${job.id}:time` } } });
        await sweepComputers(new Date(endAt.getTime() + 30 * 60_000));
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey! } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findFirst({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toMatchObject({ quantity: BigInt(120), costMicros: BigInt(price) });
      });
    });

    describe('an unanswered ending reads the machine too', () => {
      // A job that asked its person for details and was not answered: the hand-over (180 s in) counts the stretch on into seconds_run; the machine was proved awake 120 s in, then a late stop put it to sleep
      async function waitingJob(sara: Owner) {
        const job = await workingJob(sara);
        const began = job.stretchStarted!.getTime();
        expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
        expect(await requestHandover(job.id, 'details', new Date(began + 180_000))).not.toBeNull();
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'waiting', control: 'brick', secondsRun: 180 });
        return { job, began };
      }
      const wait = 61 * 60_000;

      it('(d) the machine went to sleep after its last proof and nobody renewed since: the sweep ends the job as unanswered and prices only the proved seconds', async () => {
        const sara = await owner('unanswered-asleep');
        const { job, began } = await waitingJob(sara);
        await fake.stop(sara.ref);
        expect((await machineOf(sara)).machine).toBe('working');
        const room = (await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).reservationKey!;
        await sweepComputers(new Date(began + 180_000 + wait));
        const ended = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'unanswered', secondsRun: 120 });
        const price = costOfSeconds(120, fake.microsPerMinute())!;
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findFirst({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toMatchObject({ quantity: BigInt(120), unit: 'second', costMicros: BigInt(price) });
      });

      it('a machine still awake at the ending is priced to the ending, as before', async () => {
        const sara = await owner('unanswered-awake');
        const { job, began } = await waitingJob(sara);
        await sweepComputers(new Date(began + 180_000 + wait));
        const ended = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
        expect(ended.secondsRun).toBeGreaterThanOrEqual(180 + 60 * 60);
      });

      it('second GPT audit, O3 (Opus): a look that does not answer is priced like an asleep one, to the last proof (120 s), the job still ends, and a retry sweep settles it exactly once', async () => {
        const sara = await owner('unanswered-silent');
        const { job, began } = await waitingJob(sara);
        await fake.stop(sara.ref);
        const room = (await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).reservationKey!;
        const look = jest.spyOn(fake, 'awake').mockRejectedValue(new Error('the provider did not answer'));
        const endAt = new Date(began + 180_000 + wait);
        try {
          await sweepComputers(endAt);
        } finally {
          look.mockRestore();
        }
        const ended = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'unanswered', secondsRun: 120, pricedUntil: new Date(began + 120_000) });
        const price = costOfSeconds(120, fake.microsPerMinute())!;
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.findMany({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toEqual([expect.objectContaining({ quantity: BigInt(120), costMicros: BigInt(price) })]);
        // A retry sweep (the provider answers now, the machine is asleep): the same one settlement, nothing is priced again
        await sweepComputers(new Date(endAt.getTime() + 30 * 60_000));
        await sweepComputers(new Date(endAt.getTime() + 60 * 60_000));
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ secondsRun: 120, pricedUntil: new Date(began + 120_000) });
        expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: room } })).toMatchObject({ state: 'settled', settledMicros: BigInt(price) });
        expect(await prisma.meterEvent.count({ where: { eventId: { startsWith: `computer:${job.id}:time` } } })).toBe(1);
      });
    });

    it('a machine proved awake renews as before, and nothing is paused', async () => {
      const sara = await owner('awake');
      const job = await workingJob(sara);
      const began = job.stretchStarted!.getTime();
      expect(await renewJob(job.id, new Date(began + 60_000))).toMatchObject({ ok: true });
      expect(await renewJob(job.id, new Date(began + 120_000))).toMatchObject({ ok: true });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'running', pauses: 0, awakeProvedAt: new Date(began + 120_000) });
      expect(await prisma.computerJobPause.count({ where: { jobId: job.id } })).toBe(0);
    });
  });
});
