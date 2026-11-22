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
import { FINISH_INTENT_GRACE_MS, completeFinishIntents, finishJob, finishJobUnder, getJob, giveComputer, handBack, recordFinishIntent, startJob, sweepComputers, takeOver } from '@/lib/computer';
import { prepareJob, startTurn } from '@/lib/computer-broker';
import { mintJobToken, revokeJobTokens, verifyJobToken } from '@/lib/computer-token';
import { authorizeModelCall, cutoffEndsFinished, cutoffLockKey, callRoomKey } from '@/lib/computer-calls';
import { POOL_CUTOFF_CALL, hasFinishIntent, hasOwnKeyCall, recordFaults, recordPoolCutoff, type FaultInput } from '@/lib/computer-faults';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';

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
      for (const [name, outcome, cause] of [['fin-done', 'done', undefined], ['fin-ours', 'failed', 'ours'], ['fin-agent', 'failed', 'agent']] as const) {
        const { jobId } = await running(name);
        await recordFinishIntent(jobId, { outcome, cause }, minutes(1));
        // The first finish is lost before it reaches Orbit: the replacement's finish is the first Orbit sees
        const first = await finishJobUnder(jobId, 0, outcome, minutes(2), outcome === 'failed' ? 'It gave up' : null, cause);
        expect(first.stale).toBe(false);
        const ended = await jobOf(jobId);
        expect(['done', 'stopped', 'failed']).toContain(ended.status);
        const ledger = await ledgerOf(jobId);
        const decision = await decisionOf(jobId);
        expect(ledger.timeEvents).toBeLessThanOrEqual(1);
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

  describe('GPT third note, R2 follow-up: a delayed stop for the pool, after the pool recovered and a funded call was admitted', () => {
    it('REPRO: the intent is not kept for a stop whose pool refusal was recovered by an admitted call (the work stays)', async () => {
      const { jobId } = await running('s-pool');
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // The pool is full: one call is refused for OUR capacity (below the two that decide a cutoff)
      await setUp({ poolCeilingMicros: 1 });
      expect(await authorizeModelCall({ token: key.token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool', full: true });
      // The pool recovers and a funded call is admitted: it reserves 5,000 micros and retires the earlier refusal
      await setUp();
      expect(await authorizeModelCall({ token: key.token, callId: 'c2', estimateMicros: 5_000, payer: 'universe' }, minutes(1))).toMatchObject({ ok: true, reservedMicros: 5_000 });
      // The runner's stop for the pool (decided on the first refusal, delayed) reaches Orbit now
      const kept = await recordFinishIntent(jobId, { outcome: 'failed', cause: 'ours', turns: [1], run: 'r1' }, minutes(2));
      expect(kept).toMatchObject({ ok: false });
      expect(await hasFinishIntent(prisma, jobId)).toBe(false);
      expect((await jobOf(jobId)).status).toBe('running');
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

    it('two sweeps at once complete an intent once', async () => {
      const { jobId } = await running();
      await recordFinishIntent(jobId, { outcome: 'done' }, minutes(1));
      const later = minutes(30);
      const counts = await Promise.all([completeFinishIntents(later, 50), completeFinishIntents(later, 50)]);
      expect(counts[0] + counts[1]).toBeGreaterThanOrEqual(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      expect((await ledgerOf(jobId)).timeEvents).toBe(1);
      expect(await cutoffEndsFinished()).toBeUndefined();
    });
  });
});
