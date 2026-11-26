/**
 * Credit for computers, against the real books: a gift (or an exception) that covers computers is read by the computer's own spending.
 * A computer's month is the allowance, and beside it the credit given on purpose, which is drawn first; what a call or a job's time cost
 * beyond it falls on the allowance. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-credit-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

// The give-back can be made to fail once (the books unreachable for a moment); everything else in the funding books is the real one
jest.mock('@/lib/credit-spend', () => {
  const actual = jest.requireActual('@/lib/credit-spend');
  return { ...actual, refundHold: jest.fn(actual.refundHold) };
});
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { attemptRefundObligation, recordRefundObligationsForBrick, refundKeyOf, refundOverview, refundStatesFor, retryRefundObligation, sweepRefundObligations } from '@/lib/computer-refunds';
import { giveBackReadiness } from '@/lib/computer-fault-ops';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { memberAllowance } from '@/lib/meter-allowance';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { machineDoesSignIns } from '../helpers/working-signins';
import { claimJob, finishJob, giveComputer, renewJob, startJob, stopJobFor, sweepComputers } from '@/lib/computer';
import { mintJobToken } from '@/lib/computer-token';
import { recordFaults } from '@/lib/computer-faults';
import { afterLateEvidence } from '@/lib/computer-giveback';
import * as calls from '@/lib/computer-calls';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { reserveRoom } from '@/lib/meter-allowance';
import { computerCredit, giveBackComputerCredit } from '@/lib/computer-credit';
import { createGiftFor, saveDefaultFor } from '@/lib/grants-admin';
import { endGift } from '@/lib/grants-admin';
import { saveException } from '@/lib/credit-rules';
import * as creditSpend from '@/lib/credit-spend';
import { holdCredit, settleHold } from '@/lib/credit-spend';
import { ensureIssued } from '@/lib/credit-issue';
import { personUsage } from '@/lib/meter-person';
import { memberUsage } from '@/lib/meter-usage';
import { WorkerDied, afterWorkerDied } from '../helpers/worker-died';
import { activityFor, closeReceipt, openReceipt, settleCheckingReceipts } from '@/lib/task-receipts';
import { OUTCOME_WORDS } from '@/lib/task-receipt-words';
import { reportsToTell } from '@/lib/computer-report';
import { pauseJob, resumeJob } from '@/lib/computer-job-controls';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
// What happens to a failed job's calls is the release's own rule (`giveBackModelCalls`); the part that needs it runs where it is
const givesBack = typeof (calls as Record<string, unknown>).giveBackModelCalls === 'function';
const failedOnOurSide = (jobId: string, at: Date) => (finishJob as (...args: unknown[]) => Promise<unknown>)(jobId, 'failed', at, null, 'ours');

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const people: string[] = [];
let made = 0;
let issuer: { userId: string; superAdmin: true };
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

/**
 * The month's allowance is small on purpose: a pretend minute costs 6,000 millionths, so a job's first stretch (10 minutes) holds 60,000 of the 100,000,
 * and a call that may cost 50,000 is more than the 40,000 left.
 */
const BASE = 100_000;
const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings(
    {
      memberAllowanceMicros: BASE,
      poolCeilingMicros: 100_000_000,
      reserveMicros: 0,
      storageMicrosPerGbMonth: 0,
      atOnceMember: 100,
      atOnceAll: 100,
      renewMinutes: 10,
      rolloutBudgetMicros: 1_000_000_000_000,
      ...over,
    },
    'admin',
  );

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_refunds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_allocations');
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_lots');
  await prisma.$executeRawUnsafe('DELETE FROM grant_recipients');
  await prisma.$executeRawUnsafe('DELETE FROM grant_rules');
  await prisma.$executeRawUnsafe('DELETE FROM grant_programs');
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

/** A gift of credit to one person (or two), for computers, Apps and computers, or Apps. */
const gift = (userIds: string[], scope: 'computers' | 'both' | 'apps', amountMicros: number, endsInDays = 10) =>
  createGiftFor(
    { what: 'gift', audience: { kind: 'people', userIds }, scope, amountMicros, shared: false, endsAt: new Date(NOW.getTime() + endsInDays * DAY).toISOString() } as never,
    issuer,
    NOW,
  );

async function running(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  return sara;
}

/** A job that holds the machine, and the key its model calls carry. */
async function job(sara: { id: string; brickId: string }) {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
  if (!started.ok) throw new Error(`the job did not start: ${started.reason}`);
  const minted = (await mintJobToken(started.job.id, 'model', NOW)) as { token: string };
  return { jobId: started.job.id, token: minted.token };
}

const call = async (token: string, callId: string, estimateMicros: number, costMicros: number | null, at: Date = NOW) => {
  const authorized = await authorizeModelCall({ token, callId, estimateMicros, payer: 'universe' }, at);
  if (!authorized.ok) return authorized;
  await settleModelCall(authorized.jobId, callId, { costMicros, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, at);
  return authorized;
};

const month = async (personId: string, at: Date = NOW) => (await memberAllowance(personId, at, await getMeterSettings()))!;

run('credit for computers, on the real books', () => {
  beforeAll(async () => {
    process.env.COMPUTER_PROVIDER = 'fake';
    const admin = await prisma.user.create({ data: { uuid: `credit-admin-${tag}`, email: `credit-admin-${tag}@example.test`, name: 'Khalid' } });
    people.push(admin.id);
    issuer = { userId: admin.id, superAdmin: true };
  });
  beforeEach(async () => {
    // The give-back is the real one again, whatever a test did to it
    (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(jest.requireActual('@/lib/credit-spend').refundHold);
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    const fake = new FakeComputerProvider();
    // The pretend machine does its browser work (park, restore, empty): this suite is about the money, not about a machine that refuses
    machineDoesSignIns(fake);
    setComputerProviderForTests(fake);
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

  describe('a gift for computers', () => {
    it('is saved, and a person whose month is used up can start a call on it', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      // The month alone has 40,000 left after the job's first stretch: room for a call that may cost 50,000 is refused, and the person is told to ask for more
      expect(await reserveRoom({ key: `before-${tag}`, personId: sara.id, amountMicros: 50_000, jobId, newJob: false }, NOW)).toMatchObject({ ok: false, reason: 'allowance' });
      const saved = await gift([sara.id], 'computers', 1_000_000);
      expect(saved).toMatchObject({ kind: 'gift', categoryId: 'computers' });
      expect(saved.covers).toEqual(['computers']);
      // Nothing was issued by saving it: it reaches the person the first time their credit is looked at, and a refused call looks
      const room = await authorizeModelCall({ token, callId: 'after', estimateMicros: 50_000, payer: 'universe' }, NOW);
      expect(room).toMatchObject({ ok: true, jobId, reservedMicros: 50_000 });
    });

    it('is drawn when a call costs, before the month: the month is left as it was', async () => {
      const sara = await running();
      const { token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      const before = await month(sara.id);
      expect(before.baseMicros).toBe(BASE);
      await call(token, 'one', 50_000, 30_000);
      const after = await month(sara.id);
      // 30,000 came from the gift; the allowance has all of its month
      expect(await computerCredit(prisma as never, sara.id, NOW)).toMatchObject({ availableMicros: 1_000_000 - 30_000 });
      expect(after.creditMicros).toBe(1_000_000 - 30_000);
      expect(after.leftMicros).toBe(BASE + 1_000_000 - 30_000);
      const hold = await prisma.creditHold.findFirstOrThrow({ where: { personId: sara.id, category: 'computers' } });
      expect(hold).toMatchObject({ state: 'settled', chargeClass: 'computer_model', effectKey: expect.stringContaining(':call:one') });
      expect(Number(hold.customerMicros)).toBe(30_000);
    });

    it('is drawn once for a call, however many times the call is settled', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'once', 50_000, 30_000);
      for (let i = 0; i < 3; i++) await settleModelCall(jobId, 'once', { costMicros: 30_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect(await prisma.creditHold.count({ where: { personId: sara.id, category: 'computers' } })).toBe(1);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000 - 30_000);
    });

    it('covers what it can of a call, and the rest of the call falls on the month', async () => {
      const sara = await running();
      const { token } = await job(sara);
      await gift([sara.id], 'computers', 10_000);
      await call(token, 'big', 15_000, 15_000);
      const after = await month(sara.id);
      expect(after.creditMicros).toBe(0);
      // 10,000 came from the gift and 5,000 from the month
      expect(after.leftMicros).toBe(BASE - 5_000);
    });

    it('is drawn for a computer’s own time too', async () => {
      const sara = await running();
      await gift([sara.id], 'computers', 1_000_000);
      const { jobId } = await job(sara);
      // Ten pretend minutes at 6,000 each
      await finishJob(jobId, 'done', new Date(NOW.getTime() + 10 * 60_000));
      const hold = await prisma.creditHold.findFirstOrThrow({ where: { personId: sara.id, category: 'computers', jobKey: jobId } });
      expect(hold).toMatchObject({ state: 'settled', chargeClass: 'computer_job' });
      expect(Number(hold.customerMicros)).toBe(60_000);
      const after = await month(sara.id, new Date(NOW.getTime() + 10 * 60_000));
      expect(after.leftMicros).toBe(BASE + 1_000_000 - 60_000);
    });

    it('is one dollar for Apps and computers when it covers both: what Apps spent is gone for computers, and the other way round', async () => {
      const sara = await running();
      const { token } = await job(sara);
      await gift([sara.id], 'both', 100_000);
      await ensureIssued(sara.id, NOW);
      const apps = await holdCredit({ holdKey: `apps-${tag}`, personId: sara.id, category: 'instant_apps', amountMicros: 70_000, chargeClass: 'instant_run' }, NOW);
      expect(apps.ok).toBe(true);
      await settleHold({ holdKey: `apps-${tag}`, customerMicros: 70_000 }, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(30_000);
      await call(token, 'both', 50_000, 30_000);
      // All of it is spent now: Apps has none left
      expect(await holdCredit({ holdKey: `apps2-${tag}`, personId: sara.id, category: 'instant_apps', amountMicros: 1, chargeClass: 'instant_run' }, NOW)).toMatchObject({
        ok: false,
        reason: 'credit_used_up',
      });
    });

    it('is not counted once it ended: a gift past its end covers nothing, and nor does one that ended before it reached the person', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000, 5);
      void token;
      const expired = new Date(NOW.getTime() + 6 * DAY);
      // (the job's own key lives 15 minutes, so the room is asked for as the books are asked: for the person)
      expect(await reserveRoom({ key: `late-${tag}`, personId: sara.id, amountMicros: 50_000, jobId, newJob: false }, expired)).toMatchObject({ ok: false, reason: 'allowance' });
      expect((await month(sara.id, expired)).creditMicros).toBe(0);
      // Ended by an admin before the person was ever looked at: nothing was issued, so there is nothing to draw
      const other = await running('omar');
      const second = await job(other);
      const program = await gift([other.id], 'computers', 1_000_000);
      expect(await endGift(program.programId, issuer, NOW)).toBe('ended');
      expect(await authorizeModelCall({ token: second.token, callId: 'ended', estimateMicros: 50_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'allowance' });
      expect((await month(other.id)).creditMicros).toBe(0);
    });

    it('is in the usage a person is shown: what is left of it and what it was, with their month', async () => {
      const sara = await running();
      const { token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'bar', 50_000, 30_000);
      const usage = await personUsage(sara.id, NOW);
      expect(usage.allowanceMicros).toBe(BASE + 1_000_000);
      // Not the whole month and gift less what was spent: what new work can take is what is left less the room the job holds (its first stretch, 60,000)
      // What new work can take: what is left less the room the job holds (its first stretch, 60,000). Where the usage says it
      if ('leftMicros' in usage) expect((usage as { leftMicros: number | null }).leftMicros).toBe(BASE + 1_000_000 - 30_000 - 60_000);
    });

    it('is only the person’s own: another person’s gift never pays for it', async () => {
      const sara = await running();
      const omar = await running('omar');
      const { token } = await job(omar);
      await gift([sara.id], 'computers', 1_000_000);
      expect(await authorizeModelCall({ token, callId: 'x', estimateMicros: 50_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'allowance' });
    });

    it('is given back with the job that failed on our side: the lot has it again, and asked twice it is given once', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(950_000);
      await giveBackComputerCredit(jobId, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      await giveBackComputerCredit(jobId, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      // The credit's own give-back never takes anything from the month: the calls are still the person's here (the release's rule writes them against nobody
      // when a job fails on our side), so the month has what they cost beyond what credit paid, and credit paid all of it
      expect((await month(sara.id)).leftMicros).toBe(BASE - 50_000 + 1_000_000);
      await prisma.$executeRawUnsafe(`UPDATE meter_events SET person_key = 'unknown', person_id = NULL WHERE job_id = '${jobId}'`);
      expect((await month(sara.id)).leftMicros).toBe(BASE + 1_000_000);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(holds.map((hold) => Number(hold.refundedMicros)).sort()).toEqual([20_000, 30_000]);
    });

    it('is given back by itself when a job fails on our side: every call it drew for is put back, its time draws none, and asked twice it is once', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(950_000);
      await failedOnOurSide(jobId, new Date(NOW.getTime() + 10 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      // Ten minutes of the machine were held and drew nothing, because the job failed on our side
      expect(await prisma.creditHold.count({ where: { jobKey: jobId, chargeClass: 'computer_job' } })).toBe(0);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(holds.map((hold) => Number(hold.refundedMicros)).sort()).toEqual([20_000, 30_000]);
      // Said again (a second end, a sweep): nothing more is given
      await failedOnOurSide(jobId, new Date(NOW.getTime() + 11 * 60_000));
      await giveBackComputerCredit(jobId, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
      // A call that reports after the job failed: its draw is put back too
      await settleModelCall(jobId, 'late', { costMicros: 10_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW).catch(() => undefined);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      if (givesBack) expect((await month(sara.id, new Date(NOW.getTime() + 10 * 60_000))).leftMicros).toBe(BASE + 1_000_000);
    });

    it('credit a job drew is given back ONCE when a confirmed fault of ours arrives after the finish, although the runner called the failure the agent’s own', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      // The runner says the agent's own and names three turns; nothing wrong is recorded yet: the person's, charged (what the calls drew stays drawn)
      await (finishJob as (...args: unknown[]) => Promise<unknown>)(jobId, 'failed', new Date(NOW.getTime() + 10 * 60_000), null, 'agent', [1, 2, 3], 'run1');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'failed', endedBy: null });
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(890_000);
      // The relay's confirmed 401 on Universe's key for the same job, run and second turn arrives later
      const bot = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { botId: true } })).botId;
      await recordFaults(bot, jobId, [{ turn: 2, run: 'run1', callId: 'late-401', kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/model-a', providerStatus: 401, at: new Date() }]);
      await afterLateEvidence(jobId, new Date(NOW.getTime() + 11 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(holds.map((hold) => Number(hold.refundedMicros)).sort()).toEqual([20_000, 30_000, 60_000]);
      // The ten minutes of the machine the person was charged are given back with the calls
      // Said again by the late look and by the credit's own give-back: nothing is given twice
      await afterLateEvidence(jobId, new Date(NOW.getTime() + 12 * 60_000));
      await giveBackComputerCredit(jobId, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(3);
    });

    it('a job our own pool cut off mid-run stays `pool`, and its time, its calls and the credit they drew all go back once, which Activity reads as refunded (end to end)', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Pool report', category: 'computer' }, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(950_000);
      // Our pool has no room for the job to go on
      await saveMeterSettings({ memberAllowanceMicros: BASE, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      expect(await renewJob(jobId, new Date(NOW.getTime() + 5 * 60_000))).toEqual({ ok: false, reason: 'pool' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
      // The credit the calls drew (and the minutes it ran) is whole again; the calls are written against nobody
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(holds.length);
      for (const event of await prisma.meterEvent.findMany({ where: { jobId, kind: 'model_call' } })) expect(event).toMatchObject({ personKey: 'unknown', personId: null });
      // What the person reads in Activity: refunded, once, however many things look at it
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, new Date(NOW.getTime() + 6 * 60_000));
      await settleCheckingReceipts(50, new Date(NOW.getTime() + 600 * 60_000));
      const [line] = (await activityFor(sara.id)).filter((item) => item.title === 'Pool report');
      expect(line).toMatchObject({ state: 'refunded' });
      expect(line).toMatchObject({ outcome: 'stopped', outcomeText: 'Stopped: our computers were busy, and its time was given back', returnedMicros: 50_000 });
      await sweepComputers(new Date(NOW.getTime() + 30 * 60_000));
      await giveBackComputerCredit(jobId, NOW);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(holds.length);
    });

    it('a failed job is given back exactly once however many things see it: its end, a late call, the sweep and the task receipt (which writes no money at all)', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Weekly report', category: 'computer' }, NOW);
      // The money rows that a give-back writes, read as plain data so two moments can be compared
      const books = async () => ({
        calls: await prisma.meterEvent.findMany({ where: { jobId, kind: 'model_call' }, orderBy: { eventId: 'asc' }, select: { eventId: true, personKey: true, personId: true, costMicros: true, detail: true } }),
        holds: (await prisma.creditHold.findMany({ where: { jobKey: jobId }, orderBy: { id: 'asc' }, select: { id: true, refundedMicros: true, customerMicros: true, state: true } })).map((hold) => ({ ...hold, refundedMicros: Number(hold.refundedMicros), customerMicros: Number(hold.customerMicros) })),
        refunds: await prisma.creditRefund.count({ where: { holdId: { in: (await prisma.creditHold.findMany({ where: { jobKey: jobId }, select: { id: true } })).map((hold) => hold.id) } } }),
      });
      // The job fails on our side: its calls and the credit they drew go back, once (the one give-back, `giveBackModelCalls`)
      await failedOnOurSide(jobId, new Date(NOW.getTime() + 10 * 60_000));
      const given = await books();
      expect(given.calls).toHaveLength(2);
      for (const event of given.calls) expect(event).toMatchObject({ personKey: 'unknown', personId: null, detail: expect.objectContaining({ givenBack: true, forPersonId: sara.id }) });
      expect(given.holds.map((hold) => hold.refundedMicros).sort()).toEqual([20_000, 30_000]);
      expect(given.refunds).toBe(2);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      // The task receipt sees the same failed job, by every way it has (the bot server's close, its sweep, the activity list): it says "refunded" and writes nothing
      // to the money rows, so it cannot give anything back a second time
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, new Date(NOW.getTime() + 11 * 60_000));
      await settleCheckingReceipts(50, new Date(NOW.getTime() + 600 * 60_000));
      const [line] = (await activityFor(sara.id)).filter((item) => item.title === 'Weekly report');
      expect(line).toMatchObject({ state: 'refunded' });
      expect(await books()).toEqual(given);
      // The computer sweep (twice), a second end and a call that reports late see the same job: each finds nothing left to give back
      await sweepComputers(new Date(NOW.getTime() + 30 * 60_000));
      await sweepComputers(new Date(NOW.getTime() + 40 * 60_000));
      await failedOnOurSide(jobId, new Date(NOW.getTime() + 41 * 60_000));
      await settleModelCall(jobId, 'late', { costMicros: 10_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW).catch(() => undefined);
      const after = await books();
      expect(after.holds).toEqual(given.holds);
      expect(after.refunds).toBe(2);
      expect(after.calls.slice(0, 2)).toEqual(given.calls);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
    });

    it('is found again by the sweep when its give-back failed once: the person is not left without the credit of a job that failed on our side', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(950_000);
      // The give-back throws for the first draw only (the books were not reachable for a moment): the job still ends, and nothing is lost for good
      (creditSpend.refundHold as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('books unreachable');
      });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await failedOnOurSide(jobId, new Date(NOW.getTime() + 10 * 60_000));
      } finally {
        quiet.mockRestore();
      }
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBeLessThan(1_000_000);
      // The sweep, later, finds the job still holding drawn credit and gives it back; asked again it gives nothing more
      await sweepComputers(new Date(NOW.getTime() + 30 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      await sweepComputers(new Date(NOW.getTime() + 40 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(holds.map((hold) => Number(hold.refundedMicros)).sort()).toEqual([20_000, 30_000]);
    });

    it('a Brick whose job our pool cut off is purged while the books cannot take the refund: the obligation is kept for a `pool` ending too, and paid afterwards', async () => {
      const { purgeBrick } = jest.requireActual('@/lib/brick-purge');
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      (creditSpend.refundHold as jest.Mock).mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const at = new Date(NOW.getTime() + 5 * 60_000);
      const later = new Date(NOW.getTime() + 60 * 60_000);
      try {
        await saveMeterSettings({ memberAllowanceMicros: BASE, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
        expect(await renewJob(jobId, at)).toEqual({ ok: false, reason: 'pool' });
        await prisma.bot.update({ where: { id: sara.brickId }, data: { deletedAt: at, goneAt: at, enabled: false, enabledBeforeDelete: true } });
        expect(await purgeBrick(sara.brickId, later)).toBe('purged');
      } finally {
        quiet.mockRestore();
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(jest.requireActual('@/lib/credit-spend').refundHold);
      }
      const owed = await prisma.computerRefundObligation.findFirstOrThrow({ where: { jobId } });
      expect(owed).toMatchObject({ personId: sara.id, state: 'owed' });
      await sweepComputers(new Date(later.getTime() + 3 * 60 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.computerRefundObligation.findUniqueOrThrow({ where: { id: owed.id } })).toMatchObject({ state: 'acknowledged' });
    });

    it('a Brick is purged even while the books cannot take a refund: the refund obligation keeps the job, the person and the amount, and the refund is still made afterwards', async () => {
      const { purgeBrick } = jest.requireActual('@/lib/brick-purge');
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      // The books cannot be reached when the job fails, nor when the purge tries
      (creditSpend.refundHold as jest.Mock).mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const at = new Date(NOW.getTime() + 10 * 60_000);
      const later = new Date(NOW.getTime() + 60 * 60_000);
      try {
        await failedOnOurSide(jobId, at);
        expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(970_000);
        await prisma.bot.update({ where: { id: sara.brickId }, data: { deletedAt: at, goneAt: at, enabled: false, enabledBeforeDelete: true } });
        // Deletion is not held for ever by a refund that cannot be made: what is owed is kept apart from the job
        expect(await purgeBrick(sara.brickId, later)).toBe('purged');
        expect(await prisma.computerJob.count({ where: { id: jobId } })).toBe(0);
      } finally {
        quiet.mockRestore();
        // Whatever the purge answered, the next test gets the real books again (and the recovery below runs with them on success)
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(jest.requireActual('@/lib/credit-spend').refundHold);
      }
      const owed = await prisma.computerRefundObligation.findFirstOrThrow({ where: { jobId } });
      expect(owed).toMatchObject({ jobId, personId: sara.id, state: 'owed', lastError: 'books unreachable' });
      expect(Number(owed.amountMicros)).toBe(30_000);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(970_000);
      // The books answer again: the sweep gives the credit back without the job or the Brick, and the obligation is acknowledged
      await sweepComputers(new Date(later.getTime() + 3 * 60 * 60_000));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.computerRefundObligation.findUniqueOrThrow({ where: { id: owed.id } })).toMatchObject({ state: 'acknowledged', acknowledgedMicros: BigInt(30_000) });
    });

    describe('the refund of credit a failed job drew is an obligation until the books acknowledge it', () => {
      const actualRefund = () => jest.requireActual('@/lib/credit-spend').refundHold;
      const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);
      afterEach(() => {
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
        jest.restoreAllMocks();
        (Sentry.captureMessage as jest.Mock).mockClear();
      });
      /** A failed job that drew 30,000 from a gift, whose first refund try fails because the books are unreachable. */
      async function stuck() {
        const sara = await running();
        const { jobId, token } = await job(sara);
        await gift([sara.id], 'computers', 1_000_000);
        await call(token, 'a', 50_000, 30_000);
        (creditSpend.refundHold as jest.Mock).mockImplementation(async () => {
          throw new Error('books unreachable');
        });
        const spy = quiet();
        await failedOnOurSide(jobId, new Date(NOW.getTime() + 10 * 60_000));
        spy.mockRestore();
        const holdKey = `computer:credit:computer:${jobId}:call:a`;
        return { sara, jobId, holdKey };
      }

      it('is written before the books are asked, with the amount fixed, and is acknowledged with what they gave; asked again it changes nothing', async () => {
        const sara = await running();
        const { jobId, token } = await job(sara);
        await gift([sara.id], 'computers', 1_000_000);
        await call(token, 'a', 50_000, 30_000);
        const seen: unknown[] = [];
        (creditSpend.refundHold as jest.Mock).mockImplementation(async (input: { holdKey: string; refundKey: string; amountMicros: number }, at?: Date) => {
          // At the moment the books are asked the obligation already exists with the amount and key it will ask with
          seen.push(await prisma.computerRefundObligation.findUnique({ where: { holdKey: input.holdKey } }));
          return actualRefund()(input, at);
        });
        await failedOnOurSide(jobId, new Date(NOW.getTime() + 10 * 60_000));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ jobId, personId: sara.id, state: 'owed', refundKey: `giveback:computer:credit:computer:${jobId}:call:a`, amountMicros: BigInt(30_000) });
        const kept = await prisma.computerRefundObligation.findFirstOrThrow({ where: { jobId } });
        expect(kept).toMatchObject({ state: 'acknowledged', acknowledgedMicros: BigInt(30_000), attempts: 1, lastError: null, nextAttemptAt: null });
        // Said again (the sweep, a second end, support) the books are not asked and nothing more is given
        const asked = (creditSpend.refundHold as jest.Mock).mock.calls.length;
        await sweepComputers(new Date(NOW.getTime() + 30 * 60_000));
        expect(await attemptRefundObligation(kept.holdKey, new Date(NOW.getTime() + 31 * 60_000), { force: true })).toBe('none');
        expect((creditSpend.refundHold as jest.Mock).mock.calls.length).toBe(asked);
        expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      });

      it('keeps a failed try (tries, last try, why) and asks again with a growing wait: not before it is due, and never more often than that', async () => {
        const { holdKey } = await stuck();
        const first = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        expect(first).toMatchObject({ state: 'owed', attempts: 1, lastError: 'books unreachable' });
        const t0 = first.lastAttemptAt as Date;
        expect(first.nextAttemptAt?.getTime()).toBe(t0.getTime() + 2 * 60_000);
        const spy = quiet();
        const asked = () => (creditSpend.refundHold as jest.Mock).mock.calls.length;
        let before = asked();
        // A sweep that comes too early does not ask the books at all
        await sweepComputers(new Date(t0.getTime() + 60_000));
        expect(asked()).toBe(before);
        // Due: asked once, fails again, and the wait doubles
        before = asked();
        const due = new Date(t0.getTime() + 3 * 60_000);
        await sweepComputers(due);
        expect(asked()).toBe(before + 1);
        const second = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        expect(second).toMatchObject({ attempts: 2 });
        expect(second.nextAttemptAt?.getTime()).toBe(due.getTime() + 4 * 60_000);
        // The wait stops growing at an hour
        for (let attempts = 3; attempts < 12; attempts++) await prisma.computerRefundObligation.update({ where: { holdKey }, data: { attempts, nextAttemptAt: null } }).then(() => attemptRefundObligation(holdKey, due));
        const capped = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        expect((capped.nextAttemptAt as Date).getTime() - due.getTime()).toBe(60 * 60_000);
        spy.mockRestore();
      });

      it('a failed try that read an earlier clock than the one kept never moves the last try or the deadline backwards', async () => {
        const { holdKey } = await stuck();
        const first = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        const kept = first.lastAttemptAt as Date;
        const spy = quiet();
        // A try forced with a clock from before the one already kept (the sweep and a support retry racing, one of them with an older reading of the time)
        expect(await attemptRefundObligation(holdKey, new Date(kept.getTime() - 5 * 60_000), { force: true })).toBe('owed');
        spy.mockRestore();
        const second = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        expect(second.attempts).toBe(2);
        expect(second.lastAttemptAt?.getTime()).toBe(kept.getTime());
        // The wait after the second failure (4 minutes) counts from the later time, so the deadline only ever moves forward
        expect(second.nextAttemptAt?.getTime()).toBe(kept.getTime() + 4 * 60_000);
        expect((second.nextAttemptAt as Date).getTime()).toBeGreaterThan((first.nextAttemptAt as Date).getTime());
      });

      it('asks for the same refund when the books made it but the answer was lost: found again by its key, given once', async () => {
        const { sara, holdKey } = await stuck();
        // This time the books MAKE the refund and then the answer is lost
        (creditSpend.refundHold as jest.Mock).mockReset();
        (creditSpend.refundHold as jest.Mock).mockImplementationOnce(async (input: unknown, at?: Date) => {
          await actualRefund()(input, at);
          throw new Error('answer lost');
        });
        (creditSpend.refundHold as jest.Mock).mockImplementation(actualRefund());
        const spy = quiet();
        const later = new Date(NOW.getTime() + 60 * 60_000);
        expect(await attemptRefundObligation(holdKey, later, { force: true })).toBe('owed');
        spy.mockRestore();
        expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
        // Support's retry: the books answer with the SAME refund (replayed under its key), the obligation is acknowledged, nothing is given twice
        expect(await retryRefundObligation(holdKey, new Date(later.getTime() + 60_000))).toEqual({ found: true, result: 'acknowledged' });
        expect(await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).toMatchObject({ state: 'acknowledged', acknowledgedMicros: BigInt(30_000), attempts: 3 });
        expect((await prisma.creditHold.findUniqueOrThrow({ where: { holdKey } })).refundedMicros).toBe(BigInt(30_000));
        const hold = await prisma.creditHold.findUniqueOrThrow({ where: { holdKey } });
        expect(await prisma.creditRefund.count({ where: { holdId: hold.id } })).toBe(1);
        expect(await retryRefundObligation('no-such-hold')).toEqual({ found: false, result: 'none' });
      });

      it('does not ask the books again when a job’s give-back is said again before the wait is over (a late call, a second end)', async () => {
        const { jobId, holdKey } = await stuck();
        const asked = () => (creditSpend.refundHold as jest.Mock).mock.calls.length;
        const before = asked();
        const spy = quiet();
        // The job ended at +10 minutes and the first try failed: the next is due at +12, so these two come too early
        await giveBackComputerCredit(jobId, new Date(NOW.getTime() + 10 * 60_000 + 30_000));
        await giveBackComputerCredit(jobId, new Date(NOW.getTime() + 11 * 60_000));
        spy.mockRestore();
        expect(asked()).toBe(before);
        expect((await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).attempts).toBe(1);
      });

      it('keeps an answer that is not an acknowledgement as owed with why (a refund the books cannot make: more than the hold has left), for support', async () => {
        const { sara, holdKey } = await stuck();
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { amountMicros: BigInt(40_000) } });
        expect(await attemptRefundObligation(holdKey, new Date(), { force: true })).toBe('owed');
        expect(await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).toMatchObject({ state: 'owed', lastError: 'too_much' });
        expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(970_000);
      });

      it('writes the obligation of a job that failed before obligations existed when its Brick is purged, so the purge goes on and the refund is still made', async () => {
        const { purgeBrick } = jest.requireActual('@/lib/brick-purge');
        const { sara, jobId, holdKey } = await stuck();
        // A job that failed in an earlier release has no obligation row: only the job and the hold say what is owed
        await prisma.computerRefundObligation.deleteMany({ where: { holdKey } });
        const at = new Date(NOW.getTime() + 10 * 60_000);
        await prisma.bot.update({ where: { id: sara.brickId }, data: { deletedAt: at, goneAt: at, enabled: false, enabledBeforeDelete: true } });
        const spy = quiet();
        expect(await purgeBrick(sara.brickId, new Date(NOW.getTime() + 60 * 60_000))).toBe('purged');
        spy.mockRestore();
        expect(await prisma.computerJob.count({ where: { id: jobId } })).toBe(0);
        expect(await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).toMatchObject({ jobId, personId: sara.id, state: 'owed', amountMicros: BigInt(30_000) });
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
        await sweepComputers(new Date(NOW.getTime() + 5 * 60 * 60_000));
        expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      });

      it('two tries that fail together record two attempts and wait by the count the second one advanced (the longer wait), never both from the same old count', async () => {
        const { holdKey } = await stuck();
        const spy = quiet();
        const due = new Date(NOW.getTime() + 60 * 60_000);
        await Promise.all([attemptRefundObligation(holdKey, due, { force: true }), attemptRefundObligation(holdKey, due, { force: true })]);
        spy.mockRestore();
        const row = await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } });
        // One attempt had been recorded by the job's own end: three now, and the wait is the one for the third, 8 minutes
        expect(row.attempts).toBe(3);
        expect(row.nextAttemptAt?.getTime()).toBe(due.getTime() + 8 * 60_000);
      });

      it('lists the rows, the total and the overdue count from one snapshot: a refund acknowledged between the reads is neither listed as overdue nor counted as none owed', async () => {
        const { holdKey } = await stuck();
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });
        const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
        const seen: unknown[] = [];
        const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
          seen.push(options);
          return real(async (tx: Record<string, unknown>) => {
            const own = tx.computerRefundObligation as { findMany: (a: unknown) => Promise<unknown> };
            const wrapped = new Proxy(tx, {
              get: (target, key) =>
                key === 'computerRefundObligation'
                  ? new Proxy(own, {
                      get: (delegate, method) =>
                        method === 'findMany'
                          ? async (args: unknown) => {
                              const rows = await delegate.findMany(args);
                              // The refund is acknowledged by someone else right after the rows were read
                              await prisma.computerRefundObligation.updateMany({ where: { holdKey }, data: { state: 'acknowledged' } });
                              return rows;
                            }
                          : (delegate as never)[method as never],
                    })
                  : target[key as string],
            });
            return fn(wrapped);
          }, options);
        }) as never);
        try {
          const view = await refundOverview(new Date());
          expect(view.rows).toHaveLength(1);
          expect(view.owed).toMatchObject({ count: 1, overdue: 1 });
          expect(seen).toContainEqual({ isolationLevel: 'RepeatableRead' });
        } finally {
          spy.mockRestore();
        }
        expect((await refundOverview(new Date())).owed.count).toBe(0);
      });

      it('writes the obligations of EVERY failed job of a Brick, a page at a time, so a Brick with more of them than one page is never left blocked (two jobs, a page of one)', async () => {
        const sara = await running();
        (creditSpend.refundHold as jest.Mock).mockImplementation(async () => {
          throw new Error('books unreachable');
        });
        const spy = quiet();
        const ids: string[] = [];
        await gift([sara.id], 'computers', 1_000_000);
        for (let index = 0; index < 2; index++) {
          const { jobId, token } = await job(sara);
          await call(token, `p${index}`, 50_000, 30_000);
          await failedOnOurSide(jobId, new Date(NOW.getTime() + (10 + index) * 60_000));
          ids.push(jobId);
        }
        spy.mockRestore();
        await prisma.computerRefundObligation.deleteMany({ where: { jobId: { in: ids } } });
        await recordRefundObligationsForBrick(sara.brickId, 1);
        expect(await prisma.computerRefundObligation.count({ where: { jobId: { in: ids } } })).toBe(2);
      });

      it('tells Sentry once about a refund unacknowledged for over an hour, and shows it overdue with what support needs', async () => {
        const { sara, jobId, holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        const spy = quiet();
        // Not yet an hour: nothing is said
        expect(await sweepRefundObligations(new Date(created.getTime() + 30 * 60_000))).toMatchObject({ alerted: 0 });
        expect((Sentry.captureMessage as jest.Mock)).not.toHaveBeenCalled();
        const overdueAt = new Date(created.getTime() + 61 * 60_000);
        expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('not been acknowledged'), expect.objectContaining({ tags: expect.objectContaining({ step: 'refund_obligation_age' }), extra: expect.objectContaining({ jobId, holdKey, amountMicros: 30_000, lastError: 'books unreachable' }) }));
        // ...and only once
        await sweepRefundObligations(new Date(overdueAt.getTime() + 120 * 60_000));
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        const view = await refundOverview(overdueAt);
        expect(view.owed).toMatchObject({ count: 1, amountMicros: 30_000, overdue: 1 });
        expect(view.rows[0]).toMatchObject({ jobId, personId: sara.id, holdKey, amountMicros: 30_000, lastError: 'books unreachable', overdue: true });
        expect(view.rows[0].attempts).toBeGreaterThanOrEqual(1);
        expect(view.rows[0].lastAttemptAt).not.toBeNull();
      });

      it('two sweeps running together tell Sentry once about an overdue refund, and a capture that throws is told again by the next sweep', async () => {
        const { holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        const spy = quiet();
        const overdueAt = new Date(created.getTime() + 61 * 60_000);
        (Sentry.captureMessage as jest.Mock).mockClear();
        // Another sweep claims the alert between this one's read of the overdue rows and its own claim: this one says nothing (the claim is a write only one can win)
        const realFindMany = prisma.computerRefundObligation.findMany.bind(prisma.computerRefundObligation);
        const findMany = jest.spyOn(prisma.computerRefundObligation, 'findMany').mockImplementation(((args: { where?: { alertedAt?: null } }) => {
          const read = realFindMany(args as never);
          if (args?.where?.alertedAt === null) return read.then(async (rows) => {
            await prisma.computerRefundObligation.updateMany({ where: { holdKey }, data: { alertedAt: overdueAt } });
            return rows;
          });
          return read;
        }) as never);
        try {
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 0 });
        } finally {
          findMany.mockRestore();
        }
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
        // Two sweeps together tell it once
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { alertedAt: null } });
        const [one, other] = await Promise.all([sweepRefundObligations(overdueAt), sweepRefundObligations(overdueAt)]);
        expect(one.alerted + other.alerted).toBe(1);
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        // A capture that throws gives the claim back, so the obligation is not left as "told" when nobody was
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { alertedAt: null } });
        (Sentry.captureMessage as jest.Mock).mockClear();
        (Sentry.captureMessage as jest.Mock).mockImplementationOnce(() => {
          throw new Error('sentry down');
        });
        expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 0 });
        expect((await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).alertedAt).toBeNull();
        expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
        spy.mockRestore();
      });

      it('the overdue-refund alert is claimed by a row lock: a sweep that finds the row locked by another skips it, a worker that dies leaves it for the next sweep', async () => {
        const { holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        const overdueAt = new Date(created.getTime() + 61 * 60_000);
        // Not due for another try (so only the alert looks at it)
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { nextAttemptAt: new Date(overdueAt.getTime() + 10 * 24 * 3_600_000) } });
        const captured = Sentry.captureMessage as jest.Mock;
        captured.mockClear();
        const spy = quiet();
        try {
          // Another sweep holds the row (it is telling Sentry): this one skips it, says nothing, and does not wait. That worker then dies, which rolls back
          await afterWorkerDied(
            prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT "id" FROM "computer_refund_obligations" WHERE "hold_key" = ${holdKey} FOR UPDATE`;
              expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 0 });
              expect(captured).not.toHaveBeenCalled();
              throw new WorkerDied();
            }),
          );
          expect((await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).alertedAt).toBeNull();
          // The next sweep tells it, once
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
          expect(captured).toHaveBeenCalledTimes(1);
          expect((await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).alertedAt).not.toBeNull();
        } finally {
          spy.mockRestore();
        }
      });

      it('the overdue-refund alert is flushed inside the claim: a flush that does not confirm leaves it unmarked for the next sweep, and with no Sentry client it commits at once', async () => {
        const { holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        const overdueAt = new Date(created.getTime() + 61 * 60_000);
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { nextAttemptAt: new Date(overdueAt.getTime() + 10 * 24 * 3_600_000) } });
        const captured = Sentry.captureMessage as jest.Mock;
        const getClient = Sentry.getClient as jest.Mock;
        const flush = Sentry.flush as jest.Mock;
        captured.mockClear();
        flush.mockClear();
        const spy = quiet();
        const marked = async () => (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).alertedAt;
        try {
          getClient.mockReturnValue({});
          // The transport did not confirm the event: rolled back, so nothing is marked told
          flush.mockResolvedValueOnce(false);
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 0 });
          expect(flush).toHaveBeenCalledWith(2_000);
          expect(await marked()).toBeNull();
          // The next sweep tells it again (a duplicate at worst), and this time it is confirmed
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
          expect(captured).toHaveBeenCalledTimes(2);
          expect(await marked()).not.toBeNull();
          // With no client nothing could ever be delivered: it commits at once, without a flush
          await prisma.computerRefundObligation.update({ where: { holdKey }, data: { alertedAt: null } });
          getClient.mockReturnValue(undefined);
          flush.mockClear();
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
          expect(flush).not.toHaveBeenCalled();
          expect(await marked()).not.toBeNull();
        } finally {
          getClient.mockReturnValue(undefined);
          spy.mockRestore();
        }
      });

      it('the overdue-refund alert says what the row holds when it is locked: a try that failed between the candidate read and the lock is in it', async () => {
        const { holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        const overdueAt = new Date(created.getTime() + 61 * 60_000);
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { nextAttemptAt: new Date(overdueAt.getTime() + 10 * 24 * 3_600_000) } });
        const captured = Sentry.captureMessage as jest.Mock;
        captured.mockClear();
        const spy = quiet();
        // A support retry fails after the sweep read its candidate rows and before it locked the row
        const realFindMany = prisma.computerRefundObligation.findMany.bind(prisma.computerRefundObligation);
        const findMany = jest.spyOn(prisma.computerRefundObligation, 'findMany').mockImplementation(((args: { where?: { alertedAt?: null } }) => {
          const read = realFindMany(args as never);
          if (args?.where?.alertedAt !== null) return read;
          return read.then(async (rows) => {
            await prisma.computerRefundObligation.update({ where: { holdKey }, data: { attempts: 9, lastError: 'books said no, again' } });
            return rows;
          });
        }) as never);
        try {
          expect(await sweepRefundObligations(overdueAt)).toMatchObject({ alerted: 1 });
        } finally {
          findMany.mockRestore();
          spy.mockRestore();
        }
        expect(captured).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ extra: expect.objectContaining({ holdKey, attempts: 9, lastError: 'books said no, again' }) }));
      });

      it('makes the readiness check fail while a refund is overdue, and pass once it is acknowledged', async () => {
        await seedGiveBackLimits({});
        const { holdKey } = await stuck();
        const created = (await prisma.computerRefundObligation.findUniqueOrThrow({ where: { holdKey } })).createdAt;
        await prisma.computerRefundObligation.update({ where: { holdKey }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });
        expect(created).toBeTruthy();
        expect(await giveBackReadiness()).toMatchObject({ ok: false, detail: expect.stringContaining('not been acknowledged') });
        (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
        await retryRefundObligation(holdKey);
        expect((await giveBackReadiness()).ok).toBe(true);
      });
    });

    it('the sweep takes the oldest and the newest of the jobs it must give back, so jobs whose give-back never works cannot keep a newer one out', async () => {
      // Seven people, each with a job that drew credit; the give-back of the first six never works (their books are out of reach), the last one's works from the sweep
      const jobs: Array<{ sara: Awaited<ReturnType<typeof running>>; jobId: string }> = [];
      for (const name of ['ana', 'bea', 'cy', 'dee', 'eli', 'fay', 'gus']) {
        const sara = await running(name);
        const { jobId, token } = await job(sara);
        await gift([sara.id], 'computers', 1_000_000);
        await call(token, 'a', 10_000, 30_000);
        jobs.push({ sara, jobId });
      }
      const stuck = jobs.slice(0, 6).map((one) => one.jobId);
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const actual = jest.requireActual('@/lib/credit-spend');
      (creditSpend.refundHold as jest.Mock).mockImplementation(async (...args: unknown[]) => {
        throw new Error(`the books are out of reach (${String(args.length)})`);
      });
      // They failed in this order: the six that will stay stuck first, the last one newest
      for (const [index, one] of jobs.entries()) await failedOnOurSide(one.jobId, new Date(NOW.getTime() + (10 + index) * 60_000));
      for (const one of jobs) expect((await computerCredit(prisma as never, one.sara.id, NOW)).availableMicros).toBe(1_000_000 - 30_000);
      // The books answer again, for the newest only (the older ones stay out of reach for their own reasons)
      (creditSpend.refundHold as jest.Mock).mockImplementation(async (input: { holdKey: string }, at?: Date) => {
        if (stuck.some((id) => input.holdKey.includes(id))) throw new Error('this one never works');
        return actual.refundHold(input, at);
      });
      // A batch of 2: one oldest and one newest. Plain "oldest first" (or a LIMIT with no order) would take the stuck ones and never reach the newest
      await sweepComputers(new Date(NOW.getTime() + 60 * 60_000), 2);
      quiet.mockRestore();
      expect((await computerCredit(prisma as never, jobs[6].sara.id, NOW)).availableMicros).toBe(1_000_000);
      for (const one of jobs.slice(0, 6)) expect((await computerCredit(prisma as never, one.sara.id, NOW)).availableMicros).toBe(1_000_000 - 30_000);
    });

    it('a job that failed on our side counts nothing against the month and keeps nothing drawn from credit: calls, time, a late call, and asked twice is once', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      // Credit covers 20,000 of the 50,000 the calls cost: the other 30,000 would fall on the month
      await gift([sara.id], 'computers', 20_000);
      await call(token, 'a', 10_000, 30_000);
      await call(token, 'b', 10_000, 20_000);
      expect((await month(sara.id)).leftMicros).toBe(BASE - 30_000);
      const later = new Date(NOW.getTime() + 10 * 60_000);
      await failedOnOurSide(jobId, later);
      // The month is as it was before the job, and the credit is whole again
      expect((await month(sara.id, later)).leftMicros).toBe(BASE + 20_000);
      expect((await computerCredit(prisma as never, sara.id, later)).availableMicros).toBe(20_000);
      // Our own cost stays in the books, written against nobody
      const events = await prisma.meterEvent.findMany({ where: { jobId } });
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every((event) => event.personKey === 'unknown' && event.personId === null)).toBe(true);
      expect(events.reduce((sum, event) => sum + Number(event.costMicros ?? 0), 0)).toBeGreaterThanOrEqual(50_000);
      // A call that reports after the end, and the end said again: still nothing on the month, nothing drawn, nothing given twice
      await settleModelCall(jobId, 'late', { costMicros: 10_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, later).catch(() => undefined);
      await failedOnOurSide(jobId, new Date(later.getTime() + 60_000));
      await giveBackComputerCredit(jobId, NOW);
      expect((await month(sara.id, later)).leftMicros).toBe(BASE + 20_000);
      expect((await computerCredit(prisma as never, sara.id, later)).availableMicros).toBe(20_000);
    });

    it('a job that ran fine, or that the person stopped, keeps counting against the month', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await call(token, 'a', 10_000, 30_000);
      await finishJob(jobId, 'done', new Date(NOW.getTime() + 10 * 60_000));
      // 30,000 for the call and 60,000 for ten minutes of the machine
      expect((await month(sara.id, new Date(NOW.getTime() + 10 * 60_000))).leftMicros).toBe(BASE - 90_000);
      const other = await running('omar');
      const second = await job(other);
      await call(second.token, 'a', 10_000, 30_000);
      await stopJobFor(other.brickId, other.id, new Date(NOW.getTime() + 10 * 60_000));
      expect((await month(other.id, new Date(NOW.getTime() + 10 * 60_000))).leftMicros).toBe(BASE - 90_000);
    });

    it('is not given back for a job that ran fine, or that the person stopped: what it drew stays drawn', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await finishJob(jobId, 'done', new Date(NOW.getTime() + 10 * 60_000));
      // 30,000 for the call and 60,000 for ten minutes of the machine
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000 - 90_000);
      const other = await running('omar');
      const second = await job(other);
      await gift([other.id], 'computers', 1_000_000);
      await call(second.token, 'a', 50_000, 30_000);
      await stopJobFor(other.brickId, other.id, new Date(NOW.getTime() + 10 * 60_000));
      expect((await computerCredit(prisma as never, other.id, NOW)).availableMicros).toBe(1_000_000 - 90_000);
    });

    it('is given back as a small replacement when the gift ended before the failure was found', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000, 5);
      await call(token, 'a', 50_000, 30_000);
      // Found after the gift ended: the gift is not renewed, the person is made whole with a replacement that ends soon
      await giveBackComputerCredit(jobId, new Date(NOW.getTime() + 6 * DAY));
      const replacements = await prisma.creditLot.findMany({ where: { personId: sara.id, source: 'replacement' } });
      expect(replacements).toHaveLength(1);
      expect(Number(replacements[0].amountMicros)).toBe(30_000);
      expect(replacements[0].covers).toEqual(['computers']);
    });
  });

  describe('an exception for computers', () => {
    const people_ = (ids: string[]) => ({ kind: 'people' as const, userIds: ids });

    it('is a different month for the people it names: more, or none, while everyone else keeps the default', async () => {
      const sara = await running('sara');
      const omar = await running('omar');
      const faisal = await running('faisal');
      await saveException({ categoryId: 'computers', amount: 500_000, schedule: 'monthly', recipients: people_([sara.id, omar.id]), claimStartsAt: NOW }, issuer, NOW);
      await saveException({ categoryId: 'computers', amount: 0, schedule: 'none', recipients: people_([faisal.id]), claimStartsAt: NOW }, issuer, NOW);
      const other = await running('noor');
      const { token } = await job(sara);
      expect((await month(sara.id)).baseMicros).toBe(500_000);
      expect((await month(omar.id)).leftMicros).toBe(500_000);
      expect((await month(faisal.id)).baseMicros).toBe(0);
      expect((await month(faisal.id)).leftMicros).toBe(0);
      expect((await month(other.id)).baseMicros).toBe(BASE);
      // The bigger month lets a call start that the default could not hold; no month at all refuses one
      expect(await authorizeModelCall({ token, callId: 'big', estimateMicros: 400_000, payer: 'universe' }, NOW)).toMatchObject({ ok: true });
      expect(await reserveRoom({ key: `none-${tag}`, personId: faisal.id, amountMicros: 1_000, newJob: true }, NOW)).toMatchObject({ ok: false, reason: 'allowance' });
    });

    it('that gives once is credit to draw, and leaves no month beside it', async () => {
      const sara = await running();
      await saveException({ categoryId: 'computers', amount: 300_000, schedule: 'once', recipients: people_([sara.id, (await person('x')).id]), claimStartsAt: NOW }, issuer, NOW);
      // No month at all, and a job still starts: the credit the exception gives once is asked for when the month is used up (here, nothing of it)
      const { token } = await job(sara);
      expect(await authorizeModelCall({ token, callId: 'once', estimateMicros: 100_000, payer: 'universe' }, NOW)).toMatchObject({ ok: true });
      await settleModelCall(
        (await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id } })).id,
        'once',
        { costMicros: 100_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' },
        NOW,
      );
      const after = await month(sara.id);
      expect(after.baseMicros).toBe(0);
      expect(after.creditMicros).toBe(200_000);
    });
  });

  describe('the default', () => {
    it('is the month itself: its own lots are never drawn from, so the month is never counted twice', async () => {
      const sara = await running();
      await saveDefaultFor({ what: 'default', category: 'computers', amountMicros: BASE, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } as never, issuer, NOW);
      await ensureIssued(sara.id, NOW);
      expect(await prisma.creditLot.count({ where: { personId: sara.id, covers: { has: 'computers' } } })).toBeGreaterThan(0);
      const state = await month(sara.id);
      expect(state).toMatchObject({ baseMicros: BASE, creditMicros: 0, leftMicros: BASE });
      const { token } = await job(sara);
      expect(await authorizeModelCall({ token, callId: 'x', estimateMicros: 50_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'allowance' });
    });
  });

  describe('what the payer reads on the receipt of a computer that failed on our side (GPT observations 1 and 3)', () => {
    const actualRefund = () => jest.requireActual('@/lib/credit-spend').refundHold;
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);
    /** A Gmail action of the job's task that went out and was charged 9,000, as the executor's own records hold it. */
    async function gmailWorked(sara: { id: string; brickId: string }, jobId: string, customerMicros = 9_000) {
      const run = await prisma.instantRun.create({
        data: { runKey: `k-${randomUUID()}`, botId: sara.brickId, personId: sara.id, taskKey: jobId, toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'succeeded', customerState: 'charged', customerMicros: BigInt(customerMicros), providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
      });
      await prisma.meterEvent.create({
        data: { eventId: `instant:${run.id}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(7_000), basis: 'measured', detail: { instant: true, taskKey: jobId, runId: run.id, app: 'gmail', customerMicros } } as never,
      });
      return run;
    }
    const itemFor = async (personId: string, title: string) => (await activityFor(personId)).filter((item) => item.title === title);

    it('observation 1: a computer that was refunded and a Gmail that was charged 9,000: the Gmail charge stays visible, the returned computer cost is said, and the net amount is the Gmail charge', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      const gmail = await gmailWorked(sara, jobId);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Send the report', category: 'computer' }, NOW);
      await failedOnOurSide(jobId, at(10));
      // The money rows: the computer's 50,000 went back to the wallet, once; the Gmail charge stands
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(holds.map((hold) => Number(hold.refundedMicros)).sort()).toEqual([20_000, 30_000]);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
      expect(await prisma.instantRun.findUniqueOrThrow({ where: { id: gmail.id } })).toMatchObject({ state: 'succeeded', customerState: 'charged', customerMicros: BigInt(9_000) });
      // The bot server says done; the task receipt is read after every way it can be ended
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(600));
      const [item, ...rest] = await itemFor(sara.id, 'Send the report');
      expect(rest).toEqual([]);
      // What the payer sees (the old build said "Refunded, nothing taken" with no total over this)
      expect(item).toMatchObject({ state: 'done', outcome: 'partial', outcomeText: OUTCOME_WORDS.partial, spentMicros: 9_000, returnedMicros: 50_000 });
      expect(item.outcomeText).not.toBe(OUTCOME_WORDS.refunded);
      expect(item.actions).toEqual([{ label: 'gmail', outcome: 'worked', text: 'Gmail · worked', takenText: null, amountMicros: 9_000 }]);
      expect(item.outcomeNote).toBe('The computer part didn’t finish because of a problem on our side, and its time ($0.05) was given back. Gmail worked and was charged $0.009. You pay $0.009 in all.');
      expect(item.lines).toEqual(expect.arrayContaining([{ label: 'Instant gmail, 1 use', amountMicros: 9_000 }]));
      // Said again later (a sweep, a read): the same receipt, the same words, no second refund
      expect(await itemFor(sara.id, 'Send the report')).toEqual([item]);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
    });

    it('a job that was paused, carried on and then failed on our side: what an EARLIER stretch drew is neither returned nor pending (it stays charged), only the last stretch is read, on the receipt and in the report', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      // Before the pause: one model call that drew 30,000 of credit (and the pause itself writes the stretch's time, which draws its own 12,000)
      await call(token, 'a', 50_000, 30_000, at(1));
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Paused report', category: 'computer' }, NOW);
      expect((await pauseJob(sara.brickId, sara.id, jobId, at(2))).ok).toBe(true);
      expect((await resumeJob(sara.brickId, sara.id, jobId, at(4))).ok).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'running', pauses: 1 });
      // After it: another call that drew 20,000, on the new key of the carried-on job
      const claim = await claimJob(jobId, { run: 'carried-on', seen: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerEpoch }, at(4));
      if (!claim.ok) throw new Error(`the claim was refused: ${claim.reason}`);
      const minted = (await mintJobToken(jobId, 'model', at(4), undefined, { epoch: claim.epoch })) as { ok: true; token: string };
      expect(minted.ok).toBe(true);
      expect(await call(minted.token, 'b', 50_000, 20_000, at(5))).toMatchObject({ ok: true });
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
        await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
        await settleCheckingReceipts(50, at(30));
      } finally {
        mute.mockRestore();
      }
      // Only the last stretch's draw is owed: the earlier call has no obligation and is not read as owed
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId, state: 'settled' } });
      expect(holds.map((hold) => Number(hold.customerMicros)).sort((x, y) => x - y)).toEqual([12_000, 20_000, 30_000]);
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId } })).map((one) => [one.state, Number(one.amountMicros)])).toEqual([['owed', 20_000]]);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 20_000 });
      const later = at(60 * 24);
      const failed = async () => (await reportsToTell(50, later)).find((report) => report.jobId === jobId);
      expect(await failed()).toMatchObject({ kind: 'failed', givenBack: true, refundPendingMicros: 20_000 });
      const [pending] = await itemFor(sara.id, 'Paused report');
      expect(pending).toMatchObject({ outcome: 'refund_pending', refundPendingMicros: 20_000 });
      // The books recover and acknowledge: nothing is pending (NOT the earlier 30,000), and only the last stretch came back
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      expect(await prisma.computerRefundObligation.count({ where: { jobId, state: 'acknowledged' } })).toBe(1);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 20_000, pendingMicros: 0 });
      const after = await failed();
      expect(after).toMatchObject({ kind: 'failed', givenBack: true });
      expect(after).not.toHaveProperty('refundPendingMicros');
      const [done] = await itemFor(sara.id, 'Paused report');
      expect(done).not.toHaveProperty('refundPendingMicros');
      expect(done.outcome).not.toBe('refund_pending');
      // The earlier stretch stays charged: its call (30,000) and its time (12,000) are still drawn from the 1,000,000 gift, and neither was given back
      expect((await computerCredit(prisma as never, sara.id, at(60))).availableMicros).toBe(958_000);
      expect((await prisma.creditHold.findMany({ where: { jobKey: jobId } })).map((hold) => [Number(hold.customerMicros), Number(hold.refundedMicros)]).sort((x, y) => x[0] - y[0])).toEqual([[12_000, 0], [20_000, 20_000], [30_000, 0]]);
    });

    it('an obligation ALREADY WRITTEN for an earlier stretch stays owed: the fix filters the hold-only branch, never a refund the books were already told to make (GPT round 6, finding 10)', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      // Stretch 0: a call that drew 30,000
      await call(token, 'a', 50_000, 30_000, at(1));
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Paused report', category: 'computer' }, NOW);
      expect((await pauseJob(sara.brickId, sara.id, jobId, at(2))).ok).toBe(true);
      expect((await resumeJob(sara.brickId, sara.id, jobId, at(4))).ok).toBe(true);
      // Stretch 1: a call that drew 20,000
      const claim = await claimJob(jobId, { run: 'carried-on', seen: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerEpoch }, at(4));
      if (!claim.ok) throw new Error(`the claim was refused: ${claim.reason}`);
      const minted = (await mintJobToken(jobId, 'model', at(4), undefined, { epoch: claim.epoch })) as { ok: true; token: string };
      expect(await call(minted.token, 'b', 50_000, 20_000, at(5))).toMatchObject({ ok: true });
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
        await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
        await settleCheckingReceipts(50, at(30));
      } finally {
        mute.mockRestore();
      }
      // An obligation an OLDER build wrote for the earlier stretch's hold, before the stretch rule existed: the books were told to give that 30,000 back, so it is a real debt to the person
      const early = await prisma.creditHold.findFirstOrThrow({ where: { jobKey: jobId, customerMicros: BigInt(30_000) }, select: { holdKey: true } });
      await prisma.computerRefundObligation.create({ data: { jobId, personId: sara.id, holdKey: early.holdKey, refundKey: refundKeyOf(early.holdKey), amountMicros: BigInt(30_000) } });

      // Both are owed: the hold-only branch is what the stretch rule filters, never an obligation that was written
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId }, orderBy: { amountMicros: 'asc' } })).map((one) => [one.state, Number(one.amountMicros)])).toEqual([['owed', 20_000], ['owed', 30_000]]);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 50_000 });
      // ...and the person is shown the whole 50,000 as still coming back, on the receipt and in the report, never only the last stretch's 20,000
      const later = at(60 * 24);
      expect(await (async () => (await reportsToTell(50, later)).find((report) => report.jobId === jobId))()).toMatchObject({ kind: 'failed', givenBack: true, refundPendingMicros: 50_000 });
      const [pending] = await itemFor(sara.id, 'Paused report');
      expect(pending).toMatchObject({ outcome: 'refund_pending', refundPendingMicros: 50_000 });

      // The books recover: BOTH are acknowledged and nothing is left pending
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      expect(await prisma.computerRefundObligation.count({ where: { jobId, state: 'acknowledged' } })).toBe(2);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 50_000, pendingMicros: 0 });
    });

    it('N10: a call admitted BEFORE a pause belongs to the earlier stretch even when its own time is later than the pause’s (the pause took its time before it got the lock): only the call admitted after the resume is given back', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      // Admitted and settled first, at a time LATER than the pause's own (the pause read its clock, then waited for the lock this call held)
      await call(token, 'a', 50_000, 30_000, at(3));
      expect((await pauseJob(sara.brickId, sara.id, jobId, at(2))).ok).toBe(true);
      expect((await resumeJob(sara.brickId, sara.id, jobId, at(4))).ok).toBe(true);
      const claim = await claimJob(jobId, { run: 'carried-on', seen: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerEpoch }, at(4));
      if (!claim.ok) throw new Error(`the claim was refused: ${claim.reason}`);
      const minted = (await mintJobToken(jobId, 'model', at(4), undefined, { epoch: claim.epoch })) as { ok: true; token: string };
      expect(await call(minted.token, 'b', 50_000, 20_000, at(5))).toMatchObject({ ok: true });
      // The stretch each call was admitted in is on its room
      const stretches = await prisma.meterReservation.findMany({ where: { jobId, reservationKey: { startsWith: 'computer:call:' } }, select: { reservationKey: true, jobStretch: true }, orderBy: { reservationKey: 'asc' } });
      expect(stretches.map((one) => one.jobStretch)).toEqual([0, 1]);
      // ...and the credit each call drew carries the same number, so the give-back touches the last stretch's draw and no earlier one
      expect((await prisma.creditHold.findMany({ where: { jobKey: jobId, chargeClass: 'computer_model' }, select: { holdKey: true, jobStretch: true }, orderBy: { holdKey: 'asc' } })).map((one) => one.jobStretch)).toEqual([0, 1]);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
      } finally {
        mute.mockRestore();
      }
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId } })).map((one) => Number(one.amountMicros))).toEqual([20_000]);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 20_000 });
    });

    it('finding 8a: the reservation and the pause at the very SAME moment are told apart by the stretch number, never by their times: the earlier stretch’s call stays charged', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      // The call is admitted at exactly the time the pause is taken at: no clock can order these two, only the number written under the pause's own lock
      await call(token, 'a', 50_000, 30_000, at(2));
      expect((await pauseJob(sara.brickId, sara.id, jobId, at(2))).ok).toBe(true);
      expect((await resumeJob(sara.brickId, sara.id, jobId, at(2))).ok).toBe(true);
      const claim = await claimJob(jobId, { run: 'carried-on', seen: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerEpoch }, at(2));
      if (!claim.ok) throw new Error(`the claim was refused: ${claim.reason}`);
      const minted = (await mintJobToken(jobId, 'model', at(2), undefined, { epoch: claim.epoch })) as { ok: true; token: string };
      expect(await call(minted.token, 'b', 50_000, 20_000, at(2))).toMatchObject({ ok: true });
      const rooms = await prisma.meterReservation.findMany({ where: { jobId, reservationKey: { startsWith: 'computer:call:' } }, select: { jobStretch: true, createdAt: true }, orderBy: { reservationKey: 'asc' } });
      expect(rooms.map((one) => one.jobStretch)).toEqual([0, 1]);
      // The tie this case claims is enforced: both rooms were made at the very moment the pause was taken (CodeRabbit on #1025, 59)
      const pause = await prisma.computerJobPause.findFirstOrThrow({ where: { jobId } });
      expect(rooms.map((one) => one.createdAt.getTime())).toEqual([pause.at.getTime(), pause.at.getTime()]);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
      } finally {
        mute.mockRestore();
      }
      // Only the call of the last stretch (20,000) is owed back; the earlier stretch's 30,000 stays charged
      expect((await prisma.computerRefundObligation.findMany({ where: { jobId } })).map((one) => Number(one.amountMicros))).toEqual([20_000]);
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 20_000 });
    });

    it('control: a job that was never paused reads exactly as before (every hold), and a last-stretch obligation not yet acknowledged is still pending', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
      } finally {
        mute.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ pauses: 0 });
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 50_000 });
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 50_000, pendingMicros: 0 });
    });

    it('reads what a job’s holds returned and what its obligations still owe from ONE snapshot (repeatable read), so a refund acknowledged between the two reads is never half seen', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
      } finally {
        mute.mockRestore();
      }
      const transaction = jest.spyOn(prisma, '$transaction');
      try {
        expect((await refundStatesFor([jobId])).get(jobId)).toEqual({ returnedMicros: 0, pendingMicros: 50_000 });
        // Both reads are the two halves of one transaction at repeatable read, never two reads that may see different moments
        const [queries, options] = transaction.mock.calls.find((one) => Array.isArray(one[0]) && one[0].length === 2) ?? [];
        expect(queries).toHaveLength(2);
        expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
      } finally {
        transaction.mockRestore();
      }
    });

    it('a Gmail whose provider cost is known but whose charge the books have not acknowledged is "settlement pending" beside a returned computer, never "price not known yet"', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      const run = await prisma.instantRun.create({
        data: { runKey: `k-${randomUUID()}`, botId: sara.brickId, personId: sara.id, taskKey: jobId, toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'succeeded', customerState: 'held', providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
      });
      // The provider's cost to us is known (7,000); the person's charge is not in the books yet
      await prisma.meterEvent.create({
        data: { eventId: `instant:${run.id}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(7_000), basis: 'measured', detail: { instant: true, taskKey: jobId, runId: run.id, app: 'gmail' } } as never,
      });
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Mail while settling', category: 'computer' }, NOW);
      await failedOnOurSide(jobId, at(10));
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      const [item] = await itemFor(sara.id, 'Mail while settling');
      expect(item.lines.some((line) => line.note === 'Settlement pending')).toBe(true);
      expect(item.outcomeNote).toContain('Gmail worked. Its charge is settlement pending.');
      expect(item.outcomeNote).not.toContain('price is not known');
    });

    it('a Gmail that worked and took nothing (a zero charge, or its hold released) beside a computer given back keeps the task "partly done"; with no verified work the task is refunded as before', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      // A run that worked and was charged nothing
      const run = await gmailWorked(sara, jobId, 0);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Free mail with report', category: 'computer' }, NOW);
      await failedOnOurSide(jobId, at(10));
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(600));
      const [item] = await itemFor(sara.id, 'Free mail with report');
      expect(await prisma.instantRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ state: 'succeeded', customerMicros: BigInt(0) });
      expect(item).toMatchObject({ state: 'done', outcome: 'partial', returnedMicros: 30_000 });
      expect(item.outcomeText).not.toBe(OUTCOME_WORDS.refunded);
      expect(item.actions).toMatchObject([{ label: 'gmail', outcome: 'worked' }]);
      // The same payload game Usage reads (on time: the Gmail verified by its own run, nothing charged): state done, outcome partial, never refunded
      expect((await memberUsage(sara.id, at(600))).activity.find((one) => one.id === item.id)).toMatchObject({ state: 'done', outcome: 'partial', outcomeText: OUTCOME_WORDS.partial });
      // No verified work: a computer given back with nothing else is refunded
      const other = await running('tom');
      const second = await job(other);
      await gift([other.id], 'computers', 1_000_000);
      await call(second.token, 'a', 50_000, 30_000);
      await openReceipt({ botId: other.brickId, personId: other.id, taskKey: second.jobId, title: 'Computer only', category: 'computer' }, NOW);
      await failedOnOurSide(second.jobId, at(10));
      await closeReceipt({ botId: other.brickId, taskKey: second.jobId, personId: other.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(600));
      expect((await itemFor(other.id, 'Computer only'))[0]).toMatchObject({ state: 'refunded', outcome: 'refunded' });
    });

    it('GPT round 3, finding 2: a Gmail let go unconfirmed (its hold released) that the provider later CONFIRMED, beside a computer given back and nothing owed, reads "Partly done. Gmail was delivered..." in Activity and Usage, on the original receipt', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      // The App's result was uncertain: let go unconfirmed, its hold given back (nothing taken)
      const run = await prisma.instantRun.create({
        data: { runKey: `k-${randomUUID()}`, botId: sara.brickId, personId: sara.id, taskKey: jobId, toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'failed', reason: 'unclear', customerState: 'released', customerMicros: BigInt(0), detail: { noLog: true, releasedUnconfirmed: true }, providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
      });
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Mail with report', category: 'computer' }, NOW);
      await failedOnOurSide(jobId, at(10));
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(600));
      const first = (await itemFor(sara.id, 'Mail with report'))[0];
      // Before the provider says anything the Gmail could not be confirmed: not delivered, and not claimed to be
      expect(first.outcomeNote ?? '').not.toContain('was delivered');
      // The provider's log turns up and says it went out (the books do not charge it: its hold stays released)
      await prisma.instantRun.update({ where: { id: run.id }, data: { detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'success' } } } });
      await settleCheckingReceipts(50, at(700));
      const [item, ...rest] = await itemFor(sara.id, 'Mail with report');
      expect(rest).toEqual([]);
      // The headline, the sentence and the action, from the ORIGINAL receipt (the same row), in the approved words
      expect(item).toMatchObject({ id: first.id, state: 'done', outcome: 'partial', outcomeText: 'Partly done' });
      expect(item.outcomeText).not.toBe(OUTCOME_WORDS.refunded);
      expect(item.outcomeNote).toBe('Gmail was delivered. Its hold was released. The computer part didn’t finish and its cost was returned.');
      expect(item.actions).toMatchObject([{ label: 'gmail', outcome: 'worked', takenText: 'Hold released' }]);
      expect(item.actions[0]).not.toHaveProperty('amountMicros');
      // No later charge: the Gmail is still nothing taken, and the computer's cost is back once
      expect(await prisma.instantRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ customerState: 'released', customerMicros: BigInt(0) });
      expect(await prisma.meterEvent.count({ where: { eventId: `instant:${run.id}` } })).toBe(0);
      // Game Usage reads the same items: the same words
      const usage = await memberUsage(sara.id, at(700));
      // The payload game Usage renders: state done (never refunded: the game would show only "Refunded" and drop the note), outcome partial, Orbit's own words
      expect(usage.activity.find((one) => one.id === item.id)).toMatchObject({ state: 'done', outcome: 'partial', outcomeText: 'Partly done', outcomeNote: item.outcomeNote });
      // Said again (a sweep, a read): the same receipt, the same words
      await settleCheckingReceipts(50, at(800));
      expect(await itemFor(sara.id, 'Mail with report')).toEqual([item]);
      // A Gmail whose log says it FAILED, or that nobody could confirm, is not "delivered": that task stays refunded as before
      const other = await running('tom');
      const second = await job(other);
      await gift([other.id], 'computers', 1_000_000);
      await call(second.token, 'a', 50_000, 30_000);
      const gone = await prisma.instantRun.create({
        data: { runKey: `k-${randomUUID()}`, botId: other.brickId, personId: other.id, taskKey: second.jobId, toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'failed', reason: 'unclear', customerState: 'released', customerMicros: BigInt(0), detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'failed' } }, providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
      });
      await openReceipt({ botId: other.brickId, personId: other.id, taskKey: second.jobId, title: 'Mail that failed', category: 'computer' }, NOW);
      await failedOnOurSide(second.jobId, at(10));
      await closeReceipt({ botId: other.brickId, taskKey: second.jobId, personId: other.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(900));
      const failed = (await itemFor(other.id, 'Mail that failed'))[0];
      expect(failed.outcomeNote ?? '').not.toContain('was delivered');
      expect(failed.actions[0]).toMatchObject({ outcome: 'failed' });
      expect(gone.id).toBeTruthy();
    });

    it('CodeRabbit: two Apps delivered after the log confirmed them say EACH hold: one released, one still being released, never one for both', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      const letGoRun = (toolkit: string, customerState: string) =>
        prisma.instantRun.create({
          data: { runKey: `k-${randomUUID()}`, botId: sara.brickId, personId: sara.id, taskKey: jobId, toolSlug: `${toolkit.toUpperCase()}_SEND`, toolkit, argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: 'failed', reason: 'unclear', customerState, customerMicros: BigInt(0), detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'success' } }, providerUserId: `u-${randomUUID().slice(0, 6)}` } as never,
        });
      await letGoRun('gmail', 'released');
      await letGoRun('slack', 'held');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Two Apps', category: 'computer' }, NOW);
      await failedOnOurSide(jobId, at(10));
      await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      await settleCheckingReceipts(50, at(600));
      const [item] = await itemFor(sara.id, 'Two Apps');
      expect(item.outcomeNote).toContain('Gmail and Slack were delivered. Gmail’s hold was released and Slack’s hold is being released.');
      expect(item.outcomeNote).not.toContain('Their holds');
    });

    it('observation 3: the wallet cannot post the refund: "$0.05 refund pending" until it does; then the SAME receipt says refunded and the credit came back once', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Weekly report', category: 'computer' }, NOW);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
        await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
        await settleCheckingReceipts(50, at(30));
      } finally {
        mute.mockRestore();
      }
      // The money rows: the obligation is owed, the credit is still on the person
      const owed = await prisma.computerRefundObligation.findMany({ where: { jobId, state: 'owed' } });
      expect(owed.reduce((sum, one) => sum + Number(one.amountMicros), 0)).toBe(50_000);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(950_000);
      // What the payer sees: a refund that is pending, not "Refunded, nothing taken"
      const [pending] = await itemFor(sara.id, 'Weekly report');
      expect(pending).toMatchObject({ state: 'done', outcome: 'refund_pending', outcomeText: '$0.05 refund pending', refundPendingMicros: 50_000, spentMicros: null });
      expect(pending.outcomeText).not.toBe(OUTCOME_WORDS.refunded);
      expect(pending).not.toHaveProperty('returnedMicros');
      expect(pending.outcomeNote).toBe('We’re returning $0.05 to your credit.');
      // The wallet recovers: the sweep posts the refund (once), the obligation is acknowledged
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.computerRefundObligation.count({ where: { jobId, state: 'acknowledged' } })).toBe(2);
      const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId } });
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
      // The same receipt (same id), now refunded, with no pending amount
      const [done] = await itemFor(sara.id, 'Weekly report');
      expect(done).toMatchObject({ id: pending.id, state: 'refunded', outcome: 'refunded', outcomeText: OUTCOME_WORDS.refunded, spentMicros: null });
      expect(done).not.toHaveProperty('refundPendingMicros');
      // Asked again by anything: the credit is not restored twice
      await sweepComputers(at(700));
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
    });

    it('the task reply says the same: while the refund is pending the report carries the amount owed, and once it is acknowledged it carries none', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
      } finally {
        mute.mockRestore();
      }
      const later = at(60 * 24);
      const failed = async () => (await reportsToTell(50, later)).find((report) => report.jobId === jobId);
      expect(await failed()).toMatchObject({ kind: 'failed', givenBack: true, refundPendingMicros: 30_000 });
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      const after = await failed();
      expect(after).toMatchObject({ kind: 'failed', givenBack: true });
      expect(after).not.toHaveProperty('refundPendingMicros');
    });

    it('the task reply carries no refund pending for a failed job that is NOT given back (the person’s own cause): its credit stays with it, so nothing is owed back', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      // A recorded fault that is the person's (their allowance): the job failed on THEIR account, so nothing is given back
      await recordFaults(sara.brickId, jobId, [{ turn: 1, callId: 'x1', kind: 'not_ours', reason: 'allowance', source: 'universe-ai', route: 'universe-ai:p', at: NOW }]);
      await (finishJob as (...args: unknown[]) => Promise<unknown>)(jobId, 'failed', at(10), null, 'ours', [1]);
      expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'refused', basis: 'person_caused' });
      const report = (await reportsToTell(50, at(60 * 24))).find((one) => one.jobId === jobId);
      expect(report).toMatchObject({ kind: 'failed', givenBack: false });
      expect(report).not.toHaveProperty('refundPendingMicros');
    });

    it('a job our own pool cut off is reported as failed with the refund still owed on it, until the books acknowledge it; an acknowledged one carries none', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await call(token, 'b', 50_000, 20_000);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      await saveMeterSettings({ memberAllowanceMicros: BASE, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      const mute = quiet();
      try {
        expect(await renewJob(jobId, at(5))).toEqual({ ok: false, reason: 'pool' });
      } finally {
        mute.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      const later = at(60 * 24);
      const told = async () => (await reportsToTell(50, later)).find((report) => report.jobId === jobId);
      expect(await told()).toMatchObject({ kind: 'failed', givenBack: true, refundPendingMicros: 50_000 });
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      const after = await told();
      expect(after).toMatchObject({ kind: 'failed', givenBack: true });
      expect(after).not.toHaveProperty('refundPendingMicros');
    });

    it('a pending refund beside a Gmail that was charged: the Gmail charge and the pending refund are each said, and the net amount waits until it is settled', async () => {
      const sara = await running();
      const { jobId, token } = await job(sara);
      await gift([sara.id], 'computers', 1_000_000);
      await call(token, 'a', 50_000, 30_000);
      await gmailWorked(sara, jobId);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Mail and report', category: 'computer' }, NOW);
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(async () => {
        throw new Error('books unreachable');
      });
      const mute = quiet();
      try {
        await failedOnOurSide(jobId, at(10));
        await closeReceipt({ botId: sara.brickId, taskKey: jobId, personId: sara.id, state: 'done' }, at(11));
      } finally {
        mute.mockRestore();
      }
      const [pending] = await itemFor(sara.id, 'Mail and report');
      expect(pending).toMatchObject({ state: 'done', outcome: 'partial', refundPendingMicros: 30_000, spentMicros: null });
      expect(pending.outcomeNote).toBe('The computer part didn’t finish because of a problem on our side. Its time ($0.03) is refund pending. Gmail worked and was charged $0.009.');
      (creditSpend.refundHold as jest.Mock).mockReset().mockImplementation(actualRefund());
      await sweepComputers(at(600));
      const [settled] = await itemFor(sara.id, 'Mail and report');
      expect(settled).toMatchObject({ id: pending.id, state: 'done', outcome: 'partial', spentMicros: 9_000, returnedMicros: 30_000 });
      expect(settled.outcomeNote).toBe('The computer part didn’t finish because of a problem on our side, and its time ($0.03) was given back. Gmail worked and was charged $0.009. You pay $0.009 in all.');
    });
  });
});
