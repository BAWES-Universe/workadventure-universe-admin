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
import { finishJob, giveComputer, handBack, renewJob, startJob, sweepComputers, takeOver } from '@/lib/computer';
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
      // A key made while the person has the machine is for an older number once they hand it back
      const during = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await verifyJobToken(during.token, 'model', NOW)).ok).toBe(true);
      await handBack(sara.brickId, sara.id);
      expect(await verifyJobToken(during.token, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
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
  });
});
