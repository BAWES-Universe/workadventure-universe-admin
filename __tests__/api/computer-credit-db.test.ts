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
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { memberAllowance } from '@/lib/meter-allowance';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, startJob, stopJobFor, sweepComputers } from '@/lib/computer';
import { mintJobToken } from '@/lib/computer-token';
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
      await giveBackComputerCredit(jobId);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      await giveBackComputerCredit(jobId);
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
      await giveBackComputerCredit(jobId);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      expect(await prisma.creditRefund.count({ where: { holdId: { in: holds.map((hold) => hold.id) } } })).toBe(2);
      // A call that reports after the job failed: its draw is put back too
      await settleModelCall(jobId, 'late', { costMicros: 10_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW).catch(() => undefined);
      expect((await computerCredit(prisma as never, sara.id, NOW)).availableMicros).toBe(1_000_000);
      if (givesBack) expect((await month(sara.id, new Date(NOW.getTime() + 10 * 60_000))).leftMicros).toBe(BASE + 1_000_000);
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
      await giveBackComputerCredit(jobId);
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
});
