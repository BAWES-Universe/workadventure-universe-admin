/**
 * What a Brick's computer may ask of Orbit, against a real database (build handoff v2, section 5): its key, and a model call's
 * room and books. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-calls-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { currentEnvelope } from '@/lib/meter-allowance';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, handBack, renewJob, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { activityFor } from '@/lib/task-receipts';
import { TOKEN_LIFE_MS, forgetOldTokens, mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { authorizeModelCall, callRoomKey, releaseModelCall, settleModelCall } from '@/lib/computer-calls';

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
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(new FakeComputerProvider());
    await setUp();
  });
  afterAll(async () => {
    await wipe();
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
      expect(await call(token, 'c1', 50_000)).toEqual({ ok: false, reason: 'pool' });
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
