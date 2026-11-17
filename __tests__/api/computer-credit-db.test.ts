/**
 * Computer jobs are paid from the same credit lots Usage shows (audit F01, spec v3 section 6.6, acceptance A10 to A14), against a real
 * database and the PRETEND provider (a pretend minute costs 6,000 millionths, so a 10 minute stretch is 60,000). Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest -i __tests__/api/computer-credit-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { recordMeterEvent } from '@/lib/meter';
import { readMeterEvent } from '@/lib/meter-values';
import { finishJob, giveComputer, renewJob, startJob, stopJobFor, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { computerCreditFor } from '@/lib/computer-credit';
import { holdCredit, settleHold } from '@/lib/credit-spend';
import { ensureIssued } from '@/lib/credit-issue';
import { createGiftFor, saveComputerAllowance, saveExceptionFor } from '@/lib/grants-admin';
import { currentEnvelope } from '@/lib/meter-allowance';
import { root, setUpComputerCredit, wipeComputerCredit } from '../helpers/computer-credit-setup';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;
const STRETCH = 60_000;

/** `computer: false` leaves giving the computer to the test: reading a computer issues what is due, so a rule saved after that comes after a lot was issued (credit already given stays). */
async function person(name: string, computer = true) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  if (computer) await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id };
}

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await wipeComputerCredit();
};

const credit = (id: string, at: Date = NOW) => computerCreditFor(id, at);
const gift = (userIds: string[], over: Partial<Parameters<typeof createGiftFor>[0]> = {}) =>
  createGiftFor({ what: 'gift', audience: { kind: 'people', userIds }, scope: 'computers', amountMicros: STRETCH, shared: false, endsAt: days(20).toISOString(), settlement: 'gift', ...over } as Parameters<typeof createGiftFor>[0], root, NOW);
const exception = (userIds: string[], computers: { mode: 'none' } | { mode: 'own'; amountMicros: number; interval: 'once' | 'monthly' }) =>
  saveExceptionFor({ what: 'exception', audience: { kind: 'people', userIds }, instant_apps: { mode: 'same' }, computers }, root, NOW);
/** What a finished stretch of a job costs the person, put straight into the books. */
const used = async (id: string, micros: number, at: Date = NOW) => {
  const holdKey = `used-${randomUUID()}`;
  const held = await holdCredit({ holdKey, personId: id, category: 'computers', amountMicros: micros, chargeClass: 'computer_job' }, at);
  if (!held.ok) throw new Error(`not held: ${held.reason}`);
  await settleHold({ holdKey, customerMicros: micros }, at);
};
const holdsOf = (jobId: string) => prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers' }, orderBy: { createdAt: 'asc' } });

run('computer jobs are paid from the credit lots, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.updateMany({ where: { bot: { ownerId: { in: people } } }, data: {} });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await setUpComputerCredit({ memberAllowanceMicros: 100_000 }, NOW);
  });
  afterAll(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('A10: base credit used up, a gift, and exceptions', () => {
    it('with the base credit used up, a job waits; a gift permits exactly the work it funds and no more', async () => {
      const sara = await person('sara');
      await ensureIssued(sara.id, NOW);
      await used(sara.id, 100_000);
      expect(await credit(sara.id)).toMatchObject({ availableMicros: 0, totalMicros: 100_000 });
      const waiting = await startJob({ botId: sara.brickId, personId: sara.id, title: 'No credit' }, NOW);
      expect(waiting.ok && waiting.job.status === 'running').toBe(false);
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: 'running' } })).toBe(0);
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(0);

      // A gift of exactly one stretch: the job runs and takes all of it, from the gift and from nothing else
      await gift([sara.id]);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'With the gift' }, minutes(1));
      expect(started.ok && started.job.status).toBe('running');
      if (!started.ok) throw new Error('not started');
      expect(await credit(sara.id, minutes(1))).toMatchObject({ availableMicros: 0, inProgressMicros: STRETCH });
      const held = await holdsOf(started.job.id);
      expect(held).toHaveLength(1);
      expect(Number(held[0].amountMicros)).toBe(STRETCH);
      // The next stretch is more than is left: it is refused, as used up, and the platform's room is not left taken for it
      const renewed = await renewJob(started.job.id, minutes(8));
      expect(renewed).toMatchObject({ ok: false, reason: 'allowance' });
      // The job ends as used up, and what it held settles for what it used: nothing stays held, and nothing is taken that the gift did not fund
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ status: 'stopped' });
      expect(await prisma.creditHold.count({ where: { jobKey: started.job.id, state: 'held' } })).toBe(0);
      expect((await credit(sara.id, minutes(9))).availableMicros).toBeGreaterThanOrEqual(0);
      expect((await currentEnvelope(minutes(9))).reservedMicros).toBe(0);
    });

    it('an exception of "no computer credit" actually applies: nothing starts for that person, and others still can', async () => {
      const omar = await person('omar', false);
      const noor = await person('noor', false);
      await exception([omar.id], { mode: 'none' });
      await giveComputer(omar.brickId, omar.id);
      await giveComputer(noor.brickId, noor.id);
      const refused = await startJob({ botId: omar.brickId, personId: omar.id, title: 'Nothing for him' }, NOW);
      expect(refused.ok && refused.job.status === 'running').toBe(false);
      expect(await credit(omar.id)).toMatchObject({ totalMicros: 0, availableMicros: 0 });
      const other = await startJob({ botId: noor.brickId, personId: noor.id, title: 'Default for her' }, NOW);
      expect(other.ok && other.job.status).toBe('running');
    });

    it('a narrower exception applies in place of the default: one stretch fits, a second does not', async () => {
      const noor = await person('noor', false);
      await exception([noor.id], { mode: 'own', amountMicros: 70_000, interval: 'monthly' });
      await giveComputer(noor.brickId, noor.id);
      expect(await credit(noor.id)).toMatchObject({ totalMicros: 70_000 });
      const started = await startJob({ botId: noor.brickId, personId: noor.id, title: 'Narrow' }, NOW);
      if (!started.ok) throw new Error('not started');
      expect(started.job.status).toBe('running');
      expect(await renewJob(started.job.id, minutes(8))).toMatchObject({ ok: false, reason: 'allowance' });
    });

    it('a wider exception applies too: more stretches than the default allows', async () => {
      const faisal = await person('faisal', false);
      await exception([faisal.id], { mode: 'own', amountMicros: 400_000, interval: 'monthly' });
      await giveComputer(faisal.brickId, faisal.id);
      const started = await startJob({ botId: faisal.brickId, personId: faisal.id, title: 'Wide' }, NOW);
      if (!started.ok) throw new Error('not started');
      expect(await renewJob(started.job.id, minutes(8))).toMatchObject({ ok: true });
      expect(await credit(faisal.id, minutes(8))).toMatchObject({ totalMicros: 400_000, inProgressMicros: 2 * STRETCH });
    });

    it('is debited once: from the lots only, never also from the old allowance', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Once' }, NOW);
      if (!started.ok) throw new Error('not started');
      await finishJob(started.job.id, 'done', minutes(5));
      const holds = await holdsOf(started.job.id);
      expect(holds.map((hold) => hold.state)).toEqual(['settled']);
      // 5 minutes at 6,000 a minute
      expect(Number(holds[0].customerMicros)).toBe(30_000);
      expect(await credit(sara.id, minutes(6))).toMatchObject({ availableMicros: 70_000, inProgressMicros: 0 });
      // The platform's own books keep the cost as they always did
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${started.job.id}:time` } });
      expect(Number(event.costMicros)).toBe(30_000);
    });
  });

  describe('A11: a shared pool is consumed once, across computers, Apps and people', () => {
    it('one team pool pays for both people and both kinds of work, once', async () => {
      await saveComputerAllowance(null, root, NOW);
      const omar = await person('omar', false);
      const noor = await person('noor', false);
      await gift([omar.id, noor.id], { scope: 'both', amountMicros: 100_000, shared: true });
      // The pool begins when the first of them is looked at, here, at the test's own time
      await ensureIssued(omar.id, NOW);
      await giveComputer(omar.brickId, omar.id);
      await giveComputer(noor.brickId, noor.id);
      // Omar's job holds one stretch of the pool
      const started = await startJob({ botId: omar.brickId, personId: omar.id, title: 'Team job' }, NOW);
      if (!started.ok) throw new Error('not started');
      expect(started.job.status).toBe('running');
      // What is left of the one pool is the same for Noor, and an Apps charge sees it too
      expect(await credit(noor.id)).toMatchObject({ availableMicros: 40_000 });
      const apps = await holdCredit({ holdKey: `apps-${tag}`, personId: noor.id, category: 'instant_apps', amountMicros: 50_000, chargeClass: 'instant_run' }, NOW);
      expect(apps).toMatchObject({ ok: false, reason: 'credit_used_up' });
      const fits = await holdCredit({ holdKey: `apps-fits-${tag}`, personId: noor.id, category: 'instant_apps', amountMicros: 40_000, chargeClass: 'instant_run' }, NOW);
      expect(fits.ok).toBe(true);
      // Nothing is left for Noor's computer, and nothing was counted twice
      const noors = await startJob({ botId: noor.brickId, personId: noor.id, title: 'Too late' }, NOW);
      expect(noors.ok && noors.job.status === 'running').toBe(false);
      expect(await prisma.creditLot.count({ where: { subjectKey: { startsWith: 'pool:' } } })).toBe(1);
    });
  });

  describe('A12: month, program edits and reconnecting never issue twice or erase usage', () => {
    it('asking again, in the same month or after a change to the default, issues one lot a month', async () => {
      const sara = await person('sara');
      for (let i = 0; i < 3; i++) await ensureIssued(sara.id, NOW);
      await saveComputerAllowance(150_000, root, NOW);
      for (let i = 0; i < 3; i++) await ensureIssued(sara.id, minutes(30));
      const lots = await prisma.creditLot.findMany({ where: { personId: sara.id, slotKey: 'base:computers' } });
      expect(lots).toHaveLength(1);
      // Next month: a new lot, and the old one is not touched
      const december = new Date('2026-12-02T09:00:00Z');
      await ensureIssued(sara.id, december);
      await ensureIssued(sara.id, december);
      expect(await prisma.creditLot.count({ where: { personId: sara.id, slotKey: 'base:computers' } })).toBe(2);
    });

    it('usage from before the lots took over is carried once, however often the person asks', async () => {
      const sara = await person('sara');
      // Last month's use, written the way the meter always wrote it
      const read = readMeterEvent({ eventId: `old-${tag}`, kind: 'computer_time', personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', basis: 'measured', quantity: 1, unit: 'minute', costMicros: 30_000, occurredAt: minutes(-10) });
      if (!read.ok) throw new Error(read.error);
      await recordMeterEvent(read.value);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'First' }, NOW);
      if (!first.ok) throw new Error('not started');
      await finishJob(first.job.id, 'done', minutes(1));
      const carried = await prisma.creditHold.findMany({ where: { personId: sara.id, holdKey: { startsWith: 'carry:' } } });
      expect(carried).toHaveLength(1);
      expect(Number(carried[0].customerMicros)).toBe(30_000);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(2));
      if (!second.ok) throw new Error('not started');
      await finishJob(second.job.id, 'done', minutes(3));
      expect(await prisma.creditHold.count({ where: { personId: sara.id, holdKey: { startsWith: 'carry:' } } })).toBe(1);
      // The meter's old event is still there, and the earlier use still counts against what is left
      expect(await prisma.meterEvent.count({ where: { eventId: `old-${tag}` } })).toBe(1);
      const left = await credit(sara.id, minutes(4));
      expect(left.availableMicros).toBeLessThanOrEqual(100_000 - 30_000 - 6_000 - 6_000);
    });

    it('a gift that ends keeps what was used from it on the books, and its unused part stops counting', async () => {
      await saveComputerAllowance(null, root, NOW);
      const sara = await person('sara');
      const program = await gift([sara.id], { amountMicros: 100_000, endsAt: days(2).toISOString() });
      expect((await credit(sara.id)).availableMicros).toBe(100_000);
      await used(sara.id, 25_000);
      expect((await credit(sara.id, days(1))).availableMicros).toBe(75_000);
      expect((await credit(sara.id, days(3))).availableMicros).toBe(0);
      expect(await prisma.creditHold.count({ where: { personId: sara.id, state: 'settled' } })).toBe(1);
      expect(program.id).toBeTruthy();
    });
  });

  describe('A13: holds come first, lapsed ones stay owed until settled, retries never charge twice', () => {
    it('a job holds its credit before the machine is asked for anything, and the hold is in the books', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hold first' }, NOW);
      if (!started.ok) throw new Error('not started');
      const [hold] = await holdsOf(started.job.id);
      expect(hold).toMatchObject({ state: 'held', chargeClass: 'computer_job' });
      expect(Number(hold.amountMicros)).toBe(STRETCH);
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(STRETCH);
    });

    it('a job that lapses with nobody settling it keeps its credit held until the sweep settles it', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Lapses' }, NOW);
      if (!started.ok) throw new Error('not started');
      // Long after the stretch ran out: the credit is still held, not quietly given back
      const later = minutes(30);
      expect(await credit(sara.id, later)).toMatchObject({ availableMicros: 40_000, inProgressMicros: STRETCH });
      await sweepComputers(minutes(60));
      const holds = await holdsOf(started.job.id);
      expect(holds.every((hold) => hold.state !== 'held')).toBe(true);
      expect(holds.map((hold) => hold.state)).toEqual(['settled']);
    });

    it('asking for the same model call twice holds once, and settling twice charges once', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Calls' }, NOW);
      if (!started.ok) throw new Error('not started');
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      const ask = () => authorizeModelCall({ token: minted.token, callId: 'c1', estimateMicros: 10_000, payer: 'universe' }, NOW);
      expect(await ask()).toMatchObject({ ok: true });
      await ask();
      expect(await prisma.creditHold.count({ where: { jobKey: started.job.id, chargeClass: 'computer_model' } })).toBe(1);
      const facts = { costMicros: 4_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' } as never;
      await settleModelCall(started.job.id, 'c1', facts, NOW);
      await settleModelCall(started.job.id, 'c1', facts, NOW);
      const call = await prisma.creditHold.findFirstOrThrow({ where: { jobKey: started.job.id, chargeClass: 'computer_model' } });
      expect(call).toMatchObject({ state: 'settled' });
      expect(Number(call.customerMicros)).toBe(4_000);
    });

    it('two renewals at the same moment each hold their own stretch: no stretch of machine time goes uncharged', async () => {
      const faisal = await person('faisal', false);
      await exception([faisal.id], { mode: 'own', amountMicros: 400_000, interval: 'monthly' });
      await giveComputer(faisal.brickId, faisal.id);
      const started = await startJob({ botId: faisal.brickId, personId: faisal.id, title: 'Renewed twice at once' }, NOW);
      if (!started.ok) throw new Error('not started');
      const answers = await Promise.all([renewJob(started.job.id, minutes(8)), renewJob(started.job.id, minutes(8))]);
      expect(answers.every((answer) => answer.ok)).toBe(true);
      const holds = await holdsOf(started.job.id);
      expect(holds).toHaveLength(3);
      expect(new Set(holds.map((hold) => hold.holdKey)).size).toBe(3);
      expect(holds.reduce((sum, hold) => sum + Number(hold.amountMicros), 0)).toBe(3 * STRETCH);
      // What the room holds and what the credit holds agree
      expect(Number((await prisma.meterReservation.findFirstOrThrow({ where: { jobId: started.job.id } })).amountMicros)).toBe(3 * STRETCH);
    });

    it('a job that was already running when the lots took over is charged for what it used, from its first stretch', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Running at deploy' }, NOW);
      if (!started.ok) throw new Error('not started');
      // As it was before: room in the meter's books, nothing held in the lots, and the lots took over after it began
      const before = await holdsOf(started.job.id);
      await prisma.creditAllocation.deleteMany({ where: { holdId: { in: before.map((hold) => hold.id) } } });
      await prisma.creditHold.deleteMany({ where: { id: { in: before.map((hold) => hold.id) } } });
      await prisma.appSetting.update({ where: { key: 'computer-credit-books' }, data: { value: { from: minutes(1).toISOString() } } });
      await finishJob(started.job.id, 'done', minutes(5));
      const holds = await holdsOf(started.job.id);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ state: 'settled', holdKey: expect.not.stringContaining(':r') });
      // 5 minutes at 6,000 a minute, charged once
      expect(Number(holds[0].customerMicros)).toBe(30_000);
      expect((await credit(sara.id, minutes(6))).availableMicros).toBe(70_000);
    });

    it('a job that was running at the deploy and renews first is charged for its earlier stretch too', async () => {
      const faisal = await person('faisal', false);
      await exception([faisal.id], { mode: 'own', amountMicros: 400_000, interval: 'monthly' });
      await giveComputer(faisal.brickId, faisal.id);
      const started = await startJob({ botId: faisal.brickId, personId: faisal.id, title: 'Renews after deploy' }, NOW);
      if (!started.ok) throw new Error('not started');
      const before = await holdsOf(started.job.id);
      await prisma.creditAllocation.deleteMany({ where: { holdId: { in: before.map((hold) => hold.id) } } });
      await prisma.creditHold.deleteMany({ where: { id: { in: before.map((hold) => hold.id) } } });
      await prisma.appSetting.update({ where: { key: 'computer-credit-books' }, data: { value: { from: minutes(1).toISOString() } } });
      expect(await renewJob(started.job.id, minutes(8))).toMatchObject({ ok: true });
      await finishJob(started.job.id, 'done', minutes(12));
      const holds = await holdsOf(started.job.id);
      expect(holds).toHaveLength(2);
      // 12 minutes at 6,000 a minute, across the two stretches
      expect(holds.reduce((sum, hold) => sum + Number(hold.customerMicros), 0)).toBe(72_000);
    });

    it('a start asked again for the same run does not hold twice', async () => {
      const sara = await person('sara');
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      const runRow = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: minutes(10) } });
      const [a, b] = await Promise.all([
        startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: runRow.id }, NOW),
        startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: runRow.id }, NOW),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(1);
      expect(await prisma.creditHold.count({ where: { personId: sara.id, category: 'computers', state: 'held' } })).toBe(1);
      expect((await credit(sara.id)).availableMicros).toBe(40_000);
    });
  });

  describe('A14: give-back for our failures only', () => {
    it('a machine that would not start gives the credit back once, and the provider cost stays on the books', async () => {
      const sara = await person('sara');
      provider.failNext.create = true;
      const failed = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Breaks' }, NOW);
      expect(failed).toEqual({ ok: false, reason: 'broken_start' });
      const job = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } });
      const holds = await holdsOf(job.id);
      expect(holds).toHaveLength(1);
      // Whatever was charged went back whole, once; none of it is left charged or held
      expect(await credit(sara.id, minutes(1))).toMatchObject({ availableMicros: 100_000, inProgressMicros: 0 });
      const refunds = await prisma.creditRefund.findMany({ where: { holdId: holds[0].id } });
      expect(refunds.length).toBeLessThanOrEqual(1);
      expect(refunds.every((refund) => refund.reason === 'platform_failure')).toBe(true);
      // The platform's room goes back too
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(0);
    });

    it('a job that ran and finished is never given back: the person is charged what it used, however it turned out', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Ran fine' }, NOW);
      if (!started.ok) throw new Error('not started');
      await finishJob(started.job.id, 'done', minutes(5));
      expect(await prisma.creditRefund.count({ where: { holdId: { in: (await holdsOf(started.job.id)).map((hold) => hold.id) } } })).toBe(0);
      expect(await credit(sara.id, minutes(6))).toMatchObject({ availableMicros: 70_000 });
    });

    it('a job that failed on our side after running is given back too, once: the person is charged nothing for it, and the provider cost stays on the books', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Ran, then failed' }, NOW);
      if (!started.ok) throw new Error('not started');
      await finishJob(started.job.id, 'failed', minutes(5));
      await finishJob(started.job.id, 'failed', minutes(6));
      const holds = await holdsOf(started.job.id);
      expect(holds.map((hold) => hold.state)).toEqual(['settled']);
      const refunds = await prisma.creditRefund.findMany({ where: { holdId: { in: holds.map((hold) => hold.id) } } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].reason).toBe('platform_failure');
      expect(Number(refunds[0].amountMicros)).toBe(30_000);
      expect(await credit(sara.id, minutes(7))).toMatchObject({ availableMicros: 100_000, inProgressMicros: 0 });
      // What the provider billed is still the platform's cost
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${started.job.id}:time` } });
      expect(Number(event.costMicros)).toBe(30_000);
    });

    it('a job the person stopped, or that ran out of room, is not given back: it is theirs', async () => {
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Stopped by her' }, NOW);
      if (!started.ok) throw new Error('not started');
      await stopJobFor(sara.brickId, sara.id, minutes(5));
      expect(await prisma.creditRefund.count({ where: { holdId: { in: (await holdsOf(started.job.id)).map((hold) => hold.id) } } })).toBe(0);
      expect((await credit(sara.id, minutes(6))).availableMicros).toBe(70_000);
    });
  });
});
