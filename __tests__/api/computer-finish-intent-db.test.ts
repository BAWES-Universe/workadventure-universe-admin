/**
 * The runner's committed word that a computer job is to end (GPT round 4, R2): kept before the runner gives up, so a replacement runner or the sweep completes the finish and nothing else runs on the job meanwhile.
 * Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-finish-intent-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { FINISH_INTENT_GRACE_MS, claimJob, completeFinishIntents, finishJob, finishJobUnder, getJob, giveComputer, handBack, recordFinishIntent, renewJob, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { prepareJob, startTurn } from '@/lib/computer-broker';
import { mintJobToken, revokeJobTokens, verifyJobToken } from '@/lib/computer-token';
import { authorizeModelCall, cutoffEndsFinished, cutoffLockKey, callRoomKey, settleModelCall } from '@/lib/computer-calls';
import { POOL_CUTOFF_CALL, hasFinishIntent, hasOwnKeyCall, recordFaults, recordPoolCutoff, type FaultInput } from '@/lib/computer-faults';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { cancelJob } from '@/lib/computer-job-controls';

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

let callNo = 0;
/** A fault row of the relay as the game sends it: `relay_down` is ours (confirmed), `field_job_set` is the person's own doing. */
const fault = (turn: number, reason: 'relay_down' | 'field_job_set', run: string): FaultInput => ({ turn, callId: `turn:${turn}~${++callNo}`, kind: reason === 'relay_down' ? 'fault' : 'not_ours', reason, source: 'universe-ai', route: 'universe-ai/model-a', at: new Date(), run });

/** A running job whose run `runa` had the person's own doing in its turn 1 and whose run `runb` had OUR relay down in its turn 1: the give-back follows the run and the turns the runner names, and nothing else. */
async function twoRuns(name: string) {
  const made = await running(name);
  await recordFaults(made.sara.brickId, made.jobId, [fault(1, 'field_job_set', 'runa'), fault(1, 'relay_down', 'runb')]);
  return made;
}

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const decisionOf = (jobId: string) => prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
/** What a job leaves in the books and its give-back record: the same after a finish said twice. */
const ledgerOf = async (jobId: string) => ({
  events: await prisma.meterEvent.count({ where: { jobId } }),
  timeEvents: await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:time` } }),
  rooms: await prisma.meterReservation.count({ where: { jobId } }),
  settled: await prisma.meterReservation.count({ where: { jobId, state: 'settled' } }),
  decisions: await prisma.computerGiveBackDecision.count({ where: { jobId } }),
});

run('the runner’s committed word that a job is to end, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(new FakeComputerProvider());
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

  /** A barrier, not a delay: waits (bounded) until some session is blocked on this advisory lock. */
  const waitingOn = async (key: string): Promise<boolean> => {
    for (let tries = 0; tries < 250; tries += 1) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`;
      if (rows[0].n > 0) return true;
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

  describe('the intent', () => {
    it('is kept once (the first wins), ends every key of the job in the same transaction, and shows as finishPending on the job while it is on', async () => {
      const { jobId } = await running();
      const model = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const git = (await mintJobToken(jobId, 'git', NOW)) as { token: string };
      expect((await verifyJobToken(model.token, 'model', NOW)).ok).toBe(true);
      expect((await getJob(jobId))?.finishPending).toBeNull();
      const first = await recordFinishIntent(jobId, { outcome: 'failed', cause: 'agent', why: 'It gave up', turns: [2, 3], run: 'r1', generation: 0 }, minutes(1));
      expect(first).toMatchObject({ ok: true, already: false, pending: { outcome: 'failed', cause: 'agent', run: 'r1', generation: 0, at: minutes(1) } });
      // Every key of the job ended with it, whatever its scope
      expect((await verifyJobToken(model.token, 'model', NOW)).ok).toBe(false);
      expect((await verifyJobToken(git.token, 'git', NOW)).ok).toBe(false);
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
      expect(await hasFinishIntent(prisma, jobId)).toBe(true);
      // The job shows what is still to be finished
      expect(await getJob(jobId)).toMatchObject({ status: 'running', controlGeneration: 0, finishPending: { outcome: 'failed', cause: 'agent', run: 'r1', generation: 0 } });
      // Said again, with something else: the first is what is kept
      const second = await recordFinishIntent(jobId, { outcome: 'done', run: 'r2' }, minutes(2));
      expect(second).toMatchObject({ ok: true, already: true, pending: { outcome: 'failed', cause: 'agent', run: 'r1', at: minutes(1) } });
      expect(await prisma.computerFinishIntent.count({ where: { jobId } })).toBe(1);
      expect(await prisma.computerFinishIntent.findUniqueOrThrow({ where: { jobId } })).toMatchObject({ outcome: 'failed', cause: 'agent', why: 'It gave up', turns: [2, 3], run: 'r1', generation: 0 });
    });

    it('refuses every new key, every prepare and every new turn for the job from then on, never as an error of the job: `finish_pending`', async () => {
      const { jobId } = await running();
      await recordFinishIntent(jobId, { outcome: 'done' }, NOW);
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await mintJobToken(jobId, 'git', NOW)).toEqual({ ok: false, reason: 'finish_pending' });
      // A key made and refused is ended at once, never left good
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await startTurn(jobId, 'carry on')).toEqual({ ok: false, reason: 'finish_pending' });
    });

    it('authorizes no call after it, on either payer: nothing is held, no marker is kept, and a call waiting for the lock while it commits is refused', async () => {
      const funded = await running('fia');
      const fundedKey = (await mintJobToken(funded.jobId, 'model', NOW)) as { token: string };
      const own = await running('oti');
      const ownKey = (await mintJobToken(own.jobId, 'model', NOW)) as { token: string };
      await recordFinishIntent(funded.jobId, { outcome: 'done' }, NOW);
      await recordFinishIntent(own.jobId, { outcome: 'done' }, NOW);
      expect(await authorizeModelCall({ token: fundedKey.token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(funded.jobId, 'c1') } })).toBe(0);
      expect(await authorizeModelCall({ token: ownKey.token, callId: 'o1', estimateMicros: 1, payer: 'own-key' }, NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await hasOwnKeyCall(prisma, own.jobId)).toBe(false);
      // The race itself: an own-key call that passed its first look at the key waits for the cutoff lock while the intent commits (keys ended in that same transaction): refused, no marker
      const racing = await running('rac');
      const racingKey = (await mintJobToken(racing.jobId, 'model', NOW)) as { token: string };
      const holder = holdCutoff(racing.jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId: racing.jobId, outcome: 'done', turns: [], createdAt: NOW } });
        await revokeJobTokens(racing.jobId, NOW, undefined, tx);
      });
      let call: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        call = authorizeModelCall({ token: racingKey.token, callId: 'o1', estimateMicros: 1, payer: 'own-key' }, NOW);
        expect(await waitingOn(cutoffLockKey(racing.jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await call).toEqual({ ok: false, reason: 'refused' });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, call]);
      }
      expect(await hasOwnKeyCall(prisma, racing.jobId)).toBe(false);
      // The intent alone refuses it, whatever state the key is in (the check does not lean on the keys having been ended)
      const alone = await running('alo');
      const aliveKey = (await mintJobToken(alone.jobId, 'model', NOW)) as { token: string };
      await prisma.computerFinishIntent.create({ data: { jobId: alone.jobId, outcome: 'done', turns: [], createdAt: NOW } });
      expect(await prisma.computerJobToken.count({ where: { jobId: alone.jobId, revokedAt: null } })).toBe(1);
      expect(await authorizeModelCall({ token: aliveKey.token, callId: 'o1', estimateMicros: 1, payer: 'own-key' }, NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await hasOwnKeyCall(prisma, alone.jobId)).toBe(false);
    });

    it('answers `stale` and keeps nothing for a job that is over, one that never started, and one on another control generation than the runner’s', async () => {
      const over = await running('ove');
      await finishJob(over.jobId, 'done', minutes(1));
      expect(await recordFinishIntent(over.jobId, { outcome: 'done' }, minutes(2))).toEqual({ ok: false, reason: 'stale' });
      expect(await prisma.computerFinishIntent.count({ where: { jobId: over.jobId } })).toBe(0);
      // A job in line: nothing ran, so nothing is committed
      const line = await person('lin');
      await giveComputer(line.brickId, line.id);
      await setUp({ memberAllowanceMicros: 1 });
      const queued = await startJob({ botId: line.brickId, personId: line.id, title: 'Queued' }, NOW);
      if (!queued.ok) throw new Error('no job');
      expect(queued.job.status).toBe('queued');
      expect(await recordFinishIntent(queued.job.id, { outcome: 'failed' }, NOW)).toEqual({ ok: false, reason: 'stale' });
      await setUp();
      // The person took the machine and handed it back since the runner read its generation: a newer controller owns the job
      const moved = await running('mov');
      expect((await getJob(moved.jobId))?.controlGeneration).toBe(0);
      await takeOver(moved.sara.brickId, moved.sara.id, minutes(1));
      await handBack(moved.sara.brickId, moved.sara.id);
      const generation = (await getJob(moved.jobId))!.controlGeneration;
      expect(generation).toBeGreaterThan(0);
      expect(await recordFinishIntent(moved.jobId, { outcome: 'failed', generation: 0 }, minutes(2))).toEqual({ ok: false, reason: 'stale' });
      expect(await prisma.computerFinishIntent.count({ where: { jobId: moved.jobId } })).toBe(0);
      expect((await mintJobToken(moved.jobId, 'model', minutes(2))).ok).toBe(true);
      // Said under the generation it is on now, it is kept
      expect(await recordFinishIntent(moved.jobId, { outcome: 'failed', generation }, minutes(3))).toMatchObject({ ok: true, already: false });
      expect(await recordFinishIntent(randomUUID(), { outcome: 'done' }, NOW)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('a decided pool cutoff wins: before the intent it keeps the intent out (`cutoff`), after it the finish still ends the job as pool', async () => {
      const before = await running('bef');
      await recordPoolCutoff(prisma, before.jobId, NOW);
      expect(await recordFinishIntent(before.jobId, { outcome: 'done' }, minutes(1))).toEqual({ ok: false, reason: 'cutoff' });
      expect(await prisma.computerFinishIntent.count({ where: { jobId: before.jobId } })).toBe(0);
      expect(await prisma.computerJobToken.count({ where: { jobId: before.jobId, revokedAt: null } })).toBe(0);
      await finishJob(before.jobId, 'done', minutes(2));
      expect(await jobOf(before.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      // The intent came first, the cutoff was decided after it (a call that was already past its key): the finish ends as pool all the same
      const after = await running('aft');
      expect(await recordFinishIntent(after.jobId, { outcome: 'done' }, NOW)).toMatchObject({ ok: true });
      await recordPoolCutoff(prisma, after.jobId, minutes(1));
      await finishJob(after.jobId, 'done', minutes(2));
      expect(await jobOf(after.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', endNote: POOL_BUSY_WORDS });
      expect(await decisionOf(after.jobId)).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
      // The sweep too: an intent completed after a cutoff was decided is the pool's ending
      const swept = await running('swe');
      await recordFinishIntent(swept.jobId, { outcome: 'done' }, NOW);
      await recordPoolCutoff(prisma, swept.jobId, minutes(1));
      expect(await completeFinishIntents(minutes(10), 50)).toBeGreaterThanOrEqual(1);
      expect(await jobOf(swept.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      expect(await prisma.computerJobFault.count({ where: { jobId: swept.jobId, callId: POOL_CUTOFF_CALL } })).toBe(1);
    });

    it('the intent and a cutoff that waits for the same lock never both stand: whichever takes the lock first decides, and the other answers for it', async () => {
      // The intent waits for the lock while a cutoff decides (record and keys): `cutoff`, nothing kept
      const one = await running('one');
      const holder = holdCutoff(one.jobId, async (tx) => {
        await recordPoolCutoff(tx, one.jobId, NOW);
        await revokeJobTokens(one.jobId, NOW, undefined, tx);
      });
      let intending: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        intending = recordFinishIntent(one.jobId, { outcome: 'done' }, minutes(1));
        expect(await waitingOn(cutoffLockKey(one.jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await intending).toEqual({ ok: false, reason: 'cutoff' });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, intending]);
      }
      expect(await prisma.computerFinishIntent.count({ where: { jobId: one.jobId } })).toBe(0);
    });
  });

  describe('the finish, said again and from another runner', () => {
    it('a finish replayed before and after Orbit committed is the same answer and writes nothing twice: one ending, one settlement, one decision, the ledger unchanged', async () => {
      for (const [name, outcome, cause, expected] of [['fin-done', 'done', undefined, 'done'], ['fin-ours', 'failed', 'ours', 'failed'], ['fin-agent', 'failed', 'agent', 'failed']] as const) {
        const { jobId } = await running(name);
        await recordFinishIntent(jobId, { outcome, cause }, minutes(1));
        // The first finish is lost before it reaches Orbit: the replacement's finish is the first Orbit sees
        const first = await finishJobUnder(jobId, 0, outcome, minutes(2), outcome === 'failed' ? 'It gave up' : null, cause);
        expect(first.stale).toBe(false);
        const ended = await jobOf(jobId);
        // Each fixture ends the way its intent said, and writes its time exactly once: the replays below are measured against THAT
        expect(ended.status).toBe(expected);
        const ledger = await ledgerOf(jobId);
        const decision = await decisionOf(jobId);
        expect(ledger.timeEvents).toBe(1);
        // The ack of that finish is lost, so the same finish comes again (after Orbit committed), and again from yet another process, at later times
        for (const at of [minutes(3), minutes(30), minutes(60 * 24)]) {
          const again = await finishJobUnder(jobId, 0, outcome, at, outcome === 'failed' ? 'It gave up' : null, cause);
          expect(again.stale).toBe(false);
          expect(again.job).toMatchObject({ status: ended.status });
        }
        expect(await jobOf(jobId)).toMatchObject({ status: ended.status, endedBy: ended.endedBy, secondsRun: ended.secondsRun, runnerFault: ended.runnerFault });
        expect(await ledgerOf(jobId)).toEqual(ledger);
        expect(await decisionOf(jobId)).toEqual(decision);
        // The job is over: it no longer shows a finish pending, and nothing can be committed to it
        expect((await getJob(jobId))?.finishPending).toBeNull();
        expect(await recordFinishIntent(jobId, { outcome }, minutes(5))).toEqual({ ok: false, reason: 'stale' });
      }
    });

    it('a finish from an older control generation answers `stale` and changes nothing; one that says none, or the current one, is the finish as before', async () => {
      const { sara, jobId } = await running();
      await takeOver(sara.brickId, sara.id, minutes(1));
      await handBack(sara.brickId, sara.id);
      const current = (await getJob(jobId))!.controlGeneration;
      expect(current).toBeGreaterThan(0);
      const before = await ledgerOf(jobId);
      const stale = await finishJobUnder(jobId, 0, 'failed', minutes(2), 'Stopped', 'agent');
      expect(stale).toMatchObject({ stale: true, job: { id: jobId, status: 'running' } });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      expect(await ledgerOf(jobId)).toEqual(before);
      // A runner that says no generation (0.4.3’s) finishes it as it always did
      const plain = await finishJobUnder(jobId, undefined, 'done', minutes(3));
      expect(plain).toMatchObject({ stale: false, job: { status: 'done' } });
      expect((await jobOf(jobId)).status).toBe('done');
    });

    it('a fresh runner can finish what another committed to, with a newer valid generation of the job: the finish is the normal one, the intent is history, and nothing ran in between', async () => {
      const { sara, jobId } = await running();
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await recordFinishIntent(jobId, { outcome: 'done', generation: 0 }, minutes(1));
      // The person takes the machine and gives it back: the job is on a newer generation, the intent still holds, and the keys stay ended
      await takeOver(sara.brickId, sara.id, minutes(2));
      await handBack(sara.brickId, sara.id);
      const generation = (await getJob(jobId))!.controlGeneration;
      expect(await getJob(jobId)).toMatchObject({ finishPending: { outcome: 'done', generation: 0 } });
      expect((await verifyJobToken(key.token, 'model', minutes(2))).ok).toBe(false);
      expect(await mintJobToken(jobId, 'model', minutes(2))).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await prepareJob(jobId, RELAY, minutes(2))).toEqual({ ok: false, reason: 'finish_pending' });
      // The replacement reads finishPending and the generation, and sends the finish under the generation it read
      expect(await finishJobUnder(jobId, generation, 'done', minutes(3))).toMatchObject({ stale: false, job: { status: 'done' } });
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect(await prisma.computerJob.count({ where: { id: jobId } })).toBe(1);
    });
  });

  describe('GPT round 4, third note, R2b: a stop for the pool and the admission of a call are decided under ONE lock, so exactly one of them wins', () => {
    const POOL_STOP = { outcome: 'failed' as const, cause: 'ours' as const, basis: 'pool' as const, why: 'The pool had no room', turns: [1], run: 'r1' };
    const ask = (token: string, callId: string, over: Partial<Parameters<typeof authorizeModelCall>[0]> = {}, at: Date = NOW) => authorizeModelCall({ token, callId, estimateMicros: 5_000, payer: 'universe', turn: 1, run: 'r1', ...over }, at);
    /** One call of the job refused for OUR capacity (below the two that decide a cutoff), then the pool is back. */
    const refusedOnce = async (jobId: string, token: string) => {
      await setUp({ poolCeilingMicros: 1 });
      expect(await ask(token, 'c1')).toMatchObject({ ok: false, reason: 'pool', full: true });
      await setUp();
    };
    const held = (jobId: string) => prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') }, state: 'held' } });
    const admissions = (jobId: string) => prisma.computerJobFault.findMany({ where: { jobId, reason: 'turn_admitted' }, orderBy: { turn: 'asc' }, select: { turn: true, run: true, kind: true } });
    const waiters = async (key: string): Promise<number> => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
    const waitForWaiters = async (key: string, n: number): Promise<boolean> => {
      for (let tries = 0; tries < 250; tries += 1) {
        if ((await waiters(key)) >= n) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };

    it('ADMISSION FIRST (GPT’s repro): the pool refused, the pool is back, a funded call is admitted (5,000 held); the late stop answers `stale` and writes nothing: keys live, the job goes on, the call settles, the ending is the turn’s own and the wallet is a normal charge', async () => {
      const { sara, jobId } = await running('s-adm');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await refusedOnce(jobId, key.token);
      expect(await ask(key.token, 'c2', {}, minutes(1))).toMatchObject({ ok: true, reservedMicros: 5_000 });
      expect(await held(jobId)).toBe(1);
      expect(await admissions(jobId)).toEqual([{ turn: 1, run: 'r1', kind: 'answered' }]);
      // The stop (decided on the refusal, delayed past the game's 8 s) reaches Orbit now
      expect(await recordFinishIntent(jobId, POOL_STOP, minutes(2))).toEqual({ ok: false, reason: 'stale' });
      expect(await hasFinishIntent(prisma, jobId)).toBe(false);
      // Nothing was cancelled: the job is on, its key is good, the room is still held, no cutoff and no ending of any kind
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      expect((await verifyJobToken(key.token, 'model', minutes(2))).ok).toBe(true);
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(1);
      expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
      expect(await held(jobId)).toBe(1);
      // The call settles against the room it was given, and the job ends as the turn did
      expect(await settleModelCall(jobId, 'c2', { costMicros: 3_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, minutes(3))).toEqual({ ok: true });
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c2') } })).toMatchObject({ state: 'settled' });
      await finishJobUnder(jobId, 0, 'done', minutes(4));
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      // The wallet: the call is a normal charge on the person, never a give-back
      expect(await prisma.meterEvent.count({ where: { jobId, kind: 'model_call' } })).toBe(1);
      expect(await prisma.computerGiveBackDecision.count({ where: { jobId, personId: sara.id } })).toBe(0);
      expect(await held(jobId)).toBe(0);
    });

    it('the same after the tentative 30 s fence expired: no intent, no cancel, no failed ending, however late the stop arrives', async () => {
      const { jobId } = await running('s-fence');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await refusedOnce(jobId, key.token);
      expect(await ask(key.token, 'c2', {}, new Date(NOW.getTime() + 1_000))).toMatchObject({ ok: true });
      for (const late of [new Date(NOW.getTime() + 31_000), minutes(5), minutes(30)]) {
        expect(await recordFinishIntent(jobId, POOL_STOP, late)).toEqual({ ok: false, reason: 'stale' });
      }
      expect(await prisma.computerFinishIntent.count({ where: { jobId } })).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(1);
      expect(await held(jobId)).toBe(1);
    });

    it('STOP FIRST: the intent commits, then the relay asks to admit: refused at the key, the room goes back (0 held), no admission is kept; a replacement completes ONE failed ending as ours and the wallet is given back', async () => {
      const { jobId } = await running('s-stop');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await refusedOnce(jobId, key.token);
      expect(await recordFinishIntent(jobId, POOL_STOP, minutes(1))).toMatchObject({ ok: true, already: false });
      expect(await ask(key.token, 'c2', {}, minutes(2))).toEqual({ ok: false, reason: 'refused' });
      expect(await held(jobId)).toBe(0);
      expect(await admissions(jobId)).toEqual([]);
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
      // The replacement (or the sweep) reads finishPending and ends it once, as the intent said
      expect((await getJob(jobId))?.finishPending).toMatchObject({ outcome: 'failed', cause: 'ours', run: 'r1' });
      await finishJobUnder(jobId, 0, 'done', minutes(3));
      expect(await jobOf(jobId)).toMatchObject({ status: expect.stringMatching(/^(failed|stopped)$/) });
      expect(await prisma.meterEvent.count({ where: { jobId, kind: 'model_call' } })).toBe(0);
      expect(await held(jobId)).toBe(0);
    });

    it('the admission’s final check TAKES the cutoff lock, with or without a refusal of ours kept: an admission waits for a stop that is deciding, and a stop that won refuses it', async () => {
      // No pool refusal anywhere on this job: the lock is still taken
      const { jobId } = await running('s-lock');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId, outcome: 'failed', cause: 'ours', turns: [1], run: 'r1', createdAt: NOW } });
        await revokeJobTokens(jobId, NOW, undefined, tx);
      });
      let admit: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        admit = ask(key.token, 'c1');
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await admit).toEqual({ ok: false, reason: 'refused' });
        expect(await held(jobId)).toBe(0);
        expect(await admissions(jobId)).toEqual([]);
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, admit]);
      }
    });

    it('a kept intent, or a decided cutoff, refuses an admission on its own, whatever the keys say (the checks inside the lock do not lean on the key revocation)', async () => {
      const intent = await running('s-raw-i');
      const k1 = (await mintJobToken(intent.jobId, 'model', NOW)) as { token: string };
      // An intent row that did NOT revoke anything (a fixture): the admission still refuses and leaves nothing
      await prisma.computerFinishIntent.create({ data: { jobId: intent.jobId, outcome: 'done', turns: [], createdAt: NOW } });
      expect((await verifyJobToken(k1.token, 'model', NOW)).ok).toBe(true);
      expect(await ask(k1.token, 'c1')).toEqual({ ok: false, reason: 'refused' });
      expect(await held(intent.jobId)).toBe(0);
      expect(await admissions(intent.jobId)).toEqual([]);
      const cutoff = await running('s-raw-c');
      const k2 = (await mintJobToken(cutoff.jobId, 'model', NOW)) as { token: string };
      await recordPoolCutoff(prisma, cutoff.jobId, NOW);
      expect((await verifyJobToken(k2.token, 'model', NOW)).ok).toBe(true);
      expect(await ask(k2.token, 'c1')).toEqual({ ok: false, reason: 'refused' });
      expect(await held(cutoff.jobId)).toBe(0);
      expect(await admissions(cutoff.jobId)).toEqual([]);
    });

    it('the key is looked at INSIDE the lock: a key that was revoked while the admission waited is never admitted', async () => {
      const { sara, jobId } = await running('s-key');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // The person takes the machine while the admission waits for the cutoff lock: the key ends and the admission must not stand
      const holder = holdCutoff(jobId, async () => undefined);
      let admit: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        admit = ask(key.token, 'c1');
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        await revokeJobTokens(jobId, NOW);
        holder.release();
        await holder.done;
        expect(await admit).toEqual({ ok: false, reason: 'refused' });
        expect(await admissions(jobId)).toEqual([]);
        expect(await held(jobId)).toBe(0);
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, admit]);
      }
      expect(sara.id).toBeTruthy();
    });

    it('A REAL RACE, in both queue orders: the admission queued first wins (the stop is stale, work goes on); the stop queued first wins (the call is refused, its room goes back): never both', async () => {
      for (const order of ['admission-first', 'stop-first'] as const) {
        const { jobId } = await running(`s-q-${order}`);
        const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        const holder = holdCutoff(jobId, async () => undefined);
        let admit: Promise<unknown> = Promise.resolve();
        let stop: Promise<unknown> = Promise.resolve();
        try {
          await holder.ready;
          if (order === 'admission-first') {
            admit = ask(key.token, 'c1');
            expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
            stop = recordFinishIntent(jobId, POOL_STOP, minutes(1));
          } else {
            stop = recordFinishIntent(jobId, POOL_STOP, minutes(1));
            expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
            admit = ask(key.token, 'c1');
          }
          expect(await waitForWaiters(cutoffLockKey(jobId), 2)).toBe(true);
          holder.release();
          await holder.done;
          const [admitted, stopped] = await Promise.all([admit, stop]);
          if (order === 'admission-first') {
            expect(admitted).toMatchObject({ ok: true });
            expect(stopped).toEqual({ ok: false, reason: 'stale' });
            expect(await held(jobId)).toBe(1);
            expect(await hasFinishIntent(prisma, jobId)).toBe(false);
            expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          } else {
            expect(admitted).toEqual({ ok: false, reason: 'refused' });
            expect(stopped).toMatchObject({ ok: true, already: false });
            expect(await held(jobId)).toBe(0);
            expect(await hasFinishIntent(prisma, jobId)).toBe(true);
          }
        } finally {
          holder.release();
          await Promise.allSettled([holder.done, admit, stop]);
        }
      }
    });

    it('50 rounds of a stop and an admission that start at the same moment: EXACTLY one wins every round (never a kept intent with a room held for the turn, never a refused stop with refused work)', async () => {
      let admissionWins = 0;
      let stopWins = 0;
      for (let round = 0; round < 50; round += 1) {
        const { jobId } = await running(`s-r${round}`);
        const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        const go = round % 2 === 0 ? [() => ask(key.token, 'c1'), () => recordFinishIntent(jobId, POOL_STOP, minutes(1))] : [() => recordFinishIntent(jobId, POOL_STOP, minutes(1)), () => ask(key.token, 'c1')];
        const results = await Promise.all(go.map((start) => start()));
        const [admitted, stopped] = (round % 2 === 0 ? results : [results[1], results[0]]) as [Awaited<ReturnType<typeof ask>>, Awaited<ReturnType<typeof recordFinishIntent>>];
        const kept = await hasFinishIntent(prisma, jobId);
        const roomHeld = await held(jobId);
        if (admitted.ok) {
          admissionWins += 1;
          expect({ round, stopped, kept, roomHeld }).toEqual({ round, stopped: { ok: false, reason: 'stale' }, kept: false, roomHeld: 1 });
        } else {
          stopWins += 1;
          expect({ round, admitted, stopped: stopped.ok, kept, roomHeld }).toEqual({ round, admitted: { ok: false, reason: 'refused' }, stopped: true, kept: true, roomHeld: 0 });
        }
      }
      expect(admissionWins + stopWins).toBe(50);
    }, 180_000);

    it('SCOPE: an admission on an EARLIER turn never blocks a later stop; the same turn or a later one does; another run does not; no turn (or no run) is the cautious side', async () => {
      const earlier = await running('s-earlier');
      const k1 = (await mintJobToken(earlier.jobId, 'model', NOW)) as { token: string };
      // A call admitted on turn 1 long ago; the pool-only give-up is on turn 3: the intent is kept and the job stops
      expect(await ask(k1.token, 'c1', { turn: 1 })).toMatchObject({ ok: true });
      expect(await recordFinishIntent(earlier.jobId, { ...POOL_STOP, turns: [3] }, minutes(1))).toMatchObject({ ok: true, already: false });

      const other = await running('s-other');
      const k2 = (await mintJobToken(other.jobId, 'model', NOW)) as { token: string };
      // A call admitted on turn 3 of ANOTHER run does not block a stop on this run
      expect(await ask(k2.token, 'c1', { turn: 3, run: 'r2' })).toMatchObject({ ok: true });
      expect(await recordFinishIntent(other.jobId, { ...POOL_STOP, turns: [3] }, minutes(1))).toMatchObject({ ok: true, already: false });

      const same = await running('s-same');
      const k3 = (await mintJobToken(same.jobId, 'model', NOW)) as { token: string };
      // The same turn (>=), and a later one, block it
      expect(await ask(k3.token, 'c1', { turn: 3 })).toMatchObject({ ok: true });
      expect(await recordFinishIntent(same.jobId, { ...POOL_STOP, turns: [3] }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
      expect(await ask(k3.token, 'c2', { turn: 4 })).toMatchObject({ ok: true });
      expect(await recordFinishIntent(same.jobId, { ...POOL_STOP, turns: [3, 4] }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
      // The earliest turn the stop names decides: turns [4, 5] with an admission on turn 4 is stale, turn 5 alone is past every admission
      expect(await recordFinishIntent(same.jobId, { ...POOL_STOP, turns: [4, 5] }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
      expect(await recordFinishIntent(same.jobId, { ...POOL_STOP, turns: [5] }, minutes(1))).toMatchObject({ ok: true });

      // A call whose turn the relay did not name counts for the stop's turn (the work goes on), and so does a call with no run when the stop names one
      const unnamed = await running('s-unnamed');
      const k4 = (await mintJobToken(unnamed.jobId, 'model', NOW)) as { token: string };
      expect(await authorizeModelCall({ token: k4.token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW)).toMatchObject({ ok: true });
      expect(await recordFinishIntent(unnamed.jobId, { ...POOL_STOP, turns: [9] }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
      expect(await admissions(unnamed.jobId)).toEqual([{ turn: null, run: null, kind: 'answered' }]);
    });

    it('a call on the person’s OWN key is an admission too; a stop that does not rest on the pool (no basis) never reads admissions', async () => {
      const own = await running('s-own');
      const k1 = (await mintJobToken(own.jobId, 'model', NOW)) as { token: string };
      expect(await authorizeModelCall({ token: k1.token, callId: 'o1', estimateMicros: 1, payer: 'own-key', turn: 2, run: 'r1' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
      expect(await recordFinishIntent(own.jobId, { ...POOL_STOP, turns: [2] }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
      // ...with its own turn and run: a stop on a LATER turn of that run is not blocked by it (the row is not a turnless one)
      const later = await running('s-own-later');
      const k3 = (await mintJobToken(later.jobId, 'model', NOW)) as { token: string };
      expect(await authorizeModelCall({ token: k3.token, callId: 'o1', estimateMicros: 1, payer: 'own-key', turn: 2, run: 'r1' }, NOW)).toMatchObject({ ok: true });
      expect(await admissions(later.jobId)).toEqual([{ turn: 2, run: 'r1', kind: 'answered' }]);
      expect(await recordFinishIntent(later.jobId, { ...POOL_STOP, turns: [5] }, minutes(1))).toMatchObject({ ok: true, already: false });

      const plain = await running('s-plain');
      const k2 = (await mintJobToken(plain.jobId, 'model', NOW)) as { token: string };
      expect(await ask(k2.token, 'c1', { turn: 2 })).toMatchObject({ ok: true });
      // Not a pool stop: the runner says the agent itself gave up
      expect(await recordFinishIntent(plain.jobId, { outcome: 'failed', cause: 'agent', turns: [2], run: 'r1' }, minutes(1))).toMatchObject({ ok: true, already: false });
    });

    it('one row per run and turn: a replay of an admitted call, and another call of the same turn, write no second', async () => {
      const { jobId } = await running('s-once');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await ask(key.token, 'c1')).toMatchObject({ ok: true });
      expect(await ask(key.token, 'c1')).toMatchObject({ ok: true });
      expect(await ask(key.token, 'c2')).toMatchObject({ ok: true });
      expect(await admissions(jobId)).toEqual([{ turn: 1, run: 'r1', kind: 'answered' }]);
    });
  });

  describe('GPT round 5, E1-E3 and the fourth note’s R2b-2: ONE owner per job (an epoch moved only by a claim), so a stop, a finish, a prepare or a renewal of a worker that was replaced never ends the replacement’s work', () => {
    const POOL = { outcome: 'failed' as const, cause: 'ours' as const, basis: 'pool' as const, why: 'The pool had no room', turns: [1] };
    const ask = (token: string, callId: string, over: Partial<Parameters<typeof authorizeModelCall>[0]> = {}, at: Date = NOW) => authorizeModelCall({ token, callId, estimateMicros: 5_000, payer: 'universe', turn: 1, run: 'rA', ...over }, at);
    const held = (jobId: string) => prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') }, state: 'held' } });
    /** A runner takes up the job: it names the epoch it last saw (the way the runner does after its GET) and wins only if that is still the job's. Answers the epoch it owns by. */
    const claimed = async (jobId: string, run: string, at: Date = NOW): Promise<number> => {
      const seen = (await jobOf(jobId)).ownerEpoch;
      const won = await claimJob(jobId, { run, seen }, at);
      if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
      return won.epoch;
    };
    /** What a prepare does with its epoch: the model key, made for the owner. */
    const prepared = async (jobId: string, epoch: number, at: Date = NOW) => (await mintJobToken(jobId, 'model', at, { generation: 0 }, { epoch })) as { ok: true; token: string };
    const liveKeys = (jobId: string) => prisma.computerJobToken.count({ where: { jobId, revokedAt: null } });
    const waiters = async (key: string): Promise<number> => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
    const waitForWaiters = async (key: string, n: number): Promise<boolean> => {
      for (let tries = 0; tries < 250; tries += 1) {
        if ((await waiters(key)) >= n) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    /** Worker A met a refusal for the pool, which is back now: the state GPT’s repro starts from. */
    const refusedInA = async (jobId: string, token: string) => {
      await setUp({ poolCeilingMicros: 1 });
      expect(await ask(token, 'c1')).toMatchObject({ ok: false, reason: 'pool', full: true });
      await setUp();
    };

    it('GPT’s REPRO, same job, same control generation, different worker: A refused, B claimed and admitted a funded call (5,000), then A’s delayed pool stop: STALE and superseded, B’s key live, no intent, no cancel; B’s call settles once, B ends its own work, nothing is given back', async () => {
      const { sara, jobId } = await running('s-own-1');
      const ea = await claimed(jobId, 'rA');
      const a = await prepared(jobId, ea);
      await refusedInA(jobId, a.token);
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect(eb).toBe(ea + 1);
      const b = await prepared(jobId, eb, minutes(1));
      expect(await ask(b.token, 'c2', { run: 'rB' }, minutes(1))).toMatchObject({ ok: true, reservedMicros: 5_000 });
      expect(await recordFinishIntent(jobId, { ...POOL, run: 'rA', epoch: ea }, minutes(2))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await hasFinishIntent(prisma, jobId)).toBe(false);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
      expect((await verifyJobToken(b.token, 'model', minutes(2))).ok).toBe(true);
      expect(await liveKeys(jobId)).toBe(1);
      expect(await held(jobId)).toBe(1);
      expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
      expect(await settleModelCall(jobId, 'c2', { costMicros: 3_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, minutes(3))).toEqual({ ok: true });
      expect(await finishJobUnder(jobId, 0, 'done', minutes(4), null, null, null, 'rB', eb)).toMatchObject({ stale: false });
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect(await prisma.meterEvent.count({ where: { jobId, kind: 'model_call' } })).toBe(1);
      expect(await prisma.computerGiveBackDecision.count({ where: { jobId, personId: sara.id } })).toBe(0);
      expect(await held(jobId)).toBe(0);
    });

    it('E2: a finish (done or failed), an intent and a renewal from a worker that is not the owner (an older one, one that never claimed, one that names no epoch) are all superseded and leave B’s key, room, turn and ending intact; the owner’s finish ends it', async () => {
      const { jobId } = await running('s-own-done');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      const b = await prepared(jobId, eb, minutes(1));
      const room = async () => (await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: (await jobOf(jobId)).reservationKey! } })).amountMicros;
      const before = await room();
      for (const epoch of [ea, ea - 1, 99, null, undefined]) {
        const late = await finishJobUnder(jobId, 0, 'done', minutes(2), null, null, null, 'rA', epoch);
        expect(late).toMatchObject({ stale: true, superseded: true });
        expect(late.job).toMatchObject({ status: 'running' });
        // A failed finish with turns is no different
        expect(await finishJobUnder(jobId, 0, 'failed', minutes(2), 'gave up', 'ours', [1], 'rA', epoch)).toMatchObject({ stale: true, superseded: true });
        expect(await recordFinishIntent(jobId, { outcome: 'done', epoch }, minutes(2))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
        expect(await renewJob(jobId, minutes(2), { epoch })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null, endedAt: null });
      expect(await room()).toEqual(before);
      expect(await prisma.computerFinishIntent.count({ where: { jobId } })).toBe(0);
      expect((await verifyJobToken(b.token, 'model', minutes(2))).ok).toBe(true);
      expect(await liveKeys(jobId)).toBe(1);
      // CONTROL: the owner's own renewal, then its finish, go through
      expect(await renewJob(jobId, minutes(2), { epoch: eb })).toMatchObject({ ok: true });
      expect(Number(await room())).toBeGreaterThan(Number(before));
      expect(await finishJobUnder(jobId, 0, 'done', minutes(3), null, null, null, 'rB', eb)).toMatchObject({ stale: false });
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
    });

    it('a stale of the CONTROL GENERATION is told apart from a stale of the OWNER: only the owner’s says `superseded`', async () => {
      const { jobId } = await running('s-own-kinds');
      const ea = await claimed(jobId, 'rA');
      const old = await finishJobUnder(jobId, 7, 'done', minutes(1), null, null, null, 'rA', ea);
      expect(old.stale).toBe(true);
      expect(old.superseded).toBeUndefined();
      expect(await recordFinishIntent(jobId, { outcome: 'done', generation: 7, run: 'rA', epoch: ea }, minutes(1))).toEqual({ ok: false, reason: 'stale' });
    });

    it('the owner is checked in the write that lands the ending, not only in the look before it: a finish that looked (and was the owner) before B claimed still ends nothing', async () => {
      const { jobId } = await running('s-own-write');
      const ea = await claimed(jobId, 'rA');
      // A transaction holds the cutoff lock and moves the owner while the finish (which has already looked) waits for that lock: the write meets the epoch as it is
      const holder = holdCutoff(jobId, (tx) => tx.$executeRaw`UPDATE "computer_jobs" SET "owner_epoch" = "owner_epoch" + 1 WHERE "id" = ${jobId}`);
      let finish: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        finish = finishJobUnder(jobId, 0, 'done', minutes(2), null, null, null, 'rA', ea);
        expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
        holder.release();
        await holder.done;
        expect(await finish).toMatchObject({ stale: true, superseded: true });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finish]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', endedBy: null });
    });

    it('E1: a prepare from A after B claimed and admitted 5,000 is `superseded` (it never makes a key, never changes the owner or B’s key); B’s key is live and A cannot finish', async () => {
      const { jobId } = await running('s-own-e1');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      const b = await prepared(jobId, eb, minutes(1));
      expect(await ask(b.token, 'c2', { run: 'rB' }, minutes(1))).toMatchObject({ ok: true, reservedMicros: 5_000 });
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect(await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: ea })).toEqual({ ok: false, reason: 'superseded' });
      expect((await jobOf(jobId)).ownerEpoch).toBe(eb);
      expect((await verifyJobToken(b.token, 'model', minutes(2))).ok).toBe(true);
      expect(await liveKeys(jobId)).toBe(1);
      expect(await held(jobId)).toBe(1);
      expect(await finishJobUnder(jobId, 0, 'done', minutes(3), null, null, null, 'rA', ea)).toMatchObject({ stale: true, superseded: true });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      // CONTROL: the owner's own prepare is made
      expect(await prepareJob(jobId, RELAY, minutes(3), { run: 'rB', epoch: eb })).toMatchObject({ ok: true });
      expect(await liveKeys(jobId)).toBe(1);
    });

    it('E1: a prepare that paused inside the broker with a lapsed claim, while B claimed and prepared and admitted, leaves B the owner and B’s key live when it resumes', async () => {
      const { jobId } = await running('s-own-e1-pause');
      const ea = await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      // A holds a prepare claim (its mark is left over, as a paused prepare leaves it), B claims and prepares, and A resumes to make its key under the claim it held
      const mark = new Date('2026-11-15T11:59:00Z');
      const b = await prepared(jobId, eb, minutes(1));
      expect(await ask(b.token, 'c2', { run: 'rB' }, minutes(1))).toMatchObject({ ok: true });
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(mark.getTime() + 1000) } });
      expect(await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: ea, prepareClaim: mark })).toEqual({ ok: false, reason: 'superseded' });
      // ...and with B's own epoch but a claim that moved to another prepare: `preparing`, nothing is made
      expect(await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: eb, prepareClaim: mark })).toEqual({ ok: false, reason: 'preparing' });
      expect((await jobOf(jobId)).ownerEpoch).toBe(eb);
      expect((await verifyJobToken(b.token, 'model', minutes(2))).ok).toBe(true);
      expect(await liveKeys(jobId)).toBe(1);
    });

    it('E1: two pending mints of the same owner: exactly one succeeds (the holder of the current prepare claim), and its key is live', async () => {
      const { jobId } = await running('s-own-e1-two');
      const ea = await claimed(jobId, 'rA');
      const first = new Date('2026-11-15T12:00:00.000Z');
      const second = new Date('2026-11-15T12:00:01.000Z');
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: second } });
      const [late, current] = await Promise.all([mintJobToken(jobId, 'model', minutes(1), { generation: 0 }, { epoch: ea, prepareClaim: first }), mintJobToken(jobId, 'model', minutes(1), { generation: 0 }, { epoch: ea, prepareClaim: second })]);
      expect(late).toEqual({ ok: false, reason: 'preparing' });
      expect(current).toMatchObject({ ok: true });
      expect(await liveKeys(jobId)).toBe(1);
      expect((await verifyJobToken((current as { token: string }).token, 'model', minutes(1))).ok).toBe(true);
    });

    it('the reverse order, A’s stop first: the intent is kept and every key ends; B’s claim is refused (`finish_pending`), a prepare and a key for A too, so no call is made; a call under the intent is refused before it is forwarded and its room goes back; ONE failed ending as ours', async () => {
      const { jobId } = await running('s-own-rev');
      const ea = await claimed(jobId, 'rA');
      const a = await prepared(jobId, ea);
      await refusedInA(jobId, a.token);
      expect(await recordFinishIntent(jobId, { ...POOL, run: 'rA', epoch: ea }, minutes(1))).toMatchObject({ ok: true, already: false });
      expect(await claimJob(jobId, { run: 'rB', seen: ea }, minutes(2))).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: ea })).toEqual({ ok: false, reason: 'finish_pending' });
      expect(await prepareJob(jobId, RELAY, minutes(2), { run: 'rA', epoch: ea })).toEqual({ ok: false, reason: 'finish_pending' });
      // The owner did not move: B never held the job
      expect((await jobOf(jobId)).ownerEpoch).toBe(ea);
      expect(await ask(a.token, 'c2', {}, minutes(2))).toEqual({ ok: false, reason: 'refused' });
      expect(await held(jobId)).toBe(0);
      expect(await liveKeys(jobId)).toBe(0);
      // B reads finishPending and completes A’s ending with A’s own values: the ending is written once, whoever sends it
      const pending = (await getJob(jobId))!.finishPending!;
      expect(pending).toMatchObject({ outcome: 'failed', cause: 'ours', run: 'rA' });
      expect(await finishJobUnder(jobId, 0, 'failed', minutes(3), pending.why, pending.cause, pending.turns, pending.run, null)).toMatchObject({ stale: false });
      expect(await jobOf(jobId)).toMatchObject({ status: expect.stringMatching(/^(failed|stopped)$/) });
      expect(await prisma.meterEvent.count({ where: { jobId, kind: 'model_call' } })).toBe(0);
      expect(await held(jobId)).toBe(0);
    });

    it('a kept intent is never turned away by the owner check: a finish from a worker that is NOT the owner still ends the job, once, as the intent said', async () => {
      const { jobId } = await running('s-own-kept');
      await claimed(jobId, 'rA');
      const eb = await claimed(jobId, 'rB', minutes(1));
      expect(await recordFinishIntent(jobId, { outcome: 'failed', cause: 'agent', run: 'rB', turns: [1], why: 'It gave up', epoch: eb }, minutes(1))).toMatchObject({ ok: true, already: false });
      // A is replaced: without the intent its finish is stale; with it, the intent is the word that stands
      expect(await finishJobUnder(jobId, 0, 'done', minutes(2), null, null, null, 'rA', 1)).toMatchObject({ stale: false });
      expect(await jobOf(jobId)).toMatchObject({ status: 'failed' });
      expect(await prisma.computerFinishIntent.count({ where: { jobId } })).toBe(1);
    });

    it('HISTORICAL CONTROL: A admitted a call at turn 1 and was replaced; B’s own genuine pool stop (turns 3 and 4) is kept, and one at a turn B itself admitted is stale (the same-run rule stays)', async () => {
      const first = await running('s-own-hist');
      const ea = await claimed(first.jobId, 'rA');
      const a = await prepared(first.jobId, ea);
      expect(await ask(a.token, 'c1', { turn: 1 })).toMatchObject({ ok: true });
      const eb = await claimed(first.jobId, 'rB', minutes(1));
      expect(await recordFinishIntent(first.jobId, { ...POOL, run: 'rB', turns: [3, 4], epoch: eb }, minutes(2))).toMatchObject({ ok: true, already: false });
      const second = await running('s-own-hist-2');
      await claimed(second.jobId, 'rA');
      const eb2 = await claimed(second.jobId, 'rB', minutes(1));
      const b = await prepared(second.jobId, eb2, minutes(1));
      expect(await ask(b.token, 'c1', { run: 'rB', turn: 3 }, minutes(1))).toMatchObject({ ok: true });
      expect(await recordFinishIntent(second.jobId, { ...POOL, run: 'rB', turns: [3, 4], epoch: eb2 }, minutes(2))).toEqual({ ok: false, reason: 'stale' });
    });

    it('MIXED VERSIONS: a legacy job (owner epoch 0) with a worker that names no epoch behaves as before; once claimed, an epoch-less request is superseded', async () => {
      const legacy = await running('s-own-legacy');
      expect((await jobOf(legacy.jobId)).ownerEpoch).toBe(0);
      expect(await prepareJob(legacy.jobId, RELAY, minutes(1), { run: 'rB' })).toMatchObject({ ok: true });
      expect(await renewJob(legacy.jobId, minutes(1))).toMatchObject({ ok: true });
      expect(await recordFinishIntent(legacy.jobId, { outcome: 'failed', cause: 'agent', turns: [1] }, minutes(1))).toMatchObject({ ok: true, already: false });
      const fin = await running('s-own-legacy-fin');
      expect(await finishJobUnder(fin.jobId, 0, 'done', minutes(1))).toMatchObject({ stale: false });
      expect(await jobOf(fin.jobId)).toMatchObject({ status: 'done' });
      // A worker that names an epoch the job does not have is not the owner either, claimed or not
      const odd = await running('s-own-legacy-odd');
      expect(await renewJob(odd.jobId, minutes(1), { epoch: 4 })).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      // Claimed: from then on every epoch-less request is superseded (the game deploy replaces all workers)
      const claimedJob = await running('s-own-claimed');
      const ea = await claimed(claimedJob.jobId, 'rA');
      expect(await renewJob(claimedJob.jobId, minutes(1))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await prepareJob(claimedJob.jobId, RELAY, minutes(1), { run: 'rA' })).toEqual({ ok: false, reason: 'superseded' });
      expect(await finishJobUnder(claimedJob.jobId, 0, 'done', minutes(1), null, null, null, 'rA')).toMatchObject({ stale: true, superseded: true });
      expect(await recordFinishIntent(claimedJob.jobId, { outcome: 'done' }, minutes(1))).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
      expect(await renewJob(claimedJob.jobId, minutes(1), { epoch: ea })).toMatchObject({ ok: true });
    });

    it('the claim: moves the epoch up by one, ends every live key and lets go of the prepare claim; a DELAYED claim (one that saw an older epoch) is superseded and changes nothing; a job that is over, queued, with an intent or with a cutoff refuses it', async () => {
      const { jobId } = await running('s-own-claim');
      const a = await prepared(jobId, 0);
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: NOW } });
      const before = await jobOf(jobId);
      expect(await claimJob(jobId, { run: 'rA', seen: 0 }, minutes(1))).toEqual({ ok: true, epoch: 1 });
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ ownerEpoch: 1, ownerRun: 'rA', prepareClaimedAt: null });
      expect(after.leaseVersion).toBe(before.leaseVersion + 1);
      expect((await verifyJobToken(a.token, 'model', minutes(1))).ok).toBe(false);
      expect(await liveKeys(jobId)).toBe(0);
      // A claim that looked at the job before this one (it saw 0) is superseded, and tells the epoch to claim with
      expect(await claimJob(jobId, { run: 'rLate', seen: 0 }, minutes(2))).toEqual({ ok: false, reason: 'superseded', ownerEpoch: 1 });
      expect(await jobOf(jobId)).toMatchObject({ ownerEpoch: 1, ownerRun: 'rA' });
      expect(await claimJob(jobId, { run: 'rB', seen: 1 }, minutes(2))).toEqual({ ok: true, epoch: 2 });
      expect(await claimJob('does-not-exist', { run: 'rB', seen: 0 })).toEqual({ ok: false, reason: 'not_found' });
      const intent = await running('s-own-claim-intent');
      await recordFinishIntent(intent.jobId, { outcome: 'done' }, minutes(1));
      expect(await claimJob(intent.jobId, { run: 'rA', seen: 0 }, minutes(2))).toEqual({ ok: false, reason: 'finish_pending' });
      const cut = await running('s-own-claim-cut');
      await recordPoolCutoff(prisma, cut.jobId, minutes(1));
      expect(await claimJob(cut.jobId, { run: 'rA', seen: 0 }, minutes(2))).toEqual({ ok: false, reason: 'cutoff' });
      const over = await running('s-own-claim-over');
      await finishJob(over.jobId, 'done', minutes(1));
      expect(await claimJob(over.jobId, { run: 'rA', seen: 0 }, minutes(2))).toEqual({ ok: false, reason: 'over' });
      expect((await jobOf(over.jobId)).ownerEpoch).toBe(0);
    });

    it('a mint is stamped with the epoch it was made under, and a key made under another epoch is not good even if it was never revoked; a prepare ends the older keys of its OWN epoch only', async () => {
      const { jobId } = await running('s-own-stamp');
      const ea = await claimed(jobId, 'rA');
      const a = await prepared(jobId, ea);
      expect((await prisma.computerJobToken.findFirstOrThrow({ where: { jobId } })).ownerEpoch).toBe(ea);
      // A key row of an older epoch that a defect left live is refused at the key (the job has one owner)
      await prisma.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: ea + 1 } });
      expect((await verifyJobToken(a.token, 'model', minutes(1))).ok).toBe(false);
      await prisma.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: ea } });
      // A second prepare of the same owner ends the first key; the git key of the same epoch too (it is re-made)
      const claim = new Date('2026-11-15T12:00:05.000Z');
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: claim } });
      const again = (await mintJobToken(jobId, 'model', minutes(2), { generation: 0 }, { epoch: ea, prepareClaim: claim })) as { token: string };
      expect((await verifyJobToken(a.token, 'model', minutes(2))).ok).toBe(false);
      expect((await verifyJobToken(again.token, 'model', minutes(2))).ok).toBe(true);
      expect(await liveKeys(jobId)).toBe(1);
    });

    it('a real prepare: one key of the owner is live after each, a refused prepare (pool cutoff) changes nothing', async () => {
      const { jobId } = await running('s-own-prep');
      const ea = await claimed(jobId, 'rA');
      expect(await prepareJob(jobId, RELAY, NOW, { run: 'rA', epoch: ea })).toMatchObject({ ok: true });
      expect(await prepareJob(jobId, RELAY, minutes(1), { run: 'rA', epoch: ea })).toMatchObject({ ok: true });
      expect(await liveKeys(jobId)).toBe(1);
      await recordPoolCutoff(prisma, jobId, minutes(2));
      expect(await prepareJob(jobId, RELAY, minutes(3), { run: 'rA', epoch: ea })).toMatchObject({ ok: false });
      expect((await jobOf(jobId)).ownerEpoch).toBe(ea);
    });

    it('A REAL RACE, in both queue orders: B’s claim queued first wins (A’s stop is superseded, B owns); A’s stop queued first wins (B’s claim is refused, the stop is kept): never both', async () => {
      for (const order of ['claim-first', 'stop-first'] as const) {
        const { jobId } = await running(`s-own-q-${order}`);
        const ea = await claimed(jobId, 'rA');
        await prepared(jobId, ea);
        const holder = holdCutoff(jobId, async () => undefined);
        let claim: Promise<unknown> = Promise.resolve();
        let stop: Promise<unknown> = Promise.resolve();
        try {
          await holder.ready;
          if (order === 'claim-first') {
            claim = claimJob(jobId, { run: 'rB', seen: ea }, minutes(1));
            expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
            stop = recordFinishIntent(jobId, { ...POOL, run: 'rA', epoch: ea }, minutes(1));
          } else {
            stop = recordFinishIntent(jobId, { ...POOL, run: 'rA', epoch: ea }, minutes(1));
            expect(await waitForWaiters(cutoffLockKey(jobId), 1)).toBe(true);
            claim = claimJob(jobId, { run: 'rB', seen: ea }, minutes(1));
          }
          expect(await waitForWaiters(cutoffLockKey(jobId), 2)).toBe(true);
          holder.release();
          await holder.done;
          const [made, stopped] = await Promise.all([claim, stop]);
          if (order === 'claim-first') {
            expect(made).toEqual({ ok: true, epoch: ea + 1 });
            expect(stopped).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
            expect(await hasFinishIntent(prisma, jobId)).toBe(false);
            expect((await jobOf(jobId)).ownerEpoch).toBe(ea + 1);
          } else {
            expect(made).toEqual({ ok: false, reason: 'finish_pending' });
            expect(stopped).toMatchObject({ ok: true, already: false });
            expect(await hasFinishIntent(prisma, jobId)).toBe(true);
            expect((await jobOf(jobId)).ownerEpoch).toBe(ea);
            expect(await liveKeys(jobId)).toBe(0);
          }
        } finally {
          holder.release();
          await Promise.allSettled([holder.done, claim, stop]);
        }
      }
    });
  });

  describe('a finish while an intent is kept', () => {
    it('ends the job as the intent said, whatever the finish says (the committed word is first); finishPending carries every value a replacement sends', async () => {
      const { jobId } = await running();
      expect((await getJob(jobId))?.finishPending).toBeNull();
      await recordFinishIntent(jobId, { outcome: 'failed', cause: 'agent', turns: [2, 3], run: 'r1', why: 'It gave up', generation: 0 }, minutes(1));
      expect((await getJob(jobId))?.finishPending).toEqual({ outcome: 'failed', cause: 'agent', run: 'r1', generation: 0, turns: [2, 3], why: 'It gave up', at: minutes(1) });
      // A replacement (or a replayed finish) that says another outcome changes nothing about how the job ends
      const answered = await finishJobUnder(jobId, 0, 'done', minutes(3), null, null, null, 'r9');
      expect(answered).toMatchObject({ stale: false });
      expect(await jobOf(jobId)).toMatchObject({ status: expect.stringMatching(/^(failed|stopped)$/) });
      expect((await jobOf(jobId)).status).not.toBe('done');
      // Said again, the same: nothing is written twice
      const ledger = await ledgerOf(jobId);
      await finishJobUnder(jobId, 0, 'done', minutes(4));
      expect(await ledgerOf(jobId)).toEqual(ledger);
      expect((await getJob(jobId))?.finishPending).toBeNull();
    });
  });

  describe('the sweep completes an intent whose finish never came', () => {
    it('leaves it for the grace period, then finishes the job with what the intent kept: done as done, a failure as the runner’s word judged from the rows, as of the moment the runner committed', async () => {
      const done = await running('s-done');
      const ours = await running('s-ours');
      const agent = await running('s-agent');
      const at = minutes(1);
      await recordFinishIntent(done.jobId, { outcome: 'done', run: 'r1' }, at);
      await recordFinishIntent(ours.jobId, { outcome: 'failed', cause: 'ours', why: 'The relay was not there', run: 'r1', turns: [1] }, at);
      await recordFinishIntent(agent.jobId, { outcome: 'failed', cause: 'agent', why: 'It gave up', run: 'r1', turns: [1] }, at);
      // Within the grace period: nothing is finished, and the grace is the runner’s to use
      expect(await completeFinishIntents(new Date(at.getTime() + FINISH_INTENT_GRACE_MS - 1_000), 50)).toBe(0);
      for (const id of [done.jobId, ours.jobId, agent.jobId]) expect((await jobOf(id)).status).toBe('running');
      // After it: all three are finished, once, through the same finish
      const later = new Date(at.getTime() + FINISH_INTENT_GRACE_MS + 60_000);
      expect(await completeFinishIntents(later, 50)).toBe(3);
      expect(await jobOf(done.jobId)).toMatchObject({ status: 'done', endedAt: at });
      expect(await jobOf(ours.jobId)).toMatchObject({ endedAt: at });
      expect(await jobOf(agent.jobId)).toMatchObject({ endedAt: at });
      expect(['failed', 'stopped']).toContain((await jobOf(agent.jobId)).status);
      // The runner’s own word is judged from the relay’s rows like any finish: nothing recorded for the agent’s own failure stays the person’s, and a failure ours with no rows is not given back on the hint alone
      expect(await decisionOf(agent.jobId)).toMatchObject({ state: 'refused' });
      // Never twice: the books and the records are as the first completion left them
      const ledger = await Promise.all([done.jobId, ours.jobId, agent.jobId].map(ledgerOf));
      const decisions = await Promise.all([done.jobId, ours.jobId, agent.jobId].map(decisionOf));
      expect(await completeFinishIntents(new Date(later.getTime() + 3_600_000), 50)).toBe(0);
      expect(await Promise.all([done.jobId, ours.jobId, agent.jobId].map(ledgerOf))).toEqual(ledger);
      expect(await Promise.all([done.jobId, ours.jobId, agent.jobId].map(decisionOf))).toEqual(decisions);
    });

    it('runs from the sweep itself, before a job waiting for its person past the wait is ended as unanswered: it ends as what the runner said', async () => {
      const waiting = await running('s-wait');
      await prisma.computerJob.update({ where: { id: waiting.jobId }, data: { status: 'waiting', waitingFor: 'details', stretchStarted: NOW } });
      await recordFinishIntent(waiting.jobId, { outcome: 'done' }, minutes(1));
      // Past the wait (60 minutes) the job would be ended as unanswered; the intent is completed first
      const result = await sweepComputers(minutes(70));
      expect(result.stopped).toBeGreaterThanOrEqual(1);
      expect(await jobOf(waiting.jobId)).toMatchObject({ status: 'done', endedBy: null });
    });

    it('never touches a job the person has taken over, or one that is over', async () => {
      const theirs = await running('s-theirs');
      await recordFinishIntent(theirs.jobId, { outcome: 'done' }, minutes(1));
      await prisma.computerJob.update({ where: { id: theirs.jobId }, data: { status: 'waiting', waitingFor: 'details', stretchStarted: NOW, control: 'person' } });
      const over = await running('s-over');
      await recordFinishIntent(over.jobId, { outcome: 'failed', cause: 'agent' }, minutes(1));
      await finishJob(over.jobId, 'failed', minutes(2), 'It gave up', 'agent');
      const overLedger = await ledgerOf(over.jobId);
      await sweepComputers(minutes(3));
      expect(await jobOf(theirs.jobId)).toMatchObject({ status: 'waiting', control: 'person' });
      expect(await ledgerOf(over.jobId)).toEqual(overLedger);
    });

    it('judges the give-back by the intent’s own run, turns and cause, as the runner finish does: its rows for that run decide (the money rule)', async () => {
      const { jobId } = await twoRuns('s-money');
      await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', turns: [1], run: 'runb', why: 'The relay was not there' }, minutes(1));
      expect(await completeFinishIntents(minutes(1 + 3), 50)).toBe(1);
      // The decision carries what the intent kept and follows the rows of THAT run (ours), never the other run's (the person's)
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given', basis: 'universe_fault', causeHint: 'ours', judgedTurns: [1], judgedRun: 'runb' });
    });

    it('a finish under a kept intent writes the decision with the intent’s cause, turns and run, whatever the finish says', async () => {
      const { jobId } = await twoRuns('s-money2');
      await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', turns: [1], run: 'runb' }, minutes(1));
      // A replacement that says `done`, no cause, other turns and another run changes nothing about how it ends or what is given back
      await finishJobUnder(jobId, 0, 'done', minutes(3), null, null, [7], 'runa');
      expect((await jobOf(jobId)).status).not.toBe('done');
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given', basis: 'universe_fault', causeHint: 'ours', judgedTurns: [1], judgedRun: 'runb' });
    });

    it('waits exactly two minutes: an intent younger than that is left alone to the second, one of that age is completed', async () => {
      expect(FINISH_INTENT_GRACE_MS).toBe(120_000);
      const { jobId } = await running('s-grace');
      const at = minutes(1);
      await recordFinishIntent(jobId, { outcome: 'done' }, at);
      expect(await completeFinishIntents(new Date(at.getTime() + 119_999), 50)).toBe(0);
      expect((await jobOf(jobId)).status).toBe('running');
      expect(await completeFinishIntents(new Date(at.getTime() + 120_000), 50)).toBe(1);
      expect((await jobOf(jobId)).status).toBe('done');
    });

    it('two sweeps that BOTH selected the intent complete it once: their counts add up to exactly one, and the job has one time event', async () => {
      const { jobId } = await running();
      await recordFinishIntent(jobId, { outcome: 'done' }, minutes(1));
      const later = minutes(30);
      // Both sweeps read the pending intent before either can write: neither can win by having looked second
      const real = prisma.computerFinishIntent.findMany.bind(prisma.computerFinishIntent);
      let arrived = 0;
      let both: () => void = () => undefined;
      const bothSelected = new Promise<void>((resolve) => (both = resolve));
      const spy = jest.spyOn(prisma.computerFinishIntent, 'findMany').mockImplementation(((args: never) =>
        real(args).then(async (rows) => {
          arrived += 1;
          if (arrived === 2) both();
          await bothSelected;
          return rows;
        })) as never);
      let counts: number[];
      try {
        counts = await Promise.all([completeFinishIntents(later, 50), completeFinishIntents(later, 50)]);
      } finally {
        spy.mockRestore();
      }
      expect(arrived).toBe(2);
      expect(counts[0] + counts[1]).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect((await ledgerOf(jobId)).timeEvents).toBe(1);
      expect(await cutoffEndsFinished()).toBeUndefined();
    });
  });

  describe('CodeRabbit round on 6be29335: every ending is decided in the write that lands it', () => {
    const rowBlocked = async (): Promise<boolean> => {
      for (let tries = 0; tries < 250; tries += 1) {
        const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple') AND query ILIKE '%FROM "computer_jobs" WHERE "id" = % FOR UPDATE%' AND query NOT ILIKE '%pg_stat_activity%'`;
        if (rows[0].n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };

    it('a `done` finish that waits for the cutoff lock while a `failed` intent commits ends as the intent said, never as done (inline 3)', async () => {
      const { jobId } = await running('cr-i3');
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId, outcome: 'failed', cause: 'agent', why: 'It gave up', turns: [1], run: 'r1', createdAt: minutes(1) } });
        await revokeJobTokens(jobId, minutes(1), undefined, tx);
      });
      let finishing: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        finishing = finishJobUnder(jobId, 0, 'done', minutes(2));
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await finishing).toMatchObject({ stale: false });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finishing]);
      }
      expect((await jobOf(jobId)).status).not.toBe('done');
      expect(['failed', 'stopped']).toContain((await jobOf(jobId)).status);
      expect(await decisionOf(jobId)).toMatchObject({ causeHint: 'agent' });
    });

    it('a FAILED finish judged from the rows (the agent’s own failure) that waits for the lock while a `done` intent commits ends as done too (inline 3, the judged write)', async () => {
      const { jobId } = await running('cr-i3-judged');
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId, outcome: 'done', turns: [], createdAt: minutes(1) } });
        await revokeJobTokens(jobId, minutes(1), undefined, tx);
      });
      let finishing: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        finishing = finishJobUnder(jobId, 0, 'failed', minutes(2), 'It gave up', 'agent', [1], 'r1');
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        await finishing;
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finishing]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect(await decisionOf(jobId)).toBeNull();
    });

    it('a pool cutoff that committed stays above a kept intent: the job ends as the pool’s, ours (inline 3)', async () => {
      const { jobId } = await running('cr-i3-pool');
      await prisma.computerFinishIntent.create({ data: { jobId, outcome: 'done', turns: [], createdAt: minutes(1) } });
      await recordPoolCutoff(prisma, jobId, minutes(1));
      await finishJobUnder(jobId, 0, 'done', minutes(2));
      expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
    });

    it('a finish of the generation the runner acts under is stale when a take-over lands between its read and its write: nothing is ended under the new controller (inline 2)', async () => {
      const { jobId } = await running('cr-i2');
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 1, control: 'person', status: 'waiting', waitingFor: 'details', stretchStarted: NOW } });
      });
      let finishing: Promise<{ stale: boolean }> = Promise.resolve({ stale: false });
      try {
        await holder.ready;
        finishing = finishJobUnder(jobId, 0, 'failed', minutes(2), 'It could not go on', 'agent');
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        const answer = (await finishing) as { stale: boolean; superseded?: boolean };
        expect(answer).toMatchObject({ stale: true });
        // The generation moved, not the run: it never says `superseded`
        expect(answer.superseded).toBeUndefined();
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finishing]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', controlGeneration: 1, endNote: null });
      // A finish with no generation (an older runner) still ends it as before
      await finishJobUnder(jobId, null, 'done', minutes(3));
      expect((await jobOf(jobId)).status).toBe('done');
    });

    it('the generation is part of the write itself: a take-over and a hand-back that leave the status as it was still make the finish stale', async () => {
      const { jobId } = await running('cr-i2-gen');
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 2 } });
      });
      let finishing: Promise<{ stale: boolean }> = Promise.resolve({ stale: false });
      try {
        await holder.ready;
        finishing = finishJobUnder(jobId, 0, 'done', minutes(2));
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await finishing).toMatchObject({ stale: true });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, finishing]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', controlGeneration: 2 });
    });

    it('the failure note of a finish is written only under the generation the runner acts under (inline 2)', async () => {
      const { jobId } = await running('cr-i2-note');
      await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 1 } });
      expect(await finishJobUnder(jobId, 0, 'failed', minutes(2), 'A note from the old controller', 'agent')).toMatchObject({ stale: true });
      expect((await jobOf(jobId)).endNote).toBeNull();
    });

    it('the unanswered pass leaves a waiting job whose runner committed to ending it: after the grace it ends as the runner said, never as unanswered (inline 4)', async () => {
      const waiting = await running('cr-i4');
      await prisma.computerJob.update({ where: { id: waiting.jobId }, data: { status: 'waiting', waitingFor: 'details', stretchStarted: NOW } });
      // Its room is good for hours: only the unanswered pass could reach it
      await prisma.meterReservation.update({ where: { reservationKey: (await jobOf(waiting.jobId)).reservationKey as string }, data: { expiresAt: minutes(600) } });
      // The wait (60 minutes) is over at minute 61, the intent is a minute old: younger than its grace
      await recordFinishIntent(waiting.jobId, { outcome: 'done' }, minutes(60));
      await sweepComputers(minutes(61));
      expect(await jobOf(waiting.jobId)).toMatchObject({ status: 'waiting', endedBy: null });
      await sweepComputers(minutes(63));
      expect(await jobOf(waiting.jobId)).toMatchObject({ status: 'done', endedBy: null });
    });

    it('a lease that ran out does not replace a pending finish: the job ends as the intent said; a job with no intent still ends as an error (inline 5)', async () => {
      const kept = await running('cr-i5');
      const plain = await running('cr-i5-plain');
      for (const job of [kept, plain]) {
        const row = await jobOf(job.jobId);
        await prisma.meterReservation.update({ where: { reservationKey: row.reservationKey as string }, data: { expiresAt: minutes(4) } });
      }
      // The intent is a minute old at the sweep: inside its grace, so only the lease pass can reach it
      await recordFinishIntent(kept.jobId, { outcome: 'done' }, minutes(5));
      await sweepComputers(minutes(6));
      expect(await jobOf(kept.jobId)).toMatchObject({ status: 'done', endedBy: null });
      expect(await jobOf(plain.jobId)).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });

    it('a swept intent needs Brick’s control in the write that ends the job: a take-over that lands first leaves the intent pending, and it is completed after the hand-back (inline 6)', async () => {
      const { jobId } = await running('cr-i6');
      await recordFinishIntent(jobId, { outcome: 'done' }, minutes(1));
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 1, control: 'person', status: 'waiting', waitingFor: 'details', stretchStarted: NOW } });
      });
      let sweeping: Promise<number> = Promise.resolve(0);
      try {
        await holder.ready;
        sweeping = completeFinishIntents(minutes(10), 50);
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        expect(await sweeping).toBe(0);
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, sweeping]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person' });
      expect(await prisma.computerFinishIntent.count({ where: { jobId } })).toBe(1);
      // The person hands it back: the next pass completes it
      await prisma.computerJob.update({ where: { id: jobId }, data: { control: 'brick', status: 'running', waitingFor: null, stretchStarted: minutes(10) } });
      expect(await completeFinishIntents(minutes(11), 50)).toBe(1);
      expect((await jobOf(jobId)).status).toBe('done');
    });

    it('an intent is kept under the generation it was read at: a take-over that bumps it while the intent is being kept waits for it, and a stop from the older generation is stale and writes nothing (CodeRabbit)', async () => {
      const { jobId } = await running('cr-gen');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // The take-over's own write holds the job's row and bumps the generation when it commits
      const takeover = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "computer_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
          locked();
          await gate;
          await tx.computerJob.update({ where: { id: jobId }, data: { controlGeneration: 1 } });
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
      let stopping: Promise<unknown> = Promise.resolve();
      try {
        await lockTaken;
        stopping = recordFinishIntent(jobId, { outcome: 'failed', cause: 'agent', generation: 0 }, minutes(1));
        expect(await rowBlocked()).toBe(true);
        release();
        await takeover;
        expect(await stopping).toEqual({ ok: false, reason: 'stale' });
      } finally {
        release();
        await Promise.allSettled([takeover, stopping]);
      }
      expect(await hasFinishIntent(prisma, jobId)).toBe(false);
    });
  });
  describe('GPT round 6, finding 2: the person’s Cancel and Stop respect an ending already committed (the committed fault decides the money, not their stop)', () => {
    /** A runner takes up the job and answers the epoch it owns by. */
    const claimed = async (jobId: string, run: string, at: Date = NOW): Promise<number> => {
      const won = await claimJob(jobId, { run, seen: (await jobOf(jobId)).ownerEpoch }, at);
      if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
      return won.epoch;
    };

    it('Cancel one job whose runner kept a FAILED intent of ours ends it as ours (given back), never as the person’s stop; the receipt and the give-back follow the intent, and the next job in line starts', async () => {
      const { sara, jobId } = await running('g6-cancel-intent');
      const ea = await claimed(jobId, 'rA');
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next' }, minutes(1));
      if (!next.ok) throw new Error('the second job was not made');
      // The runner commits to ending it as a fault of OURS (the relay was down in its turn 1)
      await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', 'rA')]);
      expect(await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', why: 'The relay was down', turns: [1], run: 'rA', epoch: ea })).toMatchObject({ ok: true });
      // The person then cancels that one job
      expect((await cancelJob(sara.brickId, sara.id, jobId, minutes(2))).ok).toBe(true);
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'failed', endedBy: 'error' });
      expect(after.endedBy).not.toBe('person');
      // The money: it is given back as ours, and the decision names the runner's committed cause, not a stop of theirs
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given', causeHint: 'ours' });
      // Nothing ends it a second time (the sweep leaves a job that is over), and the job that was in line has the machine now
      expect(await completeFinishIntents(minutes(60), 10)).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'failed', endedBy: 'error' });
      expect(await jobOf(next.job.id)).toMatchObject({ status: 'running' });
    });

    it('Cancel one job for which a pool cutoff was decided ends it as the pool’s, ours (given back), with the words the person is told', async () => {
      const { sara, jobId } = await running('g6-cancel-cutoff');
      await recordPoolCutoff(prisma, jobId, minutes(1));
      expect((await cancelJob(sara.brickId, sara.id, jobId, minutes(2))).ok).toBe(true);
      const after = await jobOf(jobId);
      expect(after).toMatchObject({ status: 'stopped', endedBy: 'pool', endNote: POOL_BUSY_WORDS });
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given' });
    });

    it('Stop all after an intent was kept ends the held job as the intent said, and a job of theirs with nothing committed still ends as their own stop', async () => {
      const { sara, jobId } = await running('g6-stop-intent');
      const ea = await claimed(jobId, 'rA');
      const inLine = await startJob({ botId: sara.brickId, personId: sara.id, title: 'In line' }, minutes(1));
      if (!inLine.ok) throw new Error('the second job was not made');
      await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', 'rA')]);
      expect(await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', why: 'The relay was down', turns: [1], run: 'rA', epoch: ea })).toMatchObject({ ok: true });
      await stopJobFor(sara.brickId, sara.id, minutes(2));
      expect(await jobOf(jobId)).toMatchObject({ status: 'failed', endedBy: 'error' });
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given', causeHint: 'ours' });
      // The one in line never started, so it is their own stop, charged nothing
      expect(await jobOf(inLine.job.id)).toMatchObject({ status: 'stopped', endedBy: 'person', secondsRun: 0 });
      // CONTROL: a running job with nothing committed is their own stop, charged the time it used
      const plain = await running('g6-stop-plain');
      await stopJobFor(plain.sara.brickId, plain.sara.id, minutes(5));
      expect(await jobOf(plain.jobId)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await decisionOf(plain.jobId)).toBeNull();
    });

    it('an intent that commits while the person’s Cancel waits for the cutoff lock still governs: the job ends as the intent said', async () => {
      const { sara, jobId } = await running('g6-cancel-race');
      const ea = await claimed(jobId, 'rA');
      await recordFaults(sara.brickId, jobId, [fault(1, 'relay_down', 'rA')]);
      const holder = holdCutoff(jobId, async (tx) => {
        await tx.computerFinishIntent.create({ data: { jobId, outcome: 'failed', cause: 'ours', why: 'The relay was down', turns: [1], run: 'rA', createdAt: minutes(1) } });
        await revokeJobTokens(jobId, minutes(1), undefined, tx);
      });
      let cancelling: Promise<unknown> = Promise.resolve();
      try {
        await holder.ready;
        cancelling = cancelJob(sara.brickId, sara.id, jobId, minutes(2));
        expect(await waitingOn(cutoffLockKey(jobId))).toBe(true);
        holder.release();
        await holder.done;
        await cancelling;
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, cancelling]);
      }
      expect(await jobOf(jobId)).toMatchObject({ status: 'failed', endedBy: 'error' });
      expect(await decisionOf(jobId)).toMatchObject({ state: 'given', causeHint: 'ours' });
      void ea;
    });

    it('CONTROL: Cancel of a job still IN LINE is the person’s own, whatever any other job committed', async () => {
      const { sara, jobId } = await running('g6-cancel-queued');
      const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'In line' }, minutes(1));
      if (!queued.ok) throw new Error('the second job was not made');
      expect((await cancelJob(sara.brickId, sara.id, queued.job.id, minutes(2))).ok).toBe(true);
      expect(await jobOf(queued.job.id)).toMatchObject({ status: 'stopped', endedBy: 'person', secondsRun: 0 });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
    });
  });
});
