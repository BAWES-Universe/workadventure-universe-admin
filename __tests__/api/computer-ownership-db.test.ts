/**
 * ONE owner per computer job (GPT round 5, E3-E6 and S2): every write that extends, ends, cancels, hands over or sweeps a job is decided in the write that lands it, for the worker that still owns the job, and a start exists
 * durably before its job. Each case is written with its CONTROL (the genuine one still works). Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-ownership-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
// The two seams a test needs between a read and the write that follows it are module functions: wrapped here (the real one by default) so a test can hold one for a moment
jest.mock('@/lib/meter-allowance', () => {
  const actual = jest.requireActual('@/lib/meter-allowance');
  return { ...actual, reserveRoom: jest.fn((...args: unknown[]) => actual.reserveRoom(...args)) };
});
jest.mock('@/lib/computer-calls', () => {
  const actual = jest.requireActual('@/lib/computer-calls');
  return { ...actual, endIfCutoffDecided: jest.fn((...args: unknown[]) => actual.endIfCutoffDecided(...args)) };
});
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { ackStart, beatJob, claimJob, completeFinishIntents, finishJobUnder, giveComputer, handBack, planEffect, recordFinishIntent, releaseJob, renewJob, reportProgressAs, requestHandoverAs, settleEffect, settleEffectAs, startJob, startedJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { cancelJobTurn, prepareJob, reattachJobTurn, startTurn } from '@/lib/computer-broker';
import { Agent37Error } from '@/lib/agent37/client';
import * as calls from '@/lib/computer-calls';
import { mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { authorizeModelCall, cutoffEndsFinished, cutoffLockKey, callRoomKey } from '@/lib/computer-calls';
import { hasPoolCutoff, recordPoolCutoff } from '@/lib/computer-faults';
import * as meter from '@/lib/meter-allowance';

const actualMeter = jest.requireActual<typeof meter>('@/lib/meter-allowance');
const actualCalls = jest.requireActual<typeof calls>('@/lib/computer-calls');
const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
const RELAY = 'https://bot-server.example.test';

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
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

/** A person with a Brick that has a job running on the pretend machine. */
async function running(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const decisionOf = (jobId: string) => prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
const roomOf = async (jobId: string) => (await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: (await jobOf(jobId)).reservationKey! } })).amountMicros;
const heldCalls = (jobId: string) => prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') }, state: 'held' } });
const liveKeys = (jobId: string) => prisma.computerJobToken.count({ where: { jobId, revokedAt: null } });

/** A runner takes up the job as the game does: GET for the epoch it saw, then claim with it. Answers the epoch it owns by. */
/**
 * A runner takes the job up. A job that already has an owner is claimed only once that owner stopped beating (GPT round 6, finding 3: a claim never takes a job from a HEALTHY owner), which is
 * what every "a worker was replaced" case here stands for: the first worker died. The hold is let go first, as it runs out by itself 90 s after the owner's last beat.
 */
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  await prisma.computerJob.updateMany({ where: { id: jobId, NOT: { ownerLeaseUntil: null } }, data: { ownerLeaseUntil: null } });
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};
/**
 * B takes the job over because A stopped beating: its hold lapsed (90 s with no beat), which is what every "A's request was in flight when B claimed" case below stands for. A claim never takes a
 * job from a healthy owner (GPT round 6, finding 3), so the hold is let go first, exactly as time would.
 */
const takeOverClaim = async (jobId: string, run: string, seen: number, at: Date) => {
  await prisma.computerJob.updateMany({ where: { id: jobId, NOT: { ownerLeaseUntil: null } }, data: { ownerLeaseUntil: null } });
  return claimJob(jobId, { run, seen }, at);
};
const keyFor = async (jobId: string, epoch: number, at: Date = NOW) => ((await mintJobToken(jobId, 'model', at, { generation: 0 }, { epoch })) as { ok: true; token: string }).token;
const ask = (token: string, callId: string, over: Partial<Parameters<typeof authorizeModelCall>[0]> = {}, at: Date = NOW) => authorizeModelCall({ token, callId, estimateMicros: 5_000, payer: 'universe', turn: 1, run: 'rA', ...over }, at);

run('one owner per computer job: every write is decided in the write that lands it (GPT round 5), in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  let fake: FakeComputerProvider;
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await setUp();
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

  const waiters = async (key: string): Promise<number> => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
  /** Whether the advisory lock can be taken right now by a transaction of its own that does not wait (a held lock is `false`, whoever waits or not). */
  const lockIsFree = async (key: string): Promise<boolean> =>
    prisma.$transaction(async (tx) => (await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`)[0].ok);
  /** Whether at least `n` requests wait for the advisory lock. Given the request that is meant to be one of them, its failure ends the wait with its own error (CodeRabbit on #1025, C8). */
  const waitForWaiters = async (key: string, n: number, request?: Promise<unknown>): Promise<boolean> => {
    const outcome: { failed: boolean; error?: unknown } = { failed: false };
    request?.then(undefined, (error) => {
      outcome.failed = true;
      outcome.error = error;
    });
    for (let tries = 0; tries < 250; tries += 1) {
      if (outcome.failed) throw outcome.error;
      if ((await waiters(key)) >= n) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  /** The job's row held (`FOR UPDATE`) by a transaction that then does `work` and commits when released: another request that needs the row waits for it. */
  const holdRow = (jobId: string, work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown> = async () => undefined) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    let failed: (error: unknown) => void = () => undefined;
    const lockTaken = new Promise<void>((resolve, reject) => {
      locked = resolve;
      failed = reject;
    });
    // The fixture's own backend: a waiter is only the one blocked BY it (CodeRabbit on #1025, 45)
    let pid = 0;
    const done = prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "computer_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
          pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
          locked();
          await released;
          await work(tx);
        },
        { timeout: 30_000 },
      )
      .catch((error) => {
        failed(error);
        throw error;
      });
    return { locked: lockTaken, release, done, pid: () => pid };
  };
  /**
   * Whether a request is waiting for the row the fixture holds: a backend that the fixture's own backend blocks (never any waiter of the server).
   * Given the request, its outcome is watched from the moment of asking: a request that fails ends the wait with its own error, and one that already answered is not waiting (CodeRabbit on #1025, C8).
   */
  const waitForRowWaiter = async (holder: { pid: () => number }, request?: Promise<unknown>): Promise<boolean> => {
    const outcome: { failed: boolean; error?: unknown; answered: boolean } = { failed: false, answered: false };
    request?.then(
      () => {
        outcome.answered = true;
      },
      (error) => {
        outcome.failed = true;
        outcome.error = error;
      },
    );
    for (let tries = 0; tries < 250; tries += 1) {
      if (outcome.failed) throw outcome.error;
      if (outcome.answered) return false;
      const pid = holder.pid();
      if (pid > 0 && (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0].n >= 1) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  /** The job's cutoff lock held by a transaction, as another request would hold it while it decides. */
  const holdCutoff = (jobId: string, work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
        locked();
        await released;
        await work(tx);
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
    const ready = Promise.race([
      lockTaken,
      done.then(() => {
        throw new Error('the fixture transaction ended without holding the lock');
      }),
    ]);
    return { ready, release, done };
  };
  /** B claims while A's request waits behind the lock: the claim queues FIRST, then A's request, so B owns the job by the time A's request is decided (A's request was in flight when B claimed). */
  const claimBefore = async <T>(jobId: string, fromEpoch: number, request: () => Promise<T>): Promise<{ answer: T; epoch: number }> => {
    const holder = holdCutoff(jobId, async () => undefined);
    let claim: ReturnType<typeof claimJob> = Promise.resolve({ ok: false, reason: 'not_found' } as never);
    let asked: Promise<T> = Promise.resolve(undefined as T);
    try {
      await holder.ready;
      claim = takeOverClaim(jobId, 'rB', fromEpoch, minutes(1));
      expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
      asked = request();
      expect(await waitForWaiters(cutoffLockKey(jobId), 2)).toBe(true);
      holder.release();
      await holder.done;
      const won = await claim;
      if (!won.ok) throw new Error(`B's claim was refused: ${won.reason}`);
      return { answer: await asked, epoch: won.epoch };
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, claim, asked]);
    }
  };

  describe('E3: a renewal is decided in one transaction for the worker that still owns the job', () => {
    it('A’s renewal that was in flight when B claimed and admitted 5,000 adds ZERO room and writes no ending, even when the allowance is used up and even when the pool declines it; B’s key, room and job are intact', async () => {
      for (const limit of ['none', 'allowance', 'pool'] as const) {
        const { jobId } = await running(`s-e3-${limit}`);
        const ea = await claimed(jobId, 'rA');
        // The state of the world when A's request reaches Orbit: nothing yet says A is not the owner
        const before = await roomOf(jobId);
        if (limit === 'allowance') await setUp({ memberAllowanceMicros: 1_000 });
        if (limit === 'pool') await setUp({ poolCeilingMicros: 1 });
        const { answer: renewal, epoch: eb } = await claimBefore(jobId, ea, () => renewJob(jobId, minutes(2), { epoch: ea }));
        await setUp();
        const b = await keyFor(jobId, eb, minutes(2));
        expect(await ask(b, 'c2', { run: 'rB' }, minutes(2))).toMatchObject({ ok: true, reservedMicros: 5_000 });
        expect(renewal).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
        expect(await roomOf(jobId)).toEqual(before);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, endedAt: null });
        expect((await verifyJobToken(b, 'model', minutes(3))).ok).toBe(true);
        expect(await heldCalls(jobId)).toBe(1);
      }
    });

    it('CONTROL: the OWNER’s renewal at a real limit still decides the job (allowance pauses it, the pool ends it), as the limit says', async () => {
      const own = await running('s-e3-ctl-a');
      const ea = await claimed(own.jobId, 'rA');
      await setUp({ memberAllowanceMicros: 1_000 });
      // The month ran out: the job pauses and waits (piece 3 of the controls), moving the owner, never ending
      expect(await renewJob(own.jobId, minutes(2), { epoch: ea })).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      expect(await jobOf(own.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, ownerEpoch: ea + 1 });
      await setUp();
      const pool = await running('s-e3-ctl-p');
      const ep = await claimed(pool.jobId, 'rA');
      await setUp({ poolCeilingMicros: 1 });
      expect(await renewJob(pool.jobId, minutes(2), { epoch: ep })).toEqual({ ok: false, reason: 'pool' });
      expect(await jobOf(pool.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
    });

    it('a rule the person said: A’s delayed renewal never decides B’s job as `rule`; the owner’s renewal still does (it pauses the job)', async () => {
      const { sara, jobId } = await running('s-e3-rule');
      const ea = await claimed(jobId, 'rA');
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(10), words: 'Never more than ten millionths a day', createdById: sara.id } });
      const { answer } = await claimBefore(jobId, ea, () => renewJob(jobId, minutes(2), { epoch: ea }));
      expect(answer).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, endNote: null });
      const eb = (await jobOf(jobId)).ownerEpoch;
      // The owner's renewal at the rule pauses the job (it waits for the person to raise their limit), never ends it
      expect(await renewJob(jobId, minutes(3), { epoch: eb })).toEqual({ ok: false, reason: 'paused', why: 'rule' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule', endedBy: null, ownerEpoch: eb + 1 });
    });
  });

  describe('E3: a refused CALL ends the job only as the owner it was made for', () => {
    /** The call of A passes its key, is refused for the allowance (the pool's room is fine), and B claims between the refusal and the ending the refusal asks for. */
    const refusedAfterClaim = async (jobId: string, token: string, ea: number, over: Partial<Parameters<typeof authorizeModelCall>[0]>) => {
      const real = actualMeter.reserveRoom;
      const spy = jest.mocked(meter.reserveRoom).mockImplementationOnce((async (...args: Parameters<typeof real>) => {
        const room = await real(...args);
        const won = await takeOverClaim(jobId, 'rB', ea, minutes(1));
        if (!won.ok) throw new Error(`B's claim was refused: ${won.reason}`);
        return room;
      }) as never);
      try {
        return await ask(token, 'c-big', over);
      } finally {
        spy.mockClear();
      }
    };

    it('A’s delayed expensive call is refused for the allowance after B claimed: only that call is refused, B’s job runs on (key, room and state intact)', async () => {
      const { jobId } = await running('s-e3-call-allow');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      const before = await roomOf(jobId);
      expect(await refusedAfterClaim(jobId, a, ea, { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, ownerEpoch: ea + 1 });
      expect(await roomOf(jobId)).toEqual(before);
      // B runs on: its own call is admitted
      const b = await keyFor(jobId, ea + 1, minutes(2));
      expect(await ask(b, 'c2', { run: 'rB' }, minutes(2))).toMatchObject({ ok: true });
    });

    it('the same for a spend rule: A’s delayed call refused by the rule after B claimed ends nothing; B’s job runs on', async () => {
      const { sara, jobId } = await running('s-e3-call-rule');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(100), words: 'Never more than a hundred millionths a day', createdById: sara.id } });
      expect(await refusedAfterClaim(jobId, a, ea, { estimateMicros: 5_000_000 })).toMatchObject({ ok: false, reason: 'rule' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('CONTROL: a genuine limit on the OWNER’s own call still decides the job (allowance, and a rule): it pauses, as theirs', async () => {
      const own = await running('s-e3-call-ctl');
      const eo = await claimed(own.jobId, 'rA');
      const k = await keyFor(own.jobId, eo);
      expect(await ask(k, 'c-big', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(own.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, ownerEpoch: eo + 1 });
      const ruled = await running('s-e3-call-ctl-rule');
      const er = await claimed(ruled.jobId, 'rA');
      const kr = await keyFor(ruled.jobId, er);
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: ruled.sara.id, scope: 'bot', botId: ruled.sara.brickId, period: 'day', capMicros: BigInt(100), words: 'Never more than a hundred millionths a day', createdById: ruled.sara.id } });
      expect(await ask(kr, 'c-big', { estimateMicros: 5_000_000 })).toMatchObject({ ok: false, reason: 'rule' });
      expect(await jobOf(ruled.jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'rule', endedBy: null, ownerEpoch: er + 1 });
    });

    it('a call whose key ended (revoked) before its refusal reached the ending decides nothing about the job, even for the same owner; two refusals of a worker that no longer owns the job never decide a pool cutoff', async () => {
      const { jobId } = await running('s-e3-call-key');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      const real = actualMeter.reserveRoom;
      const spy = jest.mocked(meter.reserveRoom).mockImplementationOnce((async (...args: Parameters<typeof real>) => {
        const room = await real(...args);
        await prisma.computerJobToken.updateMany({ where: { jobId }, data: { revokedAt: new Date() } });
        return room;
      }) as never);
      try {
        expect(await ask(a, 'c-big', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        spy.mockClear();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      // The pool declines a worker that is not the owner twice: the job is not decided about (no cutoff, no refusal counted)
      const other = await running('s-e3-call-pool');
      const eb = await claimed(other.jobId, 'rA');
      const kb = await keyFor(other.jobId, eb);
      await prisma.computerJobToken.updateMany({ where: { jobId: other.jobId }, data: { ownerEpoch: eb - 1 } });
      await setUp({ poolCeilingMicros: 1 });
      expect(await ask(kb, 'c1', { estimateMicros: 1_000 })).toEqual({ ok: false, reason: 'refused' });
      await setUp();
    });
  });

  describe('E4: a hand-over and a cancel are the owner’s, for the turn they name', () => {
    it('an old worker’s hand-over after B claimed is superseded: the job stays running and B’s turn is untouched; CONTROL: the owner’s hand-over goes through, with its lease version moved', async () => {
      const { jobId } = await running('s-e4-hand');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-B' } });
      const late = await requestHandoverAs(jobId, 'details', minutes(2), null, { epoch: ea, generation: 0, responseId: 'resp-B' });
      expect(late.refused).toBe('superseded');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', waitingFor: null, agentResponseId: 'resp-B', handoverSeq: 0 });
      // A worker that names none is no owner of a claimed job either
      expect((await requestHandoverAs(jobId, 'details', minutes(2), null, {})).refused).toBe('superseded');
      const before = (await jobOf(jobId)).leaseVersion;
      const mine = await requestHandoverAs(jobId, 'details', minutes(3), null, { epoch: eb, generation: 0, responseId: 'resp-B' });
      expect(mine.refused).toBeNull();
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', waitingFor: 'details', handoverSeq: 1 });
      expect((await jobOf(jobId)).leaseVersion).toBe(before + 1);
    });

    it('a hand-over of the owner for a turn that is not the job’s (`not_current`), for an older control generation (`stale`) or while an ending is decided (a kept intent, a pool cutoff) writes nothing; the waiting branch is fenced the same way', async () => {
      const { jobId } = await running('s-e4-hand-2');
      const ea = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
      expect((await requestHandoverAs(jobId, 'details', minutes(1), null, { epoch: ea, generation: 0, responseId: 'resp-OLD' })).refused).toBe('not_current');
      expect((await requestHandoverAs(jobId, 'details', minutes(1), null, { epoch: ea, generation: 3, responseId: 'resp-1' })).refused).toBe('stale');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', waitingFor: null });
      expect((await requestHandoverAs(jobId, 'details', minutes(1), null, { epoch: ea, generation: 0, responseId: 'resp-1' })).refused).toBeNull();
      // Waiting: another worker's change of what it waits for is refused; the owner's lands
      const eb = await claimed(jobId, 'rB', minutes(2));
      expect((await requestHandoverAs(jobId, 'signin', minutes(3), null, { epoch: ea, generation: 0 })).refused).toBe('superseded');
      expect((await jobOf(jobId)).waitingFor).toBe('details');
      expect((await requestHandoverAs(jobId, 'signin', minutes(3), null, { epoch: eb, generation: 0 })).refused).toBeNull();
      expect((await jobOf(jobId)).waitingFor).toBe('signin');
      // An ending decided (the finalizer owns it): the hand-over writes nothing
      const ending = await running('s-e4-hand-end');
      const ee = await claimed(ending.jobId, 'rA');
      await recordFinishIntent(ending.jobId, { outcome: 'done', epoch: ee }, minutes(1));
      await requestHandoverAs(ending.jobId, 'details', minutes(2), null, { epoch: ee, generation: 0 });
      expect(await jobOf(ending.jobId)).toMatchObject({ status: 'running', waitingFor: null });
      const cut = await running('s-e4-hand-cut');
      const ec = await claimed(cut.jobId, 'rA');
      await recordPoolCutoff(prisma, cut.jobId, minutes(1));
      await requestHandoverAs(cut.jobId, 'details', minutes(2), null, { epoch: ec, generation: 0 });
      expect(await jobOf(cut.jobId)).toMatchObject({ status: 'running', waitingFor: null });
    });

    it('an old worker’s cancel never cancels B’s response: superseded, nothing cancelled; a cancel that names another turn is `not_current`; CONTROL: the owner’s cancel of the turn it names is made, once, for that response only', async () => {
      const { jobId } = await running('s-e4-cancel');
      const ea = await claimed(jobId, 'rA');
      // The machine must exist for a cancel: the running job holds it
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-A' } });
      const eb = await claimed(jobId, 'rB', minutes(1));
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-B' } });
      expect(await cancelJobTurn(jobId, { epoch: ea, responseId: 'resp-A' })).toEqual({ ok: false, reason: 'superseded' });
      expect(await cancelJobTurn(jobId, { epoch: ea, responseId: 'resp-B' })).toEqual({ ok: false, reason: 'superseded' });
      expect(await cancelJobTurn(jobId, { epoch: undefined })).toEqual({ ok: false, reason: 'superseded' });
      expect(fake.cancelledTurns).toEqual([]);
      expect(await cancelJobTurn(jobId, { epoch: eb, responseId: 'resp-A' })).toEqual({ ok: true, cancelled: false, reason: 'not_current' });
      expect(await cancelJobTurn(jobId, { epoch: eb })).toEqual({ ok: true, cancelled: false, reason: 'not_current' });
      expect(fake.cancelledTurns).toEqual([]);
      expect(await cancelJobTurn(jobId, { epoch: eb, responseId: 'resp-B' })).toEqual({ ok: true, cancelled: true });
      expect(fake.cancelledTurns).toEqual(['resp-B']);
    });

    it('MIXED VERSIONS: a legacy job (no owner) lets a legacy runner cancel the job’s current turn and hand over without an epoch, as before', async () => {
      const { jobId } = await running('s-e4-legacy');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-L' } });
      expect(await cancelJobTurn(jobId)).toEqual({ ok: true, cancelled: true });
      expect(fake.cancelledTurns).toEqual(['resp-L']);
      expect((await requestHandoverAs(jobId, 'details', minutes(1), null, {})).refused).toBeNull();
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', waitingFor: 'details' });
    });

    it('progress is the owner’s: an old worker’s step never overwrites B’s; the owner’s lands', async () => {
      const { jobId } = await running('s-e4-progress');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect((await reportProgressAs(jobId, { stepDone: 2, stepTotal: 5, label: 'B’s step' }, { epoch: eb })).applied).toBe(true);
      const late = await reportProgressAs(jobId, { stepDone: 9, stepTotal: 9, label: 'A’s old step' }, { epoch: ea });
      expect(late).toMatchObject({ applied: false, superseded: true });
      expect(await jobOf(jobId)).toMatchObject({ stepDone: 2, stepTotal: 5, stepLabel: 'B’s step' });
    });
  });

  describe('Rule C: a provider call comes only after the conditional terminal write, for the response the write read', () => {
    it('a finish cancels the turn AFTER the job is over (never under the job’s lock), and cancels the response the write read; a finish that loses (superseded) cancels nothing', async () => {
      const { jobId } = await running('s-c-order');
      const ea = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
      // The first look at the job has read resp-1; the response changes while the finish waits for the lock: the write finds another response, reads again and cancels THAT one
      const statusAtCancel: string[] = [];
      const lockFreeAtCancel: boolean[] = [];
      const real = fake.cancelTurn.bind(fake);
      const spy = jest.spyOn(fake, 'cancelTurn').mockImplementation(async (ref: string, responseId: string) => {
        statusAtCancel.push((await jobOf(jobId)).status);
        // The cutoff lock is FREE at this seam (a separate transaction takes it without waiting), not merely unwanted: a cancel made under the lock would hold it.
        // Recorded and asserted after the finish: the production call swallows an error thrown here (a cancel is best effort), so an `expect` in this seam could never fail the test by itself
        lockFreeAtCancel.push(await lockIsFree(cutoffLockKey(jobId)));
        return real(ref, responseId);
      });
      const holder = holdCutoff(jobId, (tx) => tx.$executeRaw`UPDATE "computer_jobs" SET "agent_response_id" = 'resp-2' WHERE "id" = ${jobId}`);
      let finish: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        finish = finishJobUnder(jobId, 0, 'done', minutes(2), null, null, null, 'rA', ea);
        expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
        holder.release();
        await holder.done;
        await finish;
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finish]);
        spy.mockClear();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect(fake.cancelledTurns).toEqual(['resp-2']);
      expect(statusAtCancel).toEqual(['done']);
      // One cancel, and the cutoff lock was free when it was made (row 15: mutant-tested by making the cancel under the lock)
      expect(lockFreeAtCancel).toEqual([true]);
      // A finish of a worker that lost cancels nothing
      const other = await running('s-c-order-lost');
      const eo = await claimed(other.jobId, 'rA');
      await prisma.computerJob.update({ where: { id: other.jobId }, data: { agentResponseId: 'resp-9' } });
      await claimed(other.jobId, 'rB', minutes(1));
      fake.cancelledTurns.length = 0;
      expect(await finishJobUnder(other.jobId, 0, 'done', minutes(2), null, null, null, 'rA', eo)).toMatchObject({ stale: true, superseded: true });
      expect(fake.cancelledTurns).toEqual([]);
    });
  });

  describe('E5: a sweep ends a job only as it was selected, judged again under the job’s lock', () => {
    const waitingPastLimit = async (name: string) => {
      const made = await running(name);
      const ea = await claimed(made.jobId, 'rA');
      await requestHandoverAs(made.jobId, 'details', NOW, null, { epoch: ea, generation: 0 });
      // Its room is held for hours yet: only the wait is past its limit (the lapsed-lease pass has nothing to say about it)
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(made.jobId)).reservationKey! }, data: { expiresAt: minutes(1000) } });
      return { ...made, ea };
    };
    /**
     * Runs `between` once, at the moment the sweep has selected THIS job and is about to end it (the first look it makes at the job's cutoff decision).
     * Every other job the sweep looks at in the meantime goes straight through to the real call (CodeRabbit on #1025: a job left by an earlier fixture
     * could take the hook). `restore` puts the real call back.
     */
    const betweenSelectAndEnd = (jobId: string, between: () => Promise<unknown>) => {
      const real = actualCalls.endIfCutoffDecided;
      let fired = false;
      /** The job whose first look took the hook (always `jobId` unless the hook is not scoped to it). */
      let firedFor: string | null = null;
      const spy = jest.mocked(calls.endIfCutoffDecided).mockImplementation((async (...args: Parameters<typeof real>) => {
        if (!fired && args[0] === jobId) {
          fired = true;
          firedFor = args[0];
          await between();
        }
        return real(...args);
      }) as never);
      return { fired: () => fired, firedFor: () => firedFor, restore: () => spy.mockImplementation(real as never) };
    };
    /** A job a sweep has already dealt with is put out of every later sweep's way, so each fixture is judged alone. */
    const putAside = (jobId: string) => prisma.computerJob.update({ where: { id: jobId }, data: { status: 'done', endedAt: minutes(121) } });

    it('row 15: the hook belongs to the one job it names: jobs the same sweep looks at before and after it go straight through and are ended as they were selected', async () => {
      // Several other jobs are in line for the same sweep, so the one it names is not the first it looks at: the target's stretch start is made a second later than the others, so the sweep, which reads waiting jobs oldest first, reads it last
      const others = [];
      for (const n of ['a', 'b', 'c', 'd']) others.push(await waitingPastLimit(`s-e5-scope-${n}`));
      const target = await waitingPastLimit('s-e5-scope-target');
      await prisma.computerJob.update({ where: { id: target.jobId }, data: { stretchStarted: new Date((await jobOf(target.jobId)).stretchStarted!.getTime() + 1000) } });
      let ran = 0;
      const spy = betweenSelectAndEnd(target.jobId, async () => {
        ran += 1;
        await prisma.computerJob.update({ where: { id: target.jobId }, data: { control: 'person', controlGeneration: { increment: 1 }, leaseVersion: { increment: 1 } } });
      });
      try {
        await sweepComputers(minutes(120));
      } finally {
        spy.restore();
      }
      // It ran once, for the named job, and for nobody else
      expect(ran).toBe(1);
      expect(spy.firedFor()).toBe(target.jobId);
      expect(await jobOf(target.jobId)).toMatchObject({ status: 'waiting', control: 'person', endedBy: null });
      // The others were not touched by it: each was ended as the sweep selected it
      for (const other of others) expect(await jobOf(other.jobId)).toMatchObject({ status: 'stopped', endedBy: 'unanswered', control: 'brick' });
    });

    it('the sweep selects a waiting job past the wait and the owner takes control meanwhile: not ended as unanswered; CONTROL: a real unanswered wait still ends as `unanswered`', async () => {
      const { jobId } = await waitingPastLimit('s-e5-wait');
      const spy = betweenSelectAndEnd(jobId, () => prisma.computerJob.update({ where: { id: jobId }, data: { control: 'person', controlGeneration: { increment: 1 }, leaseVersion: { increment: 1 } } }));
      try {
        await sweepComputers(minutes(120));
      } finally {
        spy.restore();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', endedBy: null });
      const real = await waitingPastLimit('s-e5-wait-real');
      await sweepComputers(minutes(120));
      expect(await jobOf(real.jobId)).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
    });

    it('the sweep selects a waiting job and the worker answers it (a renewal, a claim, a new wait) meanwhile: not ended; the same selected job that did NOT move is ended', async () => {
      for (const move of ['claim', 'handover', 'lease'] as const) {
        const { jobId } = await waitingPastLimit(`s-e5-move-${move}`);
        const spy = betweenSelectAndEnd(jobId, async () => {
          if (move === 'claim') await claimed(jobId, 'rB', minutes(100));
          if (move === 'handover') await prisma.computerJob.update({ where: { id: jobId }, data: { handoverSeq: { increment: 1 } } }); // a new wait of the same job (the count is all that moves)
          if (move === 'lease') await prisma.computerJob.update({ where: { id: jobId }, data: { leaseVersion: { increment: 1 } } });
        });
        try {
          await sweepComputers(minutes(120));
        } finally {
          spy.restore();
        }
        expect(spy.fired()).toBe(true);
        expect([move, (await jobOf(jobId)).status, (await jobOf(jobId)).endedBy]).toEqual([move, 'waiting', null]);
        await putAside(jobId);
      }
      // CONTROL: the wait is no longer past its limit when the job is judged again (it began a new wait): not ended; one that is past it ends
      const fresh = await waitingPastLimit('s-e5-fresh');
      const spy = betweenSelectAndEnd(fresh.jobId, () => prisma.computerJob.update({ where: { id: fresh.jobId }, data: { stretchStarted: minutes(119) } }));
      try {
        await sweepComputers(minutes(120));
      } finally {
        spy.restore();
      }
      expect(await jobOf(fresh.jobId)).toMatchObject({ status: 'waiting', endedBy: null });
    });

    it('the sweep selects an expired lease and a renewal extends it, then B admits: not ended; CONTROL: a real lapsed lease still ends the job as an error', async () => {
      const made = await running('s-e5-lease');
      const ea = await claimed(made.jobId, 'rA');
      const key = (await jobOf(made.jobId)).reservationKey!;
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { expiresAt: minutes(5) } });
      // The sweep reads the lapsed reservation, then a renewal (the owner’s) extends it before the ending is judged
      const real = prisma.computerFinishIntent.findUnique.bind(prisma.computerFinishIntent) as (args: unknown) => Promise<unknown>;
      let renewed = false;
      const spy = jest.spyOn(prisma.computerFinishIntent, 'findUnique').mockImplementation(((args: unknown) => {
        if (!renewed) {
          renewed = true;
          return renewJob(made.jobId, minutes(4), { epoch: ea }).then(() => real(args));
        }
        return real(args);
      }) as never);
      try {
        await sweepComputers(minutes(7));
      } finally {
        spy.mockRestore();
      }
      expect(renewed).toBe(true);
      expect(await jobOf(made.jobId)).toMatchObject({ status: 'running', endedBy: null });
      // CONTROL
      const lapsed = await running('s-e5-lease-real');
      await claimed(lapsed.jobId, 'rA');
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(lapsed.jobId)).reservationKey! }, data: { expiresAt: minutes(5) } });
      await sweepComputers(minutes(7));
      expect(await jobOf(lapsed.jobId)).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });

    it('N18: an OLD room that lapses ends nothing: a job claimed under a newer key keeps running and the old room is released with nothing charged; CONTROL: a lapse of the job’s own current room still ends it', async () => {
      const made = await running('n18-old-room');
      await claimed(made.jobId, 'rA');
      const current = (await jobOf(made.jobId)).reservationKey!;
      // An earlier try reserved room and stopped before its claim: its room is still held, in the past now, and the job is claimed under another key
      const mine = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: current } });
      const oldKey = `computer:job:${made.jobId}:earlier-try`;
      await prisma.meterReservation.create({
        data: { reservationKey: oldKey, personKey: mine.personKey, personId: mine.personId, botId: mine.botId, jobId: mine.jobId, amountMicros: mine.amountMicros, state: 'held', expiresAt: minutes(5), terms: mine.terms ?? undefined },
      });
      const before = (await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: current } })).amountMicros;
      await sweepComputers(minutes(7));
      expect(await jobOf(made.jobId)).toMatchObject({ status: 'running', endedBy: null, reservationKey: current });
      // The old room is let go, and nothing was charged for it; the current room is as it was
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: oldKey } })).toMatchObject({ state: 'released' });
      expect(await prisma.meterEvent.count({ where: { eventId: { startsWith: `computer:${made.jobId}:time` } } })).toBe(0);
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: current } })).toMatchObject({ state: 'held', amountMicros: before });
      // CONTROL: the job's own current room lapsing still ends it as ours
      await prisma.meterReservation.update({ where: { reservationKey: current }, data: { expiresAt: minutes(5) } });
      await sweepComputers(minutes(8));
      expect(await jobOf(made.jobId)).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });

    it('a job with an intent or a decided cutoff is the finalizer’s: the unanswered and lapsed-lease passes skip it (the finalizer ends it as the intent or the pool says)', async () => {
      const { jobId, ea } = await waitingPastLimit('s-e5-fin');
      await recordFinishIntent(jobId, { outcome: 'done', epoch: ea }, minutes(1));
      const spy = betweenSelectAndEnd(jobId, async () => undefined);
      try {
        await sweepComputers(minutes(120));
      } finally {
        spy.restore();
      }
      // Ended by the finalizer, as the intent said (done), never as unanswered
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
    });
  });

  describe('E6: once an intent or a cutoff is decided, the finalizer owns the ending', () => {
    it('intent kept, then the owner’s renewal: ZERO room and `ending`; the outcome is unchanged', async () => {
      const { jobId } = await running('s-e6-intent');
      const ea = await claimed(jobId, 'rA');
      expect(await recordFinishIntent(jobId, { outcome: 'done', epoch: ea }, minutes(1))).toMatchObject({ ok: true, already: false });
      const before = await roomOf(jobId);
      expect(await renewJob(jobId, minutes(2), { epoch: ea })).toEqual({ ok: false, reason: 'ending' });
      expect(await roomOf(jobId)).toEqual(before);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await completeFinishIntents(minutes(5), 10)).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
    });

    it('intent kept, then a renewal that WOULD hit the allowance: it is `ending`, the job ends as the INTENT says (failed, ours: given back with its decision row), never as the allowance', async () => {
      const { jobId } = await running('s-e6-allow');
      const ea = await claimed(jobId, 'rA');
      expect(await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', why: 'The relay could not be reached', turns: [1], epoch: ea }, minutes(1))).toMatchObject({ ok: true, already: false });
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(2), { epoch: ea })).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      await setUp();
      expect(await completeFinishIntents(minutes(5), 10)).toBe(1);
      const ended = await jobOf(jobId);
      expect(ended.status).toMatch(/^(failed|stopped)$/);
      expect(ended.endedBy).not.toBe('allowance');
      expect(await decisionOf(jobId)).not.toBeNull();
    });

    it('a real pool cutoff with a delayed finalizer, then the owner’s renewal hits the allowance: `ending`; the job ends as `pool` with its give-back decision (never as the allowance)', async () => {
      const { jobId } = await running('s-e6-pool');
      const ea = await claimed(jobId, 'rA');
      await recordPoolCutoff(prisma, jobId, minutes(1));
      await setUp({ memberAllowanceMicros: 1_000 });
      expect(await renewJob(jobId, minutes(2), { epoch: ea })).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      await setUp();
      await sweepComputers(minutes(10));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      expect(await decisionOf(jobId)).not.toBeNull();
      await cutoffEndsFinished();
    });

    it('a refusal never writes its own ending once an intent is kept: A’s call refused for the allowance after the intent changes nothing (the finalizer owns the ending)', async () => {
      const { jobId } = await running('s-e6-call');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      const real = actualMeter.reserveRoom;
      const spy = jest.mocked(meter.reserveRoom).mockImplementationOnce((async (...args: Parameters<typeof real>) => {
        const room = await real(...args);
        await recordFinishIntent(jobId, { outcome: 'done', epoch: ea }, minutes(1));
        return room;
      }) as never);
      try {
        expect(await ask(a, 'c-big', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
      } finally {
        spy.mockClear();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      expect(await completeFinishIntents(minutes(5), 10)).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
    });
  });

  describe('S2: a start exists durably before its job row', () => {
    const KEY_A = 'mx:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const KEY_B = 'mx:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const start = (sara: { id: string; brickId: string }, startKey: string, title = 'Visa form') => startJob({ botId: sara.brickId, personId: sara.id, title, startKey, acks: true }, NOW);
    const jobsOf = (sara: { id: string }) => prisma.computerJob.count({ where: { personId: sara.id } });
    const roomsOf = (sara: { id: string }) => prisma.meterReservation.count({ where: { personId: sara.id } });
    /** Request A reached Orbit and was held before its job: its attempt is open, beating `agoMs` ago, and was made before any attempt of B (never the same millisecond: the order of two attempts is their creation time). */
    const pausedA = (sara: { id: string; brickId: string }, agoMs: number) => prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_A, state: 'open', beatAt: new Date(Date.now() - agoMs), createdAt: new Date(Date.now() - agoMs - 1_000) } });
    const setUpBrick = async (name: string) => {
      const sara = await person(name);
      await giveComputer(sara.brickId, sara.id);
      return sara;
    };

    it('A paused after it reached Orbit and still beating, B reworded under a new key: B gets `earlier` naming A’s key (state `starting`), and no job; when A goes on, ONE job and ONE reservation', async () => {
      const sara = await setUpBrick('s-s2-fresh');
      await pausedA(sara, 1_000);
      const b = await start(sara, KEY_B, 'Fill the visa form');
      expect(b).toEqual({ ok: false, reason: 'earlier', job: { id: null, status: null, state: 'starting', attempt: KEY_A } });
      expect(await jobsOf(sara)).toBe(0);
      expect(await startedJobFor(sara.brickId, sara.id, KEY_A, new Date())).toEqual({ inProgress: true });
      const a = await start(sara, KEY_A);
      expect(a).toMatchObject({ ok: true });
      expect(await jobsOf(sara)).toBe(1);
      expect(await roomsOf(sara)).toBe(1);
      // B's answer is kept (GPT round 6, finding 1): it waits on A's attempt, and a retry of B is answered with A's job, never one of its own
      const bRow = await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: KEY_B } });
      const aRow = await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: KEY_A } });
      expect(bRow).toMatchObject({ state: 'answered', aliasAttemptId: aRow.id });
      expect(await start(sara, KEY_B, 'Fill the visa form')).toMatchObject({ ok: false, reason: 'earlier', job: { id: (a as { job: { id: string } }).job.id, attempt: KEY_A } });
      expect(await jobsOf(sara)).toBe(1);
    });

    it('A paused and EXPIRED (it stopped beating), B reworded: B creates the one job; A then refuses, naming B’s job (`earlier`), and makes none. Postgres ends with ONE job and ONE reservation', async () => {
      const sara = await setUpBrick('s-s2-expired');
      await pausedA(sara, 10 * 60_000);
      const b = await start(sara, KEY_B, 'Fill the visa form');
      expect(b).toMatchObject({ ok: true });
      const jobB = (b as { ok: true; job: { id: string } }).job.id;
      expect((await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: KEY_A } })).state).toBe('superseded');
      const a = await start(sara, KEY_A);
      expect(a).toMatchObject({ ok: false, reason: 'earlier', job: { id: jobB, attempt: KEY_B, state: 'live' } });
      expect(await jobsOf(sara)).toBe(1);
      expect(await roomsOf(sara)).toBe(1);
    });

    it('a start whose own attempt stopped beating answers `expired` and makes nothing (the game starts afresh); one that ends with no job (refused) keeps that refusal on its key (round 8)', async () => {
      const sara = await setUpBrick('s-s2-expired-own');
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_A, state: 'expired', beatAt: new Date() } });
      expect(await start(sara, KEY_A)).toEqual({ ok: false, reason: 'expired' });
      expect(await jobsOf(sara)).toBe(0);
      const off = await person('s-s2-off');
      expect(await start(off, KEY_B)).toMatchObject({ ok: false, reason: 'off' });
      // Round 8, A1 (Opus): a refusal is kept on the key (state `refused`, its answer in `outcome`), so a retry of it is the same answer
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: off.id, startKey: KEY_B } })).toMatchObject({ state: 'refused', outcome: { ok: false, reason: 'off' } });
      // ... the library hands back the kept answer, which the route gives as it was
      expect(await start(off, KEY_B)).toEqual({ ok: false, reason: 'kept', body: { ok: false, reason: 'off' } });
    });

    it('B first, A later (both arrival orders): one job, one reservation; the same key given twice at once, and again later, in this process (a same-key library replay: no router is restarted and no Redis is cleared here): one job, one reservation', async () => {
      const sara = await setUpBrick('s-s2-order');
      const b = await start(sara, KEY_B, 'Fill the visa form');
      expect(b).toMatchObject({ ok: true });
      expect(await start(sara, KEY_A)).toMatchObject({ ok: false, reason: 'earlier', job: { attempt: KEY_B } });
      expect(await jobsOf(sara)).toBe(1);
      const twice = await setUpBrick('s-s2-twice');
      const [one, two] = await Promise.all([start(twice, KEY_A), start(twice, KEY_A)]);
      expect([one, two].every((answer) => answer.ok)).toBe(true);
      expect((one as { job: { id: string } }).job.id).toBe((two as { job: { id: string } }).job.id);
      expect(await jobsOf(twice)).toBe(1);
      expect(await roomsOf(twice)).toBe(1);
      // Later, the same key again answers the job it made (a replay of the library call; the router's own key derivation across a restart is not exercised here)
      const again = await start(twice, KEY_A);
      expect((again as { job: { id: string } }).job.id).toBe((one as { job: { id: string } }).job.id);
      expect(await jobsOf(twice)).toBe(1);
      expect(await roomsOf(twice)).toBe(1);
    });

    it('CONTROL: a deliberate later request after the first was acked creates a distinct job and reservation; the keyed look-up answers a made start’s job', async () => {
      const sara = await setUpBrick('s-s2-later');
      const first = (await start(sara, KEY_A)) as { ok: true; job: { id: string } };
      expect(first.ok).toBe(true);
      expect(await ackStart(sara.brickId, sara.id, KEY_A)).toBe(true);
      const second = (await start(sara, KEY_B, 'Another job')) as { ok: true; job: { id: string } };
      expect(second.ok).toBe(true);
      expect(second.job.id).not.toBe(first.job.id);
      expect(await jobsOf(sara)).toBe(2);
      // the second waits in line for the machine (queued) and takes its room only when it runs: its own, distinct one then; the first keeps its one
      expect(await roomsOf(sara)).toBe(1);
      expect(await prisma.computerJob.findUnique({ where: { id: second.job.id }, select: { status: true, reservationKey: true } })).toEqual({ status: 'queued', reservationKey: null });
      expect(await startedJobFor(sara.brickId, sara.id, KEY_A, new Date())).toMatchObject({ id: first.job.id });
    });
  });

  describe('the claim itself, the keys of an owner and the seams between a read and the write that follows it', () => {
    /** Runs `between` right after the first whole-row read of the job that `endJob` makes (the write that follows must still find the job as that read saw it). */
    const afterEndJobRead = (jobId: string, between: () => Promise<unknown>) => {
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as unknown as (args: { where?: { id?: string }; select?: unknown; include?: unknown }) => Promise<unknown>;
      let fired = false;
      return jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { where?: { id?: string }; select?: unknown; include?: unknown }) => {
        const mine = !fired && args?.where?.id === jobId && !args.select && !args.include;
        return real(args).then(async (row) => {
          if (mine) {
            fired = true;
            await between();
          }
          return row;
        });
      }) as never);
    };

    /** The first read a limit's pause makes of the job (lib/computer-limit-pause, before its transaction): `between` runs right after it. */
    const afterPauseRead = (jobId: string, between: () => Promise<unknown>) => {
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as unknown as (args: { where?: { id?: string }; select?: Record<string, unknown> }) => Promise<unknown>;
      let fired = false;
      return jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { where?: { id?: string }; select?: Record<string, unknown> }) => {
        const mine = !fired && args?.where?.id === jobId && !!args.select && Object.keys(args.select).join() === 'botId';
        return real(args).then(async (row) => {
          if (mine) {
            fired = true;
            await between();
          }
          return row;
        });
      }) as never);
    };

    it('a claim is a compare-and-set on the epoch the runner saw: a stale `seen` (older or newer) is `superseded` naming the job’s epoch and changes nothing; two claims on the same `seen` at once: ONE wins', async () => {
      const { jobId } = await running('s-claim-cas');
      const e1 = await claimed(jobId, 'rA');
      expect(await claimJob(jobId, { run: 'rB', seen: 0 }, minutes(1))).toEqual({ ok: false, reason: 'superseded', ownerEpoch: e1 });
      expect(await claimJob(jobId, { run: 'rB', seen: e1 + 5 }, minutes(1))).toEqual({ ok: false, reason: 'superseded', ownerEpoch: e1 });
      expect(await jobOf(jobId)).toMatchObject({ ownerEpoch: e1, ownerRun: 'rA' });
      const both = await Promise.all([claimJob(jobId, { run: 'rB', seen: e1 }, minutes(2)), claimJob(jobId, { run: 'rC', seen: e1 }, minutes(2))]);
      expect(both.filter((one) => one.ok)).toHaveLength(1);
      expect(both.filter((one) => !one.ok)).toEqual([{ ok: false, reason: 'superseded', ownerEpoch: e1 + 1 }]);
      expect((await jobOf(jobId)).ownerEpoch).toBe(e1 + 1);
    });

    it('a claim ends every key of the owner it replaces (their rows are revoked), and a key of the older epoch is refused even if its row were live', async () => {
      const { jobId } = await running('s-claim-keys');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      expect(await liveKeys(jobId)).toBe(1);
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect(await liveKeys(jobId)).toBe(0);
      expect(await prisma.computerJobToken.count({ where: { jobId, ownerEpoch: ea, revokedAt: { not: null } } })).toBe(1);
      expect((await verifyJobToken(a, 'model', minutes(1))).ok).toBe(false);
      // A key row of the older epoch that is somehow live is still not the owner's
      const row = await prisma.computerJobToken.findFirstOrThrow({ where: { jobId, ownerEpoch: ea } });
      await prisma.computerJobToken.update({ where: { id: row.id }, data: { revokedAt: null } });
      expect((await verifyJobToken(a, 'model', minutes(1))).ok).toBe(false);
      expect(eb).toBe(ea + 1);
    });

    it('a mint names the epoch it is for: a worker that claimed earlier is `superseded` and gets no key; a prepare’s mint ends only the keys of ITS epoch', async () => {
      const { jobId } = await running('s-mint-epoch');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      const before = await prisma.computerJobToken.count({ where: { jobId } });
      expect(await mintJobToken(jobId, 'model', minutes(1), { generation: 0 }, { epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect(await prisma.computerJobToken.count({ where: { jobId } })).toBe(before);
      // A live key of another epoch is not touched by this owner's prepare (it is not this owner's to end)
      const other = await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: 0, digest: `other-${randomUUID()}`, expiresAt: minutes(60), ownerEpoch: ea } });
      const claim = new Date();
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: claim } });
      const minted = await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: eb, prepareClaim: claim });
      expect(minted.ok).toBe(true);
      expect((await prisma.computerJobToken.findUniqueOrThrow({ where: { id: other.id } })).revokedAt).toBeNull();
    });

    it('a lease renewal bumps the lease version once and renews only the keys of the owner’s epoch', async () => {
      const { jobId } = await running('s-renew-keys');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      const other = await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: 0, digest: `other-${randomUUID()}`, expiresAt: minutes(2), ownerEpoch: ea + 1 } });
      const mine = await prisma.computerJobToken.findFirstOrThrow({ where: { jobId, ownerEpoch: ea, revokedAt: null } });
      const before = (await jobOf(jobId)).leaseVersion;
      expect(await renewJob(jobId, minutes(1), { epoch: ea })).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).leaseVersion).toBe(before + 1);
      expect((await prisma.computerJobToken.findUniqueOrThrow({ where: { id: other.id } })).expiresAt.getTime()).toBe(minutes(2).getTime());
      expect((await prisma.computerJobToken.findUniqueOrThrow({ where: { id: mine.id } })).expiresAt.getTime()).toBeGreaterThan(mine.expiresAt.getTime());
      expect((await verifyJobToken(a, 'model', minutes(2))).ok).toBe(true);
    });

    it('a pool cutoff alone (no intent) is the finalizer’s too: the owner’s renewal with plenty of allowance is `ending` and adds ZERO room', async () => {
      const { jobId } = await running('s-renew-cutoff');
      const ea = await claimed(jobId, 'rA');
      const before = await roomOf(jobId);
      await recordPoolCutoff(prisma, jobId, minutes(1));
      expect(await renewJob(jobId, minutes(2), { epoch: ea })).toEqual({ ok: false, reason: 'ending' });
      expect(await roomOf(jobId)).toEqual(before);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('a renewal that is refused decides the job only as the owner it was decided for, in the write that pauses it: B claims before that write, and nothing is paused or ended (allowance, and a rule); once paused, there is no window left for a claim', async () => {
      for (const kind of ['allowance', 'rule'] as const) {
        const { sara, jobId } = await running(`s-renew-end-${kind}`);
        const ea = await claimed(jobId, 'rA');
        if (kind === 'allowance') await setUp({ memberAllowanceMicros: 1_000 });
        else await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(10), words: 'Never more than ten millionths a day', createdById: sara.id } });
        const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
        // B claims just before the renewal's own write (the pause is decided inside it, so this is the only seam left)
        const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (fn: unknown, options?: unknown) => {
          await claimed(jobId, 'rB', minutes(1));
          return real(fn, options);
        }) as never);
        let answer: unknown;
        try {
          answer = await renewJob(jobId, minutes(2), { epoch: ea });
        } finally {
          spy.mockRestore();
        }
        expect(answer).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
        expect(await jobOf(jobId)).toMatchObject({ status: 'running', queuedFor: null, pausedWhy: null, endedBy: null, endNote: null, ownerEpoch: ea + 1 });
        // B's own renewal at the same limit pauses it; a claim after that write finds no running job (the decision and the pause are one write)
        expect(await renewJob(jobId, minutes(3), { epoch: ea + 1 })).toEqual({ ok: false, reason: 'paused', why: kind });
        expect(await claimJob(jobId, { run: 'rC', seen: ea + 2 }, minutes(4))).toMatchObject({ ok: false });
        expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: kind, endedBy: null, ownerEpoch: ea + 2 });
        await setUp();
      }
    });

    it('the sweep renews the room of a WAITING job that was claimed (it names the epoch it read): the lease about to lapse is extended', async () => {
      const { jobId } = await running('s-sweep-renew');
      const ea = await claimed(jobId, 'rA');
      await requestHandoverAs(jobId, 'details', NOW, null, { epoch: ea, generation: 0 });
      const key = (await jobOf(jobId)).reservationKey!;
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { expiresAt: minutes(11) } });
      await sweepComputers(minutes(10));
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'waiting', endedBy: null });
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey! } })).expiresAt.getTime()).toBeGreaterThan(minutes(11).getTime());
    });

    it('a sweep’s ending lands only on the job as it was read: after the ending’s own read the owner changes (a claim, a lease version, a new wait, a take-over) and NOTHING is ended; CONTROL: the same job unmoved is ended', async () => {
      const moves: Array<[string, (jobId: string) => Promise<unknown>]> = [
        ['claim', (jobId) => claimed(jobId, 'rB', minutes(100))],
        ['lease', (jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { leaseVersion: { increment: 1 } } })],
        ['wait', (jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { handoverSeq: { increment: 1 } } })],
        ['control', (jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { control: 'person', controlGeneration: { increment: 1 } } })],
        // Each value on its own (the others stay as they were read): the check of every one of them is the write's own
        ['epoch only', (jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: { increment: 1 } } })],
        ['control only', (jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { control: 'person' } })],
      ];
      for (const [name, move] of moves) {
        const { jobId } = await running(`s-after-read-${name}`);
        const ea = await claimed(jobId, 'rA');
        await requestHandoverAs(jobId, 'details', NOW, null, { epoch: ea, generation: 0 });
        await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(jobId)).reservationKey! }, data: { expiresAt: minutes(1000) } });
        const spy = afterEndJobRead(jobId, () => move(jobId));
        try {
          await sweepComputers(minutes(120));
        } finally {
          spy.mockRestore();
        }
        expect([name, (await jobOf(jobId)).endedBy]).toEqual([name, null]);
      }
      const still = await running('s-after-read-none');
      const es = await claimed(still.jobId, 'rA');
      await requestHandoverAs(still.jobId, 'details', NOW, null, { epoch: es, generation: 0 });
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(still.jobId)).reservationKey! }, data: { expiresAt: minutes(1000) } });
      await sweepComputers(minutes(120));
      expect(await jobOf(still.jobId)).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
    });

    it('a lapsed-lease ending lands only while the reservation is still the one seen: it is extended after the ending’s own read (no lease version moved) and NOTHING is ended; CONTROL: unmoved, it ends as an error', async () => {
      const { jobId } = await running('s-after-read-lease');
      await claimed(jobId, 'rA');
      const key = (await jobOf(jobId)).reservationKey!;
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { expiresAt: minutes(5) } });
      const spy = afterEndJobRead(jobId, () => prisma.meterReservation.update({ where: { reservationKey: key }, data: { expiresAt: minutes(60) } }));
      try {
        await sweepComputers(minutes(7));
      } finally {
        spy.mockRestore();
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { expiresAt: minutes(5) } });
      await sweepComputers(minutes(7));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });

    it('a refusal’s pause decides under the cutoff lock: an intent kept, or a pool cutoff decided, AFTER the pause’s own read leaves the ending to the finalizer (nothing written by the refusal)', async () => {
      for (const kind of ['intent', 'cutoff'] as const) {
        const { jobId } = await running(`s-after-read-${kind}`);
        const ea = await claimed(jobId, 'rA');
        const a = await keyFor(jobId, ea);
        // The refusal now pauses the job (piece 3): the intent or cutoff lands after the pause's first read and before its write, which reads them under the cutoff lock
        const spy = afterPauseRead(jobId, () => (kind === 'intent' ? recordFinishIntent(jobId, { outcome: 'done', epoch: ea }, minutes(1)) : recordPoolCutoff(prisma, jobId, minutes(1))));
        try {
          expect(await ask(a, 'c-big', { estimateMicros: 5_000_000 })).toEqual({ ok: false, reason: 'allowance' });
        } finally {
          spy.mockRestore();
        }
        expect(await jobOf(jobId)).toMatchObject({ status: 'running', queuedFor: null, endedBy: null, ownerEpoch: ea });
        expect(await prisma.computerJobPause.count({ where: { jobId } })).toBe(0);
      }
    });

    it('two pool refusals of a worker that no longer owns the job decide nothing (no pool cutoff), even though both reach the cutoff decision after B claimed', async () => {
      const { jobId } = await running('s-pool-from');
      const ea = await claimed(jobId, 'rA');
      const a = await keyFor(jobId, ea);
      await setUp({ poolCeilingMicros: 1 });
      let arrived = 0;
      let claimDone = false;
      // A bounded barrier: when either call fails before the other can be let go (or B's claim is refused), BOTH are let go with that failure, so the test reports it and
      // reaches its `finally` (CodeRabbit on #1025)
      let broken: Error | null = null;
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (done: () => boolean): Promise<void> => {
        for (let tries = 0; tries < 1000 && !done(); tries += 1) {
          if (broken) throw broken;
          await pause(10);
        }
        if (broken) throw broken;
        if (!done()) throw new Error('the barrier did not open');
      };
      const spy = jest.mocked(meter.reserveRoom).mockImplementation((async (...args: Parameters<typeof actualMeter.reserveRoom>) => {
        try {
          arrived += 1;
          const first = arrived === 1;
          await until(() => arrived >= 2);
          if (first) {
            const won = await takeOverClaim(jobId, 'rB', ea, minutes(1));
            if (!won.ok) throw new Error('B’s claim was refused');
            claimDone = true;
          } else {
            await until(() => claimDone);
          }
        } catch (error) {
          broken = error instanceof Error ? error : new Error('the fixture failed');
          throw broken;
        }
        return actualMeter.reserveRoom(...args);
      }) as never);
      let answers: Awaited<ReturnType<typeof ask>>[] = [];
      try {
        const settled = await Promise.allSettled([ask(a, 'c1', { estimateMicros: 5_000 }), ask(a, 'c2', { estimateMicros: 5_000 })]);
        if (broken) throw broken;
        answers = settled.map((one) => {
          if (one.status === 'rejected') throw one.reason;
          return one.value;
        });
      } finally {
        spy.mockImplementation(((...args: Parameters<typeof actualMeter.reserveRoom>) => actualMeter.reserveRoom(...args)) as never);
        await setUp();
      }
      // Both calls reached the room decision (the barrier opened for both) and BOTH were refused for the pool, not stopped earlier as stale
      expect(arrived).toBe(2);
      expect(answers).toEqual([
        { ok: false, reason: 'pool', full: true },
        { ok: false, reason: 'pool', full: true },
      ]);
      expect(await hasPoolCutoff(prisma, jobId)).toBe(false);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });
  });

  describe('the broker routes’ library: the owner’s epoch on prepare, turn, reconnect', () => {
    it('a worker that is not the owner is `superseded` on prepare, turn and reconnect: no key is made, no turn is sent, no machine is touched; the owner’s own go through', async () => {
      const { jobId } = await running('s-broker-epoch');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      const keys = await prisma.computerJobToken.count({ where: { jobId } });
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect(await startTurn(jobId, 'Do it', new AbortController().signal, { epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect(await reattachJobTurn(jobId, new AbortController().signal, { epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect(await prisma.computerJobToken.count({ where: { jobId } })).toBe(keys);
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rB', epoch: eb })).toMatchObject({ ok: true });
    });

    it('CodeRabbit on #1025 (2): a start whose last look waits while another worker claims is superseded BEFORE the provider hears of the turn; CONTROL: the owner’s own start opens it', async () => {
      const { jobId } = await running('s-turn-admission');
      const ea = await claimed(jobId, 'rA');
      const opened = () => fake.calls.filter((call) => call.name === 'openTurn').length;
      // Another worker is claiming (it holds the job's cutoff lock, the one the last look waits for) and its claim lands while the start waits
      const claiming = holdCutoff(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: { increment: 1 } } });
      });
      const before = opened();
      let start: ReturnType<typeof startTurn> | undefined;
      try {
        await claiming.ready;
        start = startTurn(jobId, 'Do it', new AbortController().signal, { epoch: ea });
        // The start is blocked on the cutoff lock before the epoch changes: without this it could first look after the claim and be superseded by the plain first check
        expect(await waitForWaiters(cutoffLockKey(jobId), 1, start)).toBe(true);
        claiming.release();
        await claiming.done;
        expect(await start).toEqual({ ok: false, reason: 'superseded' });
      } finally {
        claiming.release();
        await Promise.allSettled([claiming.done, ...(start ? [start] : [])]);
      }
      expect(opened()).toBe(before);
      // The mark the start put on the job for its first turn went with it (nothing was sent): the new owner is not told of a turn that never was
      expect((await jobOf(jobId)).firstTurnSentAt).toBeNull();
      // CONTROL: the owner's own start goes through
      const eb = (await jobOf(jobId)).ownerEpoch;
      const own = await startTurn(jobId, 'Do it', new AbortController().signal, { epoch: eb });
      expect(own.ok).toBe(true);
      expect(opened()).toBe(before + 1);
    });

    it('CodeRabbit on #1025 (5): a worker that says the relay was unreachable after the runner kept its finish intent is told `finish_pending` and no fault is written; CONTROL: a job with no intent records it', async () => {
      const { jobId } = await running('s-relay-intent');
      const ea = await claimed(jobId, 'rA');
      const faults = () => prisma.computerJobFault.count({ where: { jobId } });
      await recordFinishIntent(jobId, { outcome: 'done', epoch: ea }, minutes(1));
      const before = await faults();
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await faults()).toBe(before);
      const other = await running('s-relay-no-intent');
      const eo = await claimed(other.jobId, 'rA');
      expect(await prepareJob(other.jobId, RELAY, minutes(2), { run: 'rA', epoch: eo, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
      expect(await prisma.computerJobFault.count({ where: { jobId: other.jobId } })).toBeGreaterThan(0);
    });

    it('a stale prepare never takes the prepare claim (the owner’s own is not held off: `superseded`, not `preparing`), and a stale prepare that says the relay was unreachable records no fault', async () => {
      const { jobId } = await running('s-broker-claim');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      const held = new Date();
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: held } });
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect((await jobOf(jobId)).prepareClaimedAt?.getTime()).toBe(held.getTime());
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: null } });
      const faults = await prisma.computerJobFault.count({ where: { jobId } });
      // The look and the write are ONE transaction under the job's row lock: a claim that commits while the prepare waits for the row is met by the write, and no fault is recorded for a job that is no longer this worker's
      const holder = holdRow(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: { increment: 1 } } });
      });
      let waiting: ReturnType<typeof prepareJob> | undefined;
      try {
        await holder.locked;
        waiting = prepareJob(jobId, RELAY, minutes(3), { run: 'rB', epoch: eb, relayReached: false, relayStatus: 404 });
        expect(await waitForRowWaiter(holder, waiting)).toBe(true);
        holder.release();
        await holder.done;
        expect(await waiting!).toEqual({ ok: false, reason: 'superseded' });
        expect(await prisma.computerJobFault.count({ where: { jobId } })).toBe(faults);
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, ...(waiting ? [waiting] : [])]);
      }
    });

    it('a prepare that is overtaken by a claim after its key was made is `superseded` and its key is ended: only the owner’s key stands', async () => {
      const { jobId } = await running('s-broker-after');
      const ea = await claimed(jobId, 'rA');
      let overtaken = false;
      // After the key was written on the machine (the prepare reads the job once more), B claims
      const execSpy = jest.spyOn(fake, 'exec').mockImplementation(async (...args: Parameters<FakeComputerProvider['exec']>) => {
        if (!overtaken) {
          overtaken = true;
          await claimed(jobId, 'rB', minutes(2));
        }
        return FakeComputerProvider.prototype.exec.apply(fake, args);
      });
      let answer: unknown;
      try {
        answer = await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea });
      } finally {
        execSpy.mockRestore();
      }
      expect(overtaken).toBe(true);
      expect(answer).toEqual({ ok: false, reason: 'superseded' });
      expect(await liveKeys(jobId)).toBe(0);
    });

    it('a turn’s id is recorded only for the worker that still owns the job: A opens a turn, B claims, then A’s `created` arrives: A’s response id is NOT recorded and A’s turn is cancelled by its own id; CONTROL: the owner’s own `created` is recorded and nothing is cancelled', async () => {
      const drain = async (events: AsyncGenerator<{ type: string }>) => {
        const seen: Array<{ type: string; code?: string }> = [];
        for await (const event of events) seen.push(event as { type: string; code?: string });
        return seen;
      };
      // A: the turn is opened as the owner, and B claims while the agent is accepting it (before the id arrives)
      const { jobId } = await running('s-turn-record');
      const ea = await claimed(jobId, 'rA');
      fake.turns = [[{ type: 'created', id: 'resp-A', sessionId: 'sess-A' }, { type: 'text', text: 'Working' }, { type: 'completed', outputText: 'Working', usage: null }]];
      const original = FakeComputerProvider.prototype.openTurn.bind(fake);
      const open = jest.spyOn(fake, 'openTurn').mockImplementationOnce((async (ref: string, input: { text: string; sessionId: string | null }, signal?: AbortSignal) => {
        await claimed(jobId, 'rB', minutes(1));
        return original(ref, input, signal);
      }) as never);
      let seen: Array<{ type: string; code?: string }>;
      try {
        const started = await startTurn(jobId, 'carry on', new AbortController().signal, { epoch: ea });
        if (!started.ok) throw new Error(`the dispatch is the only seam this test crosses (${started.reason})`);
        seen = await drain(started.events);
      } finally {
        open.mockRestore();
      }
      expect(seen[0]).toMatchObject({ type: 'failed', code: 'fenced' });
      expect(await jobOf(jobId)).toMatchObject({ agentResponseId: null, ownerEpoch: ea + 1, status: 'running' });
      expect(fake.cancelledTurns).toEqual(['resp-A']);
      // CONTROL: the owner's own `created` is recorded while the turn runs, cleared when it ends, and nothing is cancelled
      const own = await running('s-turn-record-own');
      const eo = await claimed(own.jobId, 'rA');
      fake.cancelledTurns.length = 0;
      fake.turns = [[{ type: 'created', id: 'resp-O', sessionId: 'sess-O' }, { type: 'text', text: 'Working' }, { type: 'completed', outputText: 'Working', usage: null }]];
      const started = await startTurn(own.jobId, 'carry on', new AbortController().signal, { epoch: eo });
      if (!started.ok) throw new Error('the owner’s turn was not started');
      for await (const event of started.events) {
        if (event.type === 'created') expect(await jobOf(own.jobId)).toMatchObject({ agentResponseId: 'resp-O', agentSessionId: 'sess-O' });
      }
      expect(await jobOf(own.jobId)).toMatchObject({ agentResponseId: null });
      expect(fake.cancelledTurns).toEqual([]);
    });

    it('a reconnect that finds its turn gone clears the turn it read, never another worker’s: B takes the job and sets its own turn meanwhile; B’s turn stays', async () => {
      const { jobId } = await running('s-broker-reattach');
      const ea = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-A' } });
      const spy = jest.spyOn(fake, 'reattachTurn').mockImplementation(async () => {
        await claimed(jobId, 'rB', minutes(2));
        await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-B' } });
        throw new Agent37Error(404, 'gone', 'gone');
      });
      try {
        expect(await reattachJobTurn(jobId, new AbortController().signal, { epoch: ea })).toMatchObject({ ok: false });
      } finally {
        spy.mockRestore();
      }
      expect((await jobOf(jobId)).agentResponseId).toBe('resp-B');
    });
  });
  describe('GPT round 6, finding 3a: a claim never takes a job from a HEALTHY owner (the owner holds it by beating, and lets it go on purpose)', () => {
    const HELD_UNTIL = new Date(NOW.getTime() + 90_000);

    it('the claim holds the job for 90 seconds: a second worker that saw the right epoch is refused with `held` and the time to look again, and nothing at all is written', async () => {
      const { jobId } = await running('s-lease-held');
      const won = await claimJob(jobId, { run: 'rA', seen: 0 }, NOW);
      expect(won).toEqual({ ok: true, epoch: 1 });
      expect(await jobOf(jobId)).toMatchObject({ ownerEpoch: 1, ownerRun: 'rA', ownerLeaseUntil: HELD_UNTIL });
      // The owner has a key (CodeRabbit on #1025, 43): a claim that is refused must leave it valid
      const ownersKey = await keyFor(jobId, 1);
      expect(await liveKeys(jobId)).toBe(1);
      const before = await jobOf(jobId);
      // A second server with the current epoch: refused, and told when to look again
      expect(await claimJob(jobId, { run: 'rB', seen: 1 }, new Date(NOW.getTime() + 89_000))).toEqual({ ok: false, reason: 'held', until: HELD_UNTIL });
      const after = await jobOf(jobId);
      expect([after.ownerEpoch, after.ownerRun, after.leaseVersion]).toEqual([before.ownerEpoch, before.ownerRun, before.leaseVersion]);
      expect(after.ownerLeaseUntil).toEqual(HELD_UNTIL);
      // The owner's keys are untouched by a refused claim
      expect(await liveKeys(jobId)).toBe(1);
      expect((await verifyJobToken(ownersKey, 'model', new Date(NOW.getTime() + 89_000))).ok).toBe(true);
      // Once the hold has run out (the owner stopped beating) the next worker takes it
      expect(await claimJob(jobId, { run: 'rB', seen: 1 }, new Date(NOW.getTime() + 91_000))).toEqual({ ok: true, epoch: 2 });
    });

    it('a beat from the owner holds it another 90 seconds, so a claim that would have won is refused; a beat from a worker that was replaced is superseded and holds nothing', async () => {
      const { jobId } = await running('s-lease-beat');
      const ea = await claimed(jobId, 'rA');
      // The owner beats at 60 s: the hold stands to 150 s, so the claim that would have won at 91 s is refused
      expect(await beatJob(jobId, new Date(NOW.getTime() + 60_000), { epoch: ea })).toEqual({ ok: true, until: new Date(NOW.getTime() + 150_000) });
      expect(await claimJob(jobId, { run: 'rB', seen: ea }, new Date(NOW.getTime() + 91_000))).toMatchObject({ ok: false, reason: 'held' });
      // A worker that was replaced beats nothing: the hold is left exactly as the owner's own beat left it
      const eb = await claimed(jobId, 'rB', new Date(NOW.getTime() + 151_000));
      const held = (await jobOf(jobId)).ownerLeaseUntil;
      expect(await beatJob(jobId, new Date(NOW.getTime() + 200_000), { epoch: ea })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(held);
      // ...and the owner's own beat lands
      expect(await beatJob(jobId, new Date(NOW.getTime() + 200_000), { epoch: eb })).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 290_000));
    });

    it('`release` lets the job go at once (a graceful stop), so a replacement claims it without waiting the hold out; a release from a worker that was replaced releases nothing', async () => {
      const { jobId } = await running('s-lease-release');
      const ea = await claimed(jobId, 'rA');
      expect(await releaseJob(jobId, { epoch: ea })).toEqual({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      const eb = await claimJob(jobId, { run: 'rB', seen: ea }, new Date(NOW.getTime() + 1_000));
      expect(eb).toEqual({ ok: true, epoch: ea + 1 });
      // The old worker's release does not let go of the new owner's hold
      expect(await releaseJob(jobId, { epoch: ea })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect((await jobOf(jobId)).ownerLeaseUntil).not.toBeNull();
    });

    it('CodeRabbit on #1025 (41): a beat that was read before a renewal and lands after it never moves the hold back; the owner is still told it owns the job', async () => {
      const { jobId } = await running('s-lease-back');
      const ea = await claimed(jobId, 'rA');
      expect(await beatJob(jobId, new Date(NOW.getTime() + 60_000), { epoch: ea })).toEqual({ ok: true, until: new Date(NOW.getTime() + 150_000) });
      // A beat that started at 10 s lands now: its deadline (100 s) is earlier than the hold that stands (150 s)
      const late = await beatJob(jobId, new Date(NOW.getTime() + 10_000), { epoch: ea });
      expect(late).toEqual({ ok: true, until: new Date(NOW.getTime() + 150_000), held: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 150_000));
      // The same rule for a renewal and an admitted call that were read earlier
      expect(await renewJob(jobId, new Date(NOW.getTime() + 20_000), { epoch: ea })).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 150_000));
      expect(await ask(await keyFor(jobId, ea), 'cb1', {}, new Date(NOW.getTime() + 30_000))).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 150_000));
      // A hold that LAPSED (nobody claimed) is brought back by the owner's next beat: it was only late
      expect(await beatJob(jobId, new Date(NOW.getTime() + 400_000), { epoch: ea })).toEqual({ ok: true, until: new Date(NOW.getTime() + 490_000) });
    });

    it('CodeRabbit on #1025 (26): a renewal that commits between a beat’s start and its conditional update is not moved back by the beat: the hold keeps the later deadline and the answer says it is held', async () => {
      const { jobId } = await running('s-lease-interleave');
      const ea = await claimed(jobId, 'rA');
      // The hold stands to 90 s. A beat that began at 10 s would move it to 100 s; before that statement runs, a renewal commits 150 s
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 90_000));
      const real = prisma.computerJob.updateMany.bind(prisma.computerJob) as unknown as (args: { where?: { ownerLeaseUntil?: unknown } }) => Promise<unknown>;
      let renewal: Promise<unknown> | undefined;
      const spy = jest.spyOn(prisma.computerJob, 'updateMany').mockImplementation((async (args: { where?: { ownerLeaseUntil?: unknown } }) => {
        // Only the beat's own conditional extension of the hold is held back, once; everything else (the renewal's writes included) goes straight through
        if (!renewal && args?.where?.ownerLeaseUntil !== undefined) {
          renewal = renewJob(jobId, new Date(NOW.getTime() + 60_000), { epoch: ea });
          await renewal;
        }
        return real(args);
      }) as never);
      let beat: Awaited<ReturnType<typeof beatJob>>;
      try {
        beat = await beatJob(jobId, new Date(NOW.getTime() + 10_000), { epoch: ea });
      } finally {
        spy.mockRestore();
      }
      // The renewal did commit the later deadline while the beat was held back, and the beat did not write over it
      expect(renewal).toBeDefined();
      expect(await renewal).toMatchObject({ ok: true });
      expect(beat).toEqual({ ok: true, until: new Date(NOW.getTime() + 150_000), held: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 150_000));
    });

    it('CodeRabbit on #1025 (7, 42): after the owner let the job go, a beat, a renewal and a call admitted on a key made before cannot bring the hold back: the replacement claims at once', async () => {
      const { jobId } = await running('s-lease-after-release');
      const ea = await claimed(jobId, 'rA');
      const key = await keyFor(jobId, ea);
      expect(await releaseJob(jobId, { epoch: ea })).toEqual({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      // The beat that was in flight lands after the release: the owner is told it is still the owner but nothing holds the job
      expect(await beatJob(jobId, new Date(NOW.getTime() + 1_000), { epoch: ea })).toMatchObject({ ok: true, held: false });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      expect(await renewJob(jobId, new Date(NOW.getTime() + 2_000), { epoch: ea })).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      // A key made before the release still works for a call (it is the epoch's key), and its admission holds nothing
      expect(await ask(key, 'cr1', {}, new Date(NOW.getTime() + 3_000))).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      expect(await ask(key, 'cr2', { payer: 'own-key' }, new Date(NOW.getTime() + 4_000))).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      expect(await claimJob(jobId, { run: 'rB', seen: ea }, new Date(NOW.getTime() + 5_000))).toEqual({ ok: true, epoch: ea + 1 });
    });

    it('CodeRabbit on #1025 (25): a call admitted on the owner’s own key is a beat; one that was refused renews nothing', async () => {
      const { jobId } = await running('s-lease-own-key');
      const ea = await claimed(jobId, 'rA');
      const at = new Date(NOW.getTime() + 60_000);
      expect(await ask(await keyFor(jobId, ea), 'ck1', { payer: 'own-key' }, at)).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(at.getTime() + 90_000));
      expect(await claimJob(jobId, { run: 'rB', seen: ea }, new Date(NOW.getTime() + 91_000))).toMatchObject({ ok: false, reason: 'held' });
      // A refused one (a bad key) writes nothing
      const before = (await jobOf(jobId)).ownerLeaseUntil;
      expect(await ask('not-a-key', 'ck2', { payer: 'own-key' }, new Date(NOW.getTime() + 80_000))).toMatchObject({ ok: false });
      expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(before);
    });

    it('a renewal and an admitted model call are beats too: the owner at work never loses the job to a claim', async () => {
      for (const work of ['renew', 'call'] as const) {
        const { jobId } = await running(`s-lease-${work}`);
        const ea = await claimed(jobId, 'rA');
        const at = new Date(NOW.getTime() + 60_000);
        if (work === 'renew') expect(await renewJob(jobId, at, { epoch: ea })).toMatchObject({ ok: true });
        else expect(await ask(await keyFor(jobId, ea), 'c1', {}, at)).toMatchObject({ ok: true });
        expect((await jobOf(jobId)).ownerLeaseUntil).toEqual(new Date(at.getTime() + 90_000));
        expect(await claimJob(jobId, { run: 'rB', seen: ea }, new Date(NOW.getTime() + 91_000))).toMatchObject({ ok: false, reason: 'held' });
      }
    });

    it('the hold ends when Orbit itself ends the worker’s authority: the person taking the machine and giving it back, and a pause, each leave the job free to claim at once', async () => {
      const { sara, jobId } = await running('s-lease-control');
      const ea = await claimed(jobId, 'rA');
      expect((await jobOf(jobId)).ownerLeaseUntil).not.toBeNull();
      expect((await takeOver(sara.brickId, sara.id, new Date(NOW.getTime() + 10_000))).ok).toBe(true);
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      expect((await handBack(sara.brickId, sara.id)).ok).toBe(true);
      // The runner that picks the job up after the hand-back claims it at once, with no wait
      const eb = await claimJob(jobId, { run: 'rB', seen: (await jobOf(jobId)).ownerEpoch }, new Date(NOW.getTime() + 20_000));
      expect(eb).toMatchObject({ ok: true });
      void ea;
      // A pause ends the worker's authority too (its epoch moves): the job that carries on is claimed at once
      const controls = await import('@/lib/computer-job-controls');
      expect((await controls.pauseJob(sara.brickId, sara.id, jobId, new Date(NOW.getTime() + 30_000))).ok).toBe(true);
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
    });

    it('a job nobody has claimed is free (epoch 0 holds nothing), and a beat or a release for a job that is over writes nothing', async () => {
      const { jobId } = await running('s-lease-fresh');
      expect((await jobOf(jobId)).ownerLeaseUntil).toBeNull();
      expect(await claimJob(jobId, { run: 'rA', seen: 0 }, NOW)).toEqual({ ok: true, epoch: 1 });
      const over = await running('s-lease-over');
      const ec = await claimed(over.jobId, 'rA');
      await finishJobUnder(over.jobId, null, 'done', minutes(1), null, null, null, 'rA', ec);
      expect(await beatJob(over.jobId, minutes(2), { epoch: ec })).toEqual({ ok: false, reason: 'over' });
      expect(await beatJob('does-not-exist', minutes(2), { epoch: 1 })).toEqual({ ok: false, reason: 'not_found' });
    });
  });
  describe('CodeRabbit on #1025: effects outside the computer are the owner’s, a handover is decided under the job’s row, a start is let go only by the request that made it', () => {
    const SUPERSEDED_ANSWER = { ok: false, reason: 'stale', run: 'superseded' };

    it('N2: a worker that was replaced plans nothing (a new key, or an approved or failed one); the owner, and a worker that knows no epoch on a job nobody claimed, still plan', async () => {
      const { jobId } = await running('s-n2');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect(await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: ea })).toEqual(SUPERSEDED_ANSWER);
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
      // A key the new owner tried and confirmed not done: the old worker may not claim it again
      await prisma.computerEffect.create({ data: { jobId, effectKey: 'send-2', kind: 'send', state: 'failed' } });
      expect(await planEffect(jobId, { key: 'send-2', kind: 'send' }, { epoch: ea })).toEqual(SUPERSEDED_ANSWER);
      expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: 'send-2' } } })).state).toBe('failed');
      // A worker that names no epoch is not the owner of a claimed job either
      expect(await planEffect(jobId, { key: 'send-3', kind: 'send' }, { epoch: null })).toEqual(SUPERSEDED_ANSWER);
      // CONTROL: the owner plans (a new key, and the failed one again), and says it twice
      expect(await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: eb })).toEqual({ ok: true, already: false });
      expect(await planEffect(jobId, { key: 'send-2', kind: 'send' }, { epoch: eb })).toEqual({ ok: true, already: false });
      expect(await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: eb })).toMatchObject({ ok: false, reason: 'look_up' });
      // CONTROL: a job nobody claimed, and a worker that names no epoch
      const legacy = await running('s-n2-legacy');
      expect(await planEffect(legacy.jobId, { key: 'k', kind: 'send' }, { epoch: null })).toEqual({ ok: true, already: false });
      expect(await planEffect(legacy.jobId, { key: 'k2', kind: 'send' }, { epoch: 3 })).toEqual(SUPERSEDED_ANSWER);
    });

    it('N2: the owner is decided in the write that plans, not in the read before it: B claims between the two, and A’s plan is superseded with nothing written', async () => {
      const { jobId } = await running('s-n2-race');
      const ea = await claimed(jobId, 'rA');
      const real = prisma.computerEffect.findUnique.bind(prisma.computerEffect) as unknown as (args: unknown) => Promise<unknown>;
      let claimedNow = false;
      const spy = jest.spyOn(prisma.computerEffect, 'findUnique').mockImplementation(((args: unknown) => {
        if (claimedNow) return real(args);
        claimedNow = true;
        return takeOverClaim(jobId, 'rB', ea, minutes(1)).then(() => real(args));
      }) as never);
      let answer: unknown;
      try {
        answer = await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: ea });
      } finally {
        spy.mockRestore();
      }
      expect(claimedNow).toBe(true);
      expect(answer).toEqual(SUPERSEDED_ANSWER);
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
    });

    it('N3: a worker that was replaced settles nothing (the effect stays planned, no give-back is flagged late); the owner settles it, and Orbit’s own trusted path still can', async () => {
      const { jobId } = await running('s-n3');
      const ea = await claimed(jobId, 'rA');
      expect(await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: ea })).toEqual({ ok: true, already: false });
      expect(await planEffect(jobId, { key: 'send-2', kind: 'send' }, { epoch: ea })).toEqual({ ok: true, already: false });
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect(await settleEffectAs(jobId, 'send-1', 'done', 'sent', { epoch: ea })).toEqual({ ok: false, superseded: true });
      expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: 'send-1' } } })).state).toBe('planned');
      expect(await settleEffectAs(jobId, 'send-1', 'done', 'sent', { epoch: null })).toEqual({ ok: false, superseded: true });
      // CONTROL: the owner settles it, once
      expect(await settleEffectAs(jobId, 'send-1', 'done', 'sent', { epoch: eb })).toEqual({ ok: true, superseded: false });
      expect(await settleEffectAs(jobId, 'send-1', 'done', 'sent', { epoch: eb })).toEqual({ ok: false, superseded: false });
      // CONTROL: the trusted reconciliation path (no worker named) settles what a worker that is gone left planned
      expect(await settleEffect(jobId, 'send-2', 'failed', 'not sent')).toBe(true);
      expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: 'send-2' } } })).state).toBe('failed');
    });

    it('N3: the owner is decided in the write that settles: B claims while A’s settle waits for the job’s row, and the effect stays planned', async () => {
      const { jobId } = await running('s-n3-race');
      const ea = await claimed(jobId, 'rA');
      expect(await planEffect(jobId, { key: 'send-1', kind: 'send' }, { epoch: ea })).toEqual({ ok: true, already: false });
      const holder = holdRow(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: { increment: 1 } } });
      });
      let waiting: ReturnType<typeof settleEffectAs> | undefined;
      try {
        await holder.locked;
        waiting = settleEffectAs(jobId, 'send-1', 'done', 'sent', { epoch: ea });
        expect(await waitForRowWaiter(holder, waiting)).toBe(true);
        holder.release();
        await holder.done;
        expect(await waiting!).toEqual({ ok: false, superseded: true });
        expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: 'send-1' } } })).state).toBe('planned');
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, ...(waiting ? [waiting] : [])]);
      }
    });

    it('N4: a worker that says the relay was unreachable records the fault only while the job still is what it found: a job that is no longer Brick’s, or another owner’s, keeps none; the owner’s is kept once', async () => {
      const { jobId } = await running('s-n4');
      const ea = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', waitingFor: 'signin', control: 'person' } });
      expect(await prepareJob(jobId, RELAY, minutes(1), { run: 'rA', epoch: ea, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'person_has_it' });
      expect(await prisma.computerJobFault.count({ where: { jobId } })).toBe(0);
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'running', waitingFor: null, control: 'brick' } });
      const eb = await claimed(jobId, 'rB', minutes(2));
      expect(await prepareJob(jobId, RELAY, minutes(3), { run: 'rA', epoch: ea, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'superseded' });
      expect(await prisma.computerJobFault.count({ where: { jobId } })).toBe(0);
      // CONTROL: the owner's is kept, once
      expect(await prepareJob(jobId, RELAY, minutes(4), { run: 'rB', epoch: eb, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
      expect(await prepareJob(jobId, RELAY, minutes(5), { run: 'rB', epoch: eb, relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
      expect(await prisma.computerJobFault.count({ where: { jobId, reason: 'relay_unreachable' } })).toBe(1);
    });

    it('the turn a stream cleared when its start never named one (and the one it cleared when the turn was found over) is the worker’s own: after B claims, A’s clears leave B’s turn', async () => {
      // The clear that follows `activeTurn` finding no turn
      const { jobId } = await running('s-clear-1');
      const ea = await claimed(jobId, 'rA');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-A', agentSessionId: 'sess-A' } });
      const active = jest.spyOn(fake, 'activeTurn').mockImplementation(async () => {
        await claimed(jobId, 'rB', minutes(2));
        return null;
      });
      try {
        await startTurn(jobId, 'carry on', new AbortController().signal, { epoch: ea });
      } finally {
        active.mockRestore();
      }
      // `claimJob` keeps the response id it moves to the new epoch: A's clear (made under A's epoch) must not match it
      expect((await jobOf(jobId)).agentResponseId).toBe('resp-A');
    });

    it('handover (E4): a handover reads the job under its row lock, so one that waited behind a newer stretch counts that stretch (never the one it would have read before waiting) and no second is counted twice; with no interleaving it lands', async () => {
      const { jobId } = await running('s-handover-stale');
      const ea = await claimed(jobId, 'rA');
      // While the handover waits for the row, a newer handover and a note move the job: it has run 90 s before a stretch that began at minute 2
      const holder = holdRow(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { secondsRun: 90, stretchStarted: minutes(2), handoverSeq: { increment: 1 } } });
      });
      let waiting: ReturnType<typeof requestHandoverAs> | undefined;
      try {
        await holder.locked;
        waiting = requestHandoverAs(jobId, 'signin', minutes(5), null, { epoch: ea });
        expect(await waitForRowWaiter(holder, waiting)).toBe(true);
        holder.release();
        await holder.done;
        const landed = await waiting!;
        expect(landed.refused).toBeNull();
        // 90 s already counted + the 3 minutes since the stretch the job is in began (read AFTER the wait, never the 5 minutes of the stretch read before it)
        expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', waitingFor: 'signin', secondsRun: 90 + 180 });
        // CONTROL: asked again while it waits, it is the same wait (nothing counted twice)
        const again = await requestHandoverAs(jobId, 'upload', minutes(6), null, { epoch: ea });
        expect(again.refused).toBeNull();
        expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', waitingFor: 'upload', secondsRun: 90 + 180 });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, ...(waiting ? [waiting] : [])]);
      }
    });

    it('handover: the write that lands the wait names the very `secondsRun` and `stretchStarted` it read (behind the row lock: belt and braces against a delayed worker)', async () => {
      const { jobId } = await running('s-handover-where');
      const ea = await claimed(jobId, 'rA');
      const before = await jobOf(jobId);
      const wheres: Array<Record<string, unknown>> = [];
      const realTx = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
      // The handover writes on its transaction client: each `updateMany` it sends there is recorded, with the condition it names
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        const first = args[0];
        if (typeof first !== 'function') return realTx(...args);
        const wrapped = async (tx: { computerJob: { updateMany: (input: { where?: Record<string, unknown> }) => Promise<unknown> } }) => {
          const inner = tx.computerJob.updateMany.bind(tx.computerJob);
          tx.computerJob.updateMany = ((input: { where?: Record<string, unknown> }) => {
            if (input?.where) wheres.push(input.where);
            return inner(input);
          }) as never;
          return (first as (client: unknown) => Promise<unknown>)(tx);
        };
        return realTx(wrapped, ...args.slice(1));
      }) as never);
      try {
        expect((await requestHandoverAs(jobId, 'signin', minutes(5), null, { epoch: ea })).refused).toBeNull();
      } finally {
        spy.mockRestore();
      }
      const landing = wheres.find((where) => where.status === 'running' && where.control === 'brick');
      expect(landing).toBeDefined();
      expect(landing).toMatchObject({ secondsRun: before.secondsRun, stretchStarted: before.stretchStarted, ownerEpoch: ea });
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', waitingFor: 'signin' });
    });

    it('handover: a finish intent that commits while the handover waits for the job’s row is seen by its write, so the job is not put to waiting', async () => {
      const { jobId } = await running('s-handover-intent');
      const ea = await claimed(jobId, 'rA');
      const holder = holdRow(jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId, outcome: 'done', turns: [] } });
      });
      let waiting: ReturnType<typeof requestHandoverAs> | undefined;
      try {
        await holder.locked;
        waiting = requestHandoverAs(jobId, 'signin', minutes(2), null, { epoch: ea });
        expect(await waitForRowWaiter(holder, waiting)).toBe(true);
        holder.release();
        await holder.done;
        await waiting!;
        expect(await jobOf(jobId)).toMatchObject({ status: 'running', waitingFor: null });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, ...(waiting ? [waiting] : [])]);
      }
    });

    it('N13: the same start key said twice shares one attempt: the second request’s trouble does not let the first one’s attempt go, and the first still makes its job', async () => {
      const sara = await person('s-n13');
      await giveComputer(sara.brickId, sara.id);
      const key = `key-${randomUUID()}`;
      // The first request opened the attempt and is still going on (its attempt stays open); the second finds it and meets a read that fails
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: key, state: 'open', beatAt: new Date() } });
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockRejectedValueOnce(new Error('a read failed'));
      try {
        await expect(startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: key }, NOW)).rejects.toThrow('a read failed');
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.computerStartAttempt.findUniqueOrThrow({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey: key } } })).state).toBe('open');
      // CONTROL: a request that made its own attempt and failed lets it go
      const own = `key-${randomUUID()}`;
      const spy2 = jest.spyOn(prisma.brickComputer, 'findUnique').mockRejectedValueOnce(new Error('a read failed'));
      try {
        await expect(startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: own }, NOW)).rejects.toThrow('a read failed');
      } finally {
        spy2.mockRestore();
      }
      expect((await prisma.computerStartAttempt.findUniqueOrThrow({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey: own } } })).state).toBe('expired');
    });

    it('a sweep that completes a finish intent starts the next job at its real start, not at the intent’s time: its room, lease and expiry begin now', async () => {
      const { sara, jobId } = await running('s-successor');
      await giveComputer(sara.brickId, sara.id);
      const ea = await claimed(jobId, 'rA');
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next' }, minutes(1));
      expect(next.ok && next.job.status).toBe('queued');
      expect(await recordFinishIntent(jobId, { outcome: 'done', epoch: ea, turns: [] })).toMatchObject({ ok: true });
      // The intent was kept at minute 3; the sweep that completes it runs 30 minutes later
      const intentAt = minutes(3);
      await prisma.computerFinishIntent.update({ where: { jobId }, data: { createdAt: intentAt } });
      const sweptAt = new Date(intentAt.getTime() + 30 * 60_000);
      expect(await completeFinishIntents(sweptAt, 10)).toBe(1);
      const started = await prisma.computerJob.findUniqueOrThrow({ where: { id: next.ok ? next.job.id : '' } });
      expect(started.status).toBe('running');
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: started.reservationKey! } });
      // The successor's lease starts when it started (the sweep's time), not 30 minutes earlier at the intent's
      expect(room.createdAt.getTime()).toBe(sweptAt.getTime());
      expect(room.expiresAt.getTime()).toBeGreaterThan(sweptAt.getTime());
    });
  });
});
