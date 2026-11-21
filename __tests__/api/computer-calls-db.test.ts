/**
 * What a Brick's computer may ask of Orbit, against a real database (build handoff v2, section 5): its key, and a model call's
 * room and books. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-calls-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/computer-calls', () => {
  const actual = jest.requireActual('@/lib/computer-calls');
  return { ...actual, giveBackModelCalls: jest.fn(actual.giveBackModelCalls) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { currentEnvelope, poolStatusNow, USUAL_CALL_ROOM_MICROS } from '@/lib/meter-allowance';
import { computerReadiness, poolCheck } from '@/lib/computer-readiness';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, handBack, renewJob, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { activityFor } from '@/lib/task-receipts';
import { TOKEN_LIFE_MS, forgetOldTokens, mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { recordMeterEvent } from '@/lib/meter';
import { reportsToTell } from '@/lib/computer-report';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { authorizeModelCall, callRoomKey, giveBackModelCalls, releaseModelCall, settleModelCall } from '@/lib/computer-calls';

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
  return { id: user.id, brickId: brick.id };
}

/** A pretend minute costs 6,000 millionths; 10 minutes of room is 60,000. */
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

run('what a computer may ask of Orbit, in a real database', () => {
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

  describe('the key a job’s computer holds', () => {
    it('is made once for a running job, kept only as a digest, and says who it is for from Orbit’s own records', async () => {
      const { sara, jobId } = await running();
      const minted = await mintJobToken(jobId, 'model', NOW);
      expect(minted.ok && minted.token.startsWith('cjt_')).toBe(true);
      const token = (minted as { token: string }).token;
      const stored = await prisma.computerJobToken.findMany({ where: { jobId } });
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(await verifyJobToken(token, 'model', NOW)).toMatchObject({ ok: true, jobId, botId: sara.brickId, personId: sara.id });
    });

    it('is not made for a job that is over, queued or not there', async () => {
      const { jobId } = await running();
      await finishJob(jobId, 'done', NOW);
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      expect(await mintJobToken(randomUUID(), 'model', NOW)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('is refused when it is wrong, was never made, or is for another scope: the same answer for all', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await verifyJobToken(`${minted.token}x`, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken('cjt_nothing', 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken('not-a-key', 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken(minted.token, 'lifecycle' as never, NOW)).toEqual({ ok: false, reason: 'refused' });
    });

    it('runs out after 15 minutes, and the job’s lease renews it', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await verifyJobToken(minted.token, 'model', new Date(NOW.getTime() + TOKEN_LIFE_MS - 1000))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', new Date(NOW.getTime() + TOKEN_LIFE_MS + 1000))).ok).toBe(false);
      // The lease is renewed 8 minutes in: the key lives 15 minutes from there
      expect((await renewJob(jobId, minutes(8))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', minutes(20))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', minutes(24))).ok).toBe(false);
    });

    it('ends with the job', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await finishJob(jobId, 'done', NOW);
      expect(await verifyJobToken(minted.token, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
    });

    it('ends when the person takes over, and a key made before a hand back stays refused (the fence)', async () => {
      const { sara, jobId } = await running();
      const before = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await verifyJobToken(before.token, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      // While the person has the machine Brick is not admitted: no key is made for it (audit F02: the agent and the person are never authorized together)
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      await handBack(sara.brickId, sara.id);
      const after = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await verifyJobToken(after.token, 'model', NOW)).ok).toBe(true);
      const job = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.controlGeneration).toBe(2);
    });

    it('cannot be used for another person’s job by naming it: authority comes from the key alone', async () => {
      const a = await running('sara');
      const b = await running('omar');
      const mine = (await mintJobToken(a.jobId, 'model', NOW)) as { token: string };
      const verified = await verifyJobToken(mine.token, 'model', NOW);
      expect(verified).toMatchObject({ ok: true, jobId: a.jobId, personId: a.sara.id });
      expect(verified.ok && verified.jobId).not.toBe(b.jobId);
    });

    it('old ended keys are forgotten, good ones are not', async () => {
      const { jobId } = await running();
      const live = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: 0, digest: 'a'.repeat(64), expiresAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000) } });
      expect(await forgetOldTokens(NOW)).toBe(1);
      expect((await verifyJobToken(live.token, 'model', NOW)).ok).toBe(true);
    });
  });

  describe('a model call', () => {
    const call = (token: string, callId: string, estimateMicros = 5_000) => authorizeModelCall({ token, callId, estimateMicros, payer: 'universe' }, NOW);

    it('takes room before it is sent, and settles to what it cost: the books and the room agree', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const before = (await currentEnvelope(NOW)).reservedMicros;
      const authorized = await call(token, 'c1', 5_000);
      expect(authorized).toMatchObject({ ok: true, jobId, botId: sara.brickId, personId: sara.id, reservedMicros: 5_000 });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(before + 5_000);
      await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai', tokens: { input: 9000, output: 100 } }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c1` } });
      expect(event).toMatchObject({ kind: 'model_call', pool: 'computer', payerKind: 'universe', route: 'universe-ai', jobId, personKey: `person:${sara.id}`, basis: 'measured' });
      expect(Number(event.costMicros)).toBe(1_200);
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } });
      expect(room).toMatchObject({ state: 'settled' });
      expect(Number(room.settledMicros)).toBe(1_200);
    });

    it('says so when a call cost more than the room held for it, and the extra counts from then on (audit F9)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await call(token, 'c-over', 1_000)).toMatchObject({ ok: true, reservedMicros: 1_000 });
      await settleModelCall(jobId, 'c-over', { costMicros: 1_800, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c-over` } });
      expect(Number(event.costMicros)).toBe(1_800);
      expect(event.detail).toMatchObject({ overrunMicros: 800 });
      // A call that stayed inside its room says nothing of the kind
      expect(await call(token, 'c-fine', 1_000)).toMatchObject({ ok: true });
      await settleModelCall(jobId, 'c-fine', { costMicros: 900, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c-fine` } })).detail).not.toHaveProperty('overrunMicros');
    });

    it('is the same call when asked twice, and a settled call is not another', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const first = await call(token, 'c1');
      const again = await call(token, 'c1');
      expect(first.ok && again.ok).toBe(true);
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toBe(1);
      await settleModelCall(jobId, 'c1', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'provider' }, NOW);
      await settleModelCall(jobId, 'c1', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'provider' }, NOW);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:c1` } })).toBe(1);
      expect(await call(token, 'c1')).toEqual({ ok: false, reason: 'refused' });
    });

    it('is refused with the reason when the person’s allowance has no room: nothing is reserved', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // 60,000 of the 1,000,000 allowance is the job's own room: a call that asks for more than what is left is refused
      expect(await call(token, 'big', 2_000_000)).toEqual({ ok: false, reason: 'allowance' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'big') } })).toBe(0);
    });

    it('ends the job right there as the person’s when it is refused for their allowance, so a failed turn after it can never end it as ours and give back what it ran', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // 900,000 of the 1,000,000 allowance goes on the job's own calls (60,000 more is its own room)
      expect(await call(token, 'spent', 900_000)).toMatchObject({ ok: true });
      await settleModelCall(jobId, 'spent', { costMicros: 900_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect(await call(token, 'more', 100_000)).toEqual({ ok: false, reason: 'allowance' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'allowance' });
      const month = async () => (await computerView(sara.brickId, sara.id, NOW))?.month?.leftFraction as number;
      expect(await month()).toBeLessThan(0.2);
      // The runner's three failed turns on the refusal end it "failed, ours": the job is already over, so nothing is given back
      await finishJob(jobId, 'failed', NOW, 'Three turns failed', 'ours');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'allowance' });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:spent` } })).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      expect(await month()).toBeLessThan(0.2);
      await sweepComputers(minutes(30));
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:spent` } })).toMatchObject({ personKey: `person:${sara.id}` });
      expect(await month()).toBeLessThan(0.2);
    });

    it('is refused with "pool" when the platform ceiling has no room, never "ask for more"', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await setUp({ poolCeilingMicros: 70_000 });
      // Refused for its own size: there is room for a smaller call, so the pool is not full
      expect(await call(token, 'c1', 50_000)).toEqual({ ok: false, reason: 'pool', full: false });
    });

    it('says the pool is FULL only when it has no room even for the smallest call (so the relay can tell our full pool from a call too big for the room left)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // The job already holds its first stretch (60,000): a ceiling at exactly that leaves nothing for any call
      await setUp({ poolCeilingMicros: 60_000 });
      expect(await call(token, 'c1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
      // (a job none of whose calls was ever authorized is stopped by its second refusal: this one is asked as a job that had a call)
      expect(await call(token, 'c1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
      // One millionth of room left: a bigger call is refused for its size, not because the pool is full
      await setUp({ poolCeilingMicros: 60_001 });
      expect(await call(token, 'c3', 2)).toEqual({ ok: false, reason: 'pool', full: false });
    });

    describe('the pool, as the readiness check reads it', () => {
      const poolCheckNow = async (at: Date = NOW) => poolCheck(await poolStatusNow(at), at);

      it('is green while a call of the usual size fits and red once it would be refused, with every part said; the refusal and the check agree', async () => {
        // Empty: room for a call of the usual size
        await setUp({ poolCeilingMicros: 1_000_000, reserveMicros: 100_000 });
        const empty = await poolStatusNow(NOW);
        expect(empty).toMatchObject({ ceilingMicros: 1_000_000, totalMicros: 100_000, reserveMicros: 100_000, committedMicros: 0, reservedMicros: 0, leftMicros: 900_000, refusing: false, lapsed: { count: 0, micros: 0, oldestLapsedAt: null } });
        expect(await poolCheckNow()).toMatchObject({ name: 'pool', ok: true });
        // A job holding its first stretch (60,000) and a ceiling that leaves less than a usual call: red, and a real call of that size is refused for the pool
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 + USUAL_CALL_ROOM_MICROS - 1, reserveMicros: 0 });
        const full = await poolStatusNow(NOW);
        expect(full).toMatchObject({ reservedMicros: 60_000, leftMicros: USUAL_CALL_ROOM_MICROS - 1, refusing: true });
        const red = await poolCheckNow();
        expect(red).toMatchObject({ name: 'pool', ok: false });
        expect(red?.detail).toContain('would be refused for the pool');
        expect(red?.detail).toMatch(/held for steps \$0\.06/);
        expect(await authorizeModelCall({ token, callId: 'big', estimateMicros: USUAL_CALL_ROOM_MICROS, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
        // One millionth more room and the same call fits, and the check is green again
        await setUp({ poolCeilingMicros: 60_000 + USUAL_CALL_ROOM_MICROS, reserveMicros: 0 });
        expect((await poolStatusNow(NOW))?.refusing).toBe(false);
        expect(await poolCheckNow()).toMatchObject({ ok: true });
        expect((await authorizeModelCall({ token, callId: 'fits', estimateMicros: USUAL_CALL_ROOM_MICROS, payer: 'universe' }, NOW)).ok).toBe(true);
      });

      it('says the kept storage, the recorded-and-not-settled spend and the chat apart, and counts the holds that ran out and were never settled (how many, how much, how long ago the oldest ran out): a leak shows here', async () => {
        await setUp({ poolCeilingMicros: 10_000_000, reserveMicros: 500_000, storageMicrosPerGbMonth: 20_000 });
        const { jobId } = await running();
        // A hold that ran out two hours ago and a newer one that ran out ten minutes ago, neither settled nor released
        const hold = (key: string, expiresAt: Date, amountMicros: number) => prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'person:x', jobId, amountMicros, state: 'held', expiresAt, createdAt: minutes(-300) } });
        await hold(`${callRoomKey(jobId, 'old')}`, minutes(-120), 7_000);
        await hold(`${callRoomKey(jobId, 'newer')}`, minutes(-10), 3_000);
        const brickId = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).botId;
        const event = (eventId: string, kind: string, pool: 'computer' | 'chat', costMicros: number | null, extra: Record<string, unknown> = {}) =>
          recordMeterEvent({ eventId, kind, pool, occurredAt: NOW, personKey: 'person:x', personId: null, botId: null, brick: false, payerKind: 'universe', payerPersonId: null, route: null, jobId: null, quantity: 1, unit: 'call', costMicros, basis: 'measured', sourceRef: eventId, detail: null, ...extra } as never);
        // A disk of 2 GB is kept: 2 x $0.02 a month
        await event(`ev-disk-${tag}`, 'stored_bytes', 'computer', null, { botId: brickId, quantity: 2_000_000_000, unit: 'byte' });
        await event(`ev-unsettled-${tag}`, 'model_call', 'computer', 4_000);
        await event(`ev-chat-${tag}`, 'model_call', 'chat', 9_000);
        const status = await poolStatusNow(NOW);
        expect(status?.lapsed).toMatchObject({ count: 2, micros: 10_000, oldestLapsedAt: minutes(-120) });
        expect(status?.chatMicros).toBe(9_000);
        expect(status?.reserveMicros).toBe(500_000);
        // The lapsed room is inside the unsettled sum `fits` reads, and the check says it apart from the spend that is only not settled yet
        expect(status!.unsettledMicros).toBe(4_000 + 10_000);
        const check = poolCheck(status, NOW);
        expect(check.detail).toContain('held rooms that ran out and were never settled or given up $0.01 (2, the oldest ran out 2 h ago)');
        expect(check.detail).toContain('recorded and not settled $0.004');
        expect(check.detail).toContain('chat $0.009 is kept apart');
        expect(check.detail).toContain('reserve $0.50');
        expect(check.detail).toContain('kept storage $0.04');
        expect(status?.keptStorageMicros).toBe(40_000);
      });

      it('counts the holds that ran out from the very rows the unsettled spend counts them from: a hold released while the pool is being read can never leave "recorded and not settled" negative (CodeRabbit)', async () => {
        await setUp({ poolCeilingMicros: 10_000_000, reserveMicros: 0 });
        const { jobId } = await running();
        const key = callRoomKey(jobId, 'gone');
        await prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'person:x', jobId, amountMicros: 10_000, state: 'held', expiresAt: minutes(-120), createdAt: minutes(-300) } });
        // The hold is released while the pool is being read, before the envelope reads the reservations: with two independent reads, the lapsed holds were counted by one (10,000) and the other saw none (0 unsettled)
        const real = prisma.meterReservation.findMany.bind(prisma.meterReservation);
        const readers = jest.spyOn(prisma.meterReservation, 'findMany').mockImplementation(((args: never) =>
          new Promise((resolve) => setTimeout(resolve, 300))
            .then(() => prisma.meterReservation.updateMany({ where: { reservationKey: key }, data: { state: 'released', closedAt: NOW } }))
            .then(() => real(args))) as never);
        const status = await poolStatusNow(NOW);
        readers.mockRestore();
        expect(status!.unsettledMicros - status!.lapsed.micros).toBeGreaterThanOrEqual(0);
        expect(poolCheck(status, NOW).detail).not.toMatch(/-\$|\$-/);
      });

      it('is part of the readiness: not ready while a new call would be refused, and the parts are given beside the checks', async () => {
        const { jobId } = await running();
        expect(jobId).toBeTruthy();
        await setUp({ poolCeilingMicros: 60_000, reserveMicros: 0 });
        const answer = await computerReadiness();
        expect(answer.ready).toBe(false);
        expect(answer.checks.find((check) => check.name === 'pool')).toMatchObject({ ok: false });
        expect(answer.pool).toMatchObject({ ceilingMicros: 60_000, refusing: true });
      });
    });

    describe('a job every call of which is refused for our own pool (dev staging: pool refusals, every turn failing)', () => {
      const poolRows = (jobId: string) => prisma.computerJobFault.findMany({ where: { jobId, callId: { startsWith: 'orbit:pool:' } }, orderBy: { callId: 'asc' } });
      const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      const timeOf = (jobId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } });

      it('keeps a confirmed fault of ours for each refused call (a retried call once) and stops the job on the second: ended as pool, given back, never counted, in the words the person is told', async () => {
        const { sara, jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        // The first refused call: kept as a fault of ours, the job still running (a first turn may be one unlucky moment)
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'fault', reason: 'pool_busy', source: 'universe-ai', turn: null, run: null, providerStatus: 503 }]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // The same call asked again (a retry) is the same call: still one row, still running
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toHaveLength(1);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // A second call refused: every call this job made was refused, so it stops here, as ours
        expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toHaveLength(2);
        const ended = await jobOf(jobId);
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false, endNote: POOL_BUSY_WORDS });
        // Given back in full by Orbit's own decision, which counts for nothing against the person's bound
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
        expect((await timeOf(jobId)).personKey).toBe('unknown');
        // Whatever the runner says after it changes nothing (a job that is over is not ended again)
        await finishJob(jobId, 'failed', NOW, 'Three turns failed', 'agent');
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        // What the person reads: the Activity line and the report in chat
        const seen = (await activityFor(sara.id)).find((item) => item.id === `act_job_${jobId}`);
        expect(seen?.outcomeText).toBe('Stopped: our computers were busy, and its time was given back');
        const told = (await reportsToTell(50, minutes(60 * 24))).find((report) => report.jobId === jobId);
        expect(told).toMatchObject({ kind: 'failed', givenBack: true, why: POOL_BUSY_WORDS });
      });

      it('is given back at the goodwill cap too (it uses none of it)', async () => {
        // A bound of nothing: a goodwill give-back would be refused for the cap at once; this one is ours and never asks
        await seedGiveBackLimits({ goodwillPerPersonPerMonth: 0 });
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        await call(token, 'c1', 1_000);
        await call(token, 'c2', 1_000);
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false });
        expect((await timeOf(jobId)).personKey).toBe('unknown');
      });

      it('never stops a job that has had a call authorized (a refusal in the middle of its work is left to the relay and the job’s own renewal), and keeps no row of its own for it', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        expect((await call(token, 'ok-1')).ok).toBe(true);
        await setUp({ poolCeilingMicros: 60_000 });
        for (const id of ['c1', 'c2', 'c3', 'c4']) expect(await call(token, id, 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('counts a call refused because its route is paused (our decision) the same way', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // One person's job had a provider failure on the route in the window: with a bound of one person, new work on it waits
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const paused = (id: string) => authorizeModelCall({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route: 'universe-ai/slow' }, NOW);
        expect(await paused('c1')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', route: 'universe-ai/slow' }]);
        expect(await paused('c2')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        expect(await jobOf(other.jobId)).toMatchObject({ status: 'running' });
      });

      it('a refusal for the call’s own SIZE (the room left is smaller than the call asks, the pool not full) is no fault of ours: no row, and never a stop, however many such calls (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // One millionth of room is left: a call of two is refused for its size, and so is the next, and the next
        await setUp({ poolCeilingMicros: 60_001 });
        for (const id of ['s1', 's2', 's3']) expect(await call(token, id, 2)).toEqual({ ok: false, reason: 'pool', full: false });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // A pool with no room even for the smallest call IS ours: kept, and the second stops the job
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await call(token, 'f1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await poolRows(jobId)).toHaveLength(1);
      });

      it('a call on the person’s own key that was authorized counts as an authorized call: two platform-funded refusals after it never stop the job (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // Authorized, its report not here yet: it left only the marker
        expect(await authorizeModelCall({ token, callId: 'own-1', estimateMicros: 5_000, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
        await setUp({ poolCeilingMicros: 60_000 });
        for (const id of ['c1', 'c2', 'c3']) expect(await call(token, id, 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('a call authorized while a cutoff is deciding is never cancelled by it: the cutoff that won refuses the call and gives its room back, never both (CodeRabbit)', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // The route `slow` is paused for new work (our decision); `fast` has room
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const on = (route: string, id: string) => authorizeModelCall({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route }, NOW);
        expect(await on('universe-ai/slow', 'c1')).toEqual({ ok: false, reason: 'pool', full: true });
        // The second refusal is the cutoff; it is held at the moment it stops the job (its first write to the job)
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const real = prisma.computerJob.updateMany.bind(prisma.computerJob);
        const hold = jest.spyOn(prisma.computerJob, 'updateMany').mockImplementationOnce(((args: never) => gate.then(() => real(args))) as never);
        const cutoff = on('universe-ai/slow', 'c2');
        // Meanwhile a call on the route with room is authorized: its room is taken, and it must now wait for the cutoff
        const meanwhile = on('universe-ai/fast', 'c3');
        for (let tries = 0; tries < 100 && !(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c3') } })); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c3') } })).toMatchObject({ state: 'held' });
        open();
        expect(await cutoff).toEqual({ ok: false, reason: 'pool', full: true });
        // The cutoff won (it had counted no authorized call): the job is ended as ours, and the call that came in during it is refused, its room back
        expect(await meanwhile).toEqual({ ok: false, reason: 'refused' });
        hold.mockRestore();
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c3') } })).toMatchObject({ state: 'released' });
      });

      it('a call authorized before the cutoff counted is seen by it: the job is not stopped (the other half of the same race)', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const on = (route: string, id: string) => authorizeModelCall({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route }, NOW);
        expect(await on('universe-ai/slow', 'c1')).toEqual({ ok: false, reason: 'pool', full: true });
        // A call on the route with room is authorized (and the first refusal recovers); the second refusal then finds an authorized call
        expect((await on('universe-ai/fast', 'c2')).ok).toBe(true);
        expect(await on('universe-ai/slow', 'c3')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await on('universe-ai/slow', 'c4')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('a refusal that capacity recovered from stops deciding the turns after it: the row is retired when a later call is authorized, so a turn that failed for the agent’s own reason is not ours (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'fault' }]);
        // Capacity is back: the next call is authorized, and the refusal stops counting (kept as evidence, read by no ruling)
        await setUp({ poolCeilingMicros: 100_000_000 });
        expect((await call(token, 'c2')).ok).toBe(true);
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'answered', reason: 'pool_recovered' }]);
        // A later turn fails for the agent's own reason: not a fault of ours
        await finishJob(jobId, 'failed', NOW, 'It gave up', 'agent', [5]);
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      });

      it('is judged job by job: one job’s refusals never stop another', async () => {
        const a = await running('ann');
        const b = await running('bea');
        const keyA = ((await mintJobToken(a.jobId, 'model', NOW)) as { token: string }).token;
        await setUp({ poolCeilingMicros: 60_000 });
        await call(keyA, 'c1', 1_000);
        expect(await poolRows(b.jobId)).toEqual([]);
        await call(keyA, 'c2', 1_000);
        expect(await jobOf(a.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        expect(await jobOf(b.jobId)).toMatchObject({ status: 'running' });
      });
    });

    it('is not another job running: a call does not use up the jobs allowed at once', async () => {
      await setUp({ atOnceMember: 1, atOnceAll: 1 });
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await call(token, 'c1')).ok).toBe(true);
      expect((await call(token, 'c2')).ok).toBe(true);
      expect((await currentEnvelope(NOW)).jobsRunning).toBe(1);
    });

    it('is refused for a key that ended, with nothing reserved', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await call(token, 'c1')).toEqual({ ok: false, reason: 'refused' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toBe(0);
    });

    it('is refused for a call id or an estimate that is not one', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await call(token, 'has space')).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'x'.repeat(81))).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'c1', 0)).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'c2', 1.5)).toEqual({ ok: false, reason: 'refused' });
    });

    it('settles at the room held when the price is unknown, never at 0, and records it as unknown', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'c1', 7_000);
      await settleModelCall(jobId, 'c1', { costMicros: null, basis: 'unknown', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c1` } });
      expect(event.costMicros).toBeNull();
      expect(event.basis).toBe('unknown');
      expect(Number((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).settledMicros)).toBe(7_000);
    });

    it('a call on the owner’s own key takes no room from the pool, and is recorded as paid by them', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const before = (await currentEnvelope(NOW)).reservedMicros;
      const authorized = await authorizeModelCall({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
      expect(authorized).toMatchObject({ ok: true, reservedMicros: null });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(before);
      await settleModelCall(jobId, 'k1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:k1` } });
      expect(event).toMatchObject({ payerKind: 'person', payerPersonId: sara.id, basis: 'paid_by_other', pool: 'computer' });
      // The platform's computer pool does not count it
      const universeCost = await prisma.meterEvent.aggregate({ where: { pool: 'computer', payerKind: 'universe', kind: 'model_call' }, _sum: { costMicros: true } });
      expect(Number(universeCost._sum.costMicros ?? 0)).toBe(0);
    });

    it('is settled even after the job ended: a call that finished late is still counted', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late', 5_000);
      await finishJob(jobId, 'done', NOW);
      expect(await settleModelCall(jobId, 'late', { costMicros: 300, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai', cutShort: true }, NOW)).toEqual({ ok: true });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:late` } })).toBe(1);
    });

    it('settling a call nobody authorized writes nothing', async () => {
      const { jobId } = await running();
      expect(await settleModelCall(jobId, 'ghost', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: false, reason: 'unknown_call' });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:ghost` } })).toBe(0);
    });

    it('gives the room back when the call was never sent', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'c1', 5_000);
      await releaseModelCall(jobId, 'c1', NOW);
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:c1` } })).toBe(0);
    });

    it('the sweep settles room held for a call that never reported back, as unknown at the room held', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'lost', 9_000);
      await sweepComputers(minutes(30));
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'lost') } });
      expect(room.state).toBe('settled');
      expect(Number(room.settledMicros)).toBe(9_000);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:lost` } });
      expect(event).toMatchObject({ basis: 'unknown', costMicros: null });
    });

    it('a report that comes after the sweep wrote the call as unknown replaces the unknown figure, and never a figure that was written', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late', 9_000);
      await sweepComputers(minutes(30));
      const facts = { costMicros: 4_000, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const };
      expect(await settleModelCall(jobId, 'late', facts, minutes(31))).toEqual({ ok: true });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late` } })).toMatchObject({ basis: 'measured', costMicros: BigInt(4_000) });
      // A second report, even with another figure, leaves what was written
      expect(await settleModelCall(jobId, 'late', { ...facts, costMicros: 7_000 }, minutes(32))).toEqual({ ok: true });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late` } })).toMatchObject({ costMicros: BigInt(4_000) });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:late` } })).toBe(1);
    });

    it('a late report that cost more than the room held keeps the overrun beside the figure', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late-over', 9_000);
      await sweepComputers(minutes(30));
      const facts = { costMicros: 12_000, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const };
      expect(await settleModelCall(jobId, 'late-over', facts, minutes(31))).toEqual({ ok: true });
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late-over` } });
      expect(event).toMatchObject({ basis: 'measured', costMicros: BigInt(12_000) });
      expect(event.detail).toMatchObject({ overrunMicros: 3_000 });
    });

    it('settles the room at the cost the books hold for the call, also when a report is sent again with another figure after the first one wrote the event and did not settle', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'again', 9_000);
      // The first report wrote its event (4,000) and stopped before the room was settled
      await recordMeterEvent({ eventId: `computer:${jobId}:call:again`, kind: 'model_call', pool: 'computer', occurredAt: NOW, personKey: `person:${(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).personId}`, personId: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).personId, botId: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).botId, brick: true, payerKind: 'universe', route: 'universe-ai', jobId, quantity: 1, unit: 'call', costMicros: 4_000, basis: 'measured', sourceRef: `computer_jobs:${jobId}`, payerPersonId: null, detail: null });
      expect(await settleModelCall(jobId, 'again', { costMicros: 1_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: true });
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'again') } });
      expect(room.state).toBe('settled');
      // The books say 4,000, so that is what the room settles at, not the 1,000 of the second report
      expect(Number(room.settledMicros)).toBe(4_000);
    });

    it('the sweep gives back room held for a call whose job is gone, instead of finding it again on every sweep', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'orphan', 7_000);
      await prisma.computerJob.delete({ where: { id: jobId } });
      await sweepComputers(minutes(30));
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'orphan') } });
      expect(room.state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:orphan` } })).toBe(0);
    });
  });

  describe('the model calls of a job that failed on our side', () => {
    const facts = (costMicros: number) => ({ costMicros, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const });
    const callEvent = (jobId: string, callId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:${callId}` } });
    /** A call that was sent and settled while the job ran. */
    const settledCall = async (jobId: string, callId: string, cost: number) => {
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId, estimateMicros: 5_000, payer: 'universe' }, NOW);
      await settleModelCall(jobId, callId, facts(cost), NOW);
    };

    it('are not taken from the person’s month, and stay in the books as our own cost, written against nobody', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await settledCall(jobId, 'c2', 3_000);
      // While it runs they are the person's
      expect((await callEvent(jobId, 'c1')).personKey).toBe(`person:${sara.id}`);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      for (const [callId, cost] of [['c1', 1_200], ['c2', 3_000]] as const) {
        const event = await callEvent(jobId, callId);
        expect(event).toMatchObject({ kind: 'model_call', pool: 'computer', payerKind: 'universe', personKey: 'unknown', personId: null, jobId, costMicros: BigInt(cost) });
        expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id });
      }
      // Their month is whole, the calls' room is settled (not left held), and our exposure still counts what the providers billed
      expect((await computerView(sara.brickId, sara.id, minutes(5)))?.month?.leftFraction).toBe(1);
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}`, state: 'held' } })).toBe(0);
      expect((await currentEnvelope(minutes(5))).unsettledMicros).toBeGreaterThanOrEqual(30_000 + 4_200);
      // Asked again, it changes nothing more
      const [item] = await activityFor(sara.id);
      expect(item).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('stay the person’s when the runner says the job failed with no cause, or that the agent gave up or ran out of turns: only a cause that is ours gives back', async () => {
      for (const cause of [undefined, null, 'agent'] as const) {
        const { sara, jobId } = await running();
        await settledCall(jobId, 'c1', 1_200);
        await finishJob(jobId, 'failed', minutes(5), 'The agent gave up', cause);
        expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
        await sweepComputers(minutes(30));
        expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
        expect(await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `computer:${jobId}:time` } })).toMatchObject({ personId: sara.id });
        await prisma.computerJob.deleteMany({ where: { id: jobId } });
      }
    });

    it('are written against nobody when the report comes after the job failed (a call that finished late)', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'late', estimateMicros: 5_000, payer: 'universe' }, NOW);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      expect(await settleModelCall(jobId, 'late', { ...facts(2_500), cutShort: true }, minutes(6))).toEqual({ ok: true });
      const event = await callEvent(jobId, 'late');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(2_500) });
      expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id, cutShort: true });
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBe(1);
    });

    it('are given back when the worker was lost: the sweep stops the job, and the call it never heard back from is written against nobody too', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'done1', 1_000);
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'error' });
      expect(await callEvent(jobId, 'done1')).toMatchObject({ personKey: 'unknown', personId: null });
      expect(await callEvent(jobId, 'lost')).toMatchObject({ personKey: 'unknown', personId: null, costMicros: null, basis: 'unknown' });
      expect((await computerView(sara.brickId, sara.id, minutes(60)))?.month?.leftFraction).toBe(1);
    });

    it('one job whose give-back throws does not skip the others of the sweep’s batch: it is said, and the rest are still given back', async () => {
      const first = await running('sara');
      const second = await running('tom');
      for (const { jobId } of [first, second]) {
        await settledCall(jobId, 'c1', 1_200);
        await finishJob(jobId, 'failed', minutes(5), null, 'ours');
        // The give-back of the end did not go through (or a call was recorded in the same moment): the call is still written against the person
        await prisma.meterEvent.updateMany({ where: { jobId, kind: 'model_call' }, data: { personKey: `person:${jobId === first.jobId ? first.sara.id : second.sara.id}`, personId: jobId === first.jobId ? first.sara.id : second.sara.id } });
      }
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      (giveBackModelCalls as jest.Mock).mockClear();
      (giveBackModelCalls as jest.Mock).mockRejectedValueOnce(new Error('The books are down'));
      await sweepComputers(minutes(30));
      logged.mockRestore();
      const calls = (giveBackModelCalls as jest.Mock).mock.calls.map((c) => c[0] as string);
      // Both were tried: the one that threw did not end the batch
      expect([...calls].sort()).toEqual([first.jobId, second.jobId].sort());
      const [thrown, rest] = calls;
      expect(await callEvent(rest, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
      // The one that failed is still the person's, so the next sweep finds it again and gives it back
      expect((await callEvent(thrown, 'c1')).personKey).not.toBe('unknown');
      await sweepComputers(minutes(31));
      expect(await callEvent(thrown, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
    });

    it('a report that replaces an unknown figure keeps the call given back', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      await settleModelCall(jobId, 'lost', facts(4_000), minutes(61));
      const event = await callEvent(jobId, 'lost');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(4_000), basis: 'measured' });
      expect(event.detail).toMatchObject({ givenBack: true });
    });

    it('a report that read the job as still running does not wipe a give-back made in the meantime, and still drops what the sweep guessed', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      // The sweep wrote it as unknown, cut short, and given back
      expect((await callEvent(jobId, 'lost')).detail).toMatchObject({ givenBack: true, cutShort: true });
      // A report that read the job while it still ran (so it carries no give-back of its own) comes after
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementationOnce(((args: never) => real({ ...(args as object), where: { id: jobId } }).then((job: unknown) => ({ ...(job as object), status: 'running', endedBy: null }))) as never);
      await settleModelCall(jobId, 'lost', { ...facts(4_000), tokens: { input: 10, output: 2 } }, minutes(61));
      spy.mockRestore();
      const event = await callEvent(jobId, 'lost');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(4_000), basis: 'measured' });
      expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id, tokens: { input: 10, output: 2 } });
      // This report was not cut short, so the sweep's own mark is gone
      expect(event.detail).not.toHaveProperty('cutShort');
    });

    it('stay the person’s when the job ran fine or the person stopped it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const done = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!done.ok) throw new Error('no');
      await settledCall(done.job.id, 'c1', 1_200);
      await finishJob(done.job.id, 'done', minutes(5));
      expect(await callEvent(done.job.id, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      expect((await callEvent(done.job.id, 'c1')).detail).not.toHaveProperty('givenBack');

      const stopped = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(6));
      if (!stopped.ok) throw new Error('no');
      await settledCall(stopped.job.id, 'c2', 700);
      await stopJobFor(sara.brickId, sara.id, minutes(9));
      expect(await callEvent(stopped.job.id, 'c2')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      // Their month has both jobs' calls and minutes taken from it
      const left = (await computerView(sara.brickId, sara.id, minutes(9)))?.month?.leftFraction ?? 1;
      expect(left).toBeLessThan(1 - (1_200 + 700) / 1_000_000);
    });

    it('do not touch a call on the owner’s own key (it was never the platform’s cost or the person’s allowance)', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeModelCall({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
      await settleModelCall(jobId, 'k1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      expect(await callEvent(jobId, 'k1')).toMatchObject({ payerKind: 'person', payerPersonId: sara.id, personKey: `person:${sara.id}` });
    });

    it('are found by a later sweep when the give-back at the end did not go through, and Activity does not say refunded until then', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      // Put it back as it would be had the give-back write failed
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBeLessThan(1);
      // A call that still draws from the month is something taken: not "nothing taken"
      expect((await activityFor(sara.id))[0].state).not.toBe('refunded');
      await sweepComputers(minutes(7));
      expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(1_200) });
      expect((await computerView(sara.brickId, sara.id, minutes(7)))?.month?.leftFraction).toBe(1);
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('are found by a sweep however long after the job failed, so a person is never left charged for them', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      await sweepComputers(minutes(5 + 40 * 24 * 60));
      expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
    });

    it('is the receipt’s state even when the job is not among the newest jobs listed: the receipts and the jobs are each cut to the newest few', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const older = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Older' }, NOW);
      if (!older.ok) throw new Error('no');
      await finishJob(older.job.id, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: older.job.id, title: 'Older', category: 'computer', state: 'done', chargedMicros: BigInt(30_000), payerKind: 'person', payerPersonId: sara.id, startedAt: minutes(10), endedAt: minutes(20) } });
      // A newer job than the older one (but ended before the receipt did) takes the only place in the job list of one
      const newer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Newer' }, minutes(12));
      if (!newer.ok) throw new Error('no');
      await finishJob(newer.job.id, 'done', minutes(15));
      const items = await activityFor(sara.id, 1);
      // The receipt is the newest line, though its job was cut from the job list by the limit
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ title: 'Older', state: 'refunded', spentMicros: null });
    });

    it('a receipt already stored as refunded does not read as refunded while a platform-paid call of the job is still on the person', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Visa form', category: 'computer', state: 'refunded', payerKind: 'person', payerPersonId: sara.id, startedAt: NOW, endedAt: minutes(5) } });
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      expect((await activityFor(sara.id))[0].state).toBe('done');
      await sweepComputers(minutes(7));
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('is the receipt’s own state too: a job with a receipt of its own whose time was given back shows as refunded, not with the charge the receipt stored', async () => {
      const { sara, jobId } = await running();
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Visa form', category: 'computer', state: 'done', chargedMicros: BigInt(30_000), payerKind: 'person', payerPersonId: sara.id, startedAt: NOW, endedAt: minutes(5) } });
      const items = await activityFor(sara.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ title: 'Visa form', state: 'refunded', spentMicros: null });
    });

  });
});
