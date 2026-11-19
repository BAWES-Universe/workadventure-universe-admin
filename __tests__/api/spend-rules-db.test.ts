/**
 * Rules said in chat, and one receipt per task, against a real database (paying spec 3, part O4; acceptance tests 7 and 12, rules part).
 * What only the database can show: a rule is made once, held where room is taken, counted from the books and from held room, and a
 * receipt reads only what was recorded. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/spend-rules-db.test.ts --runInBand
 */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn() }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { getSessionUser } from '@/lib/auth-session';
import { saveMeterSettings } from '@/lib/meter';
import { releaseRoom, renewRoom, reserveRoom } from '@/lib/meter-allowance';
import { memberUsage } from '@/lib/meter-usage';
import { changeRule, checkSpend, endRule, listRules, ownerSpendAllowed, proposeRule } from '@/lib/spend-rules';
import { activityFor, closeReceipt, openReceipt } from '@/lib/task-receipts';
import { POST as postRule, GET as getRules } from '@/app/api/bots/[id]/spend-rules/route';
import { POST as postReceipt } from '@/app/api/bots/[id]/task-receipts/route';
import { GET as getPaidBy } from '@/app/api/bots/[id]/paid-by/route';
import { POST as postJob } from '@/app/api/bots/[id]/computer-jobs/route';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, renewJob, startJob } from '@/lib/computer';
import { mintJobToken } from '@/lib/computer-token';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { createInstantFunds } from '@/lib/funding/instant-funds';
import { PATCH as patchRule, DELETE as deleteRule } from '@/app/api/me/spend-rules/[ruleId]/route';

// Delegates to the real room-taking; one test makes it hold up a moment to let another try claim the job (see "a try refused by a rule")
jest.mock('@/lib/meter-allowance', () => {
  const actual = jest.requireActual('@/lib/meter-allowance');
  return { ...actual, reserveRoom: jest.fn(actual.reserveRoom) };
});

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const LAST_MONTH = new Date('2026-10-20T12:00:00Z');
const people: Array<{ id: string; uuid: string }> = [];
const universes: string[] = [];
let made = 0;

async function person(name: string): Promise<{ id: string; uuid: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push({ id: user.id, uuid: user.uuid });
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: user.uuid, brickId: brick.id };
}

/** A room bot in a universe the given person owns. */
async function roomBot(ownerId: string): Promise<string> {
  const universe = await prisma.universe.create({ data: { slug: `rules-${tag}-${++made}`, name: 'BAWES Universe', ownerId } });
  universes.push(universe.id);
  const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
  const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
  return (await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: ownerId, behaviorConfig: {} } })).id;
}

let eventNo = 0;
/** A paid step in the books: a computer's time (the meter's books), or an Instant run (the funding books: a settled hold that took the credit). */
async function spend(personId: string, botId: string, micros: number, over: { jobId?: string | null; at?: Date; instant?: boolean } = {}) {
  if (over.instant) {
    await prisma.creditHold.create({
      data: {
        holdKey: `rules-${tag}-${++eventNo}`,
        personId,
        botId,
        category: 'instant_apps',
        chargeClass: 'instant',
        jobKey: over.jobId ?? null,
        state: 'settled',
        amountMicros: BigInt(micros),
        customerMicros: BigInt(micros),
        expiresAt: new Date((over.at ?? NOW).getTime() + 600_000),
        createdAt: over.at ?? NOW,
        closedAt: over.at ?? NOW,
      },
    });
  }
  // The meter's own record of the step (what a receipt is made from): an Instant use, or a computer's time
  await prisma.meterEvent.create({
    data: {
      eventId: `rules-${tag}-${++eventNo}`,
      kind: over.instant ? 'app_use' : 'computer_time',
      pool: over.instant ? 'chat' : 'computer',
      occurredAt: over.at ?? NOW,
      personKey: `person:${personId}`,
      personId,
      botId,
      brick: true,
      payerKind: 'universe',
      route: over.instant ? 'instant' : 'computer',
      jobId: over.jobId ?? null,
      quantity: over.instant ? 1 : 60,
      unit: over.instant ? 'use' : 'second',
      costMicros: BigInt(micros),
      basis: 'measured',
    },
  });
}

const json = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const wipe = async () => {
  const ids = people.map((one) => one.id);
  await prisma.spendRule.deleteMany({ where: { ownerPersonId: { in: ids } } });
  await prisma.taskReceipt.deleteMany({ where: { personId: { in: ids } } });
  await prisma.computerJob.deleteMany({ where: { personId: { in: ids } } });
  await prisma.meterEvent.deleteMany({ where: { personKey: { in: ids.map((id) => `person:${id}`) } } });
  await prisma.meterReservation.deleteMany({ where: { personKey: { in: ids.map((id) => `person:${id}`) } } });
  await prisma.creditAllocation.deleteMany({ where: { lot: { personId: { in: ids } } } });
  await prisma.creditHold.deleteMany({ where: { personId: { in: ids } } });
  await prisma.creditLot.deleteMany({ where: { personId: { in: ids } } });
  await prisma.fundingAccount.deleteMany({ where: { kind: 'person', ownerKey: { in: ids } } });
};

run('rules said in chat and task receipts, in a real database', () => {
  beforeEach(async () => {
    await wipe();
    await saveMeterSettings({ memberAllowanceMicros: 100_000_000, poolCeilingMicros: 1_000_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
  });
  afterAll(async () => {
    await wipe();
    await prisma.universe.deleteMany({ where: { id: { in: universes } } });
    await prisma.user.deleteMany({ where: { id: { in: people.map((one) => one.id) } } });
    await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
    await prisma.$disconnect();
  });

  describe('saying a rule', () => {
    it('is saved once per message: the same message again finds the rule, and nothing of what was said is kept', async () => {
      const sara = await person('sara');
      const first = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'm1', scope: 'bot', period: 'month', capMicros: 1_000_000 });
      const again = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'm1', scope: 'bot', period: 'month', capMicros: 1_000_000 });
      expect(first).toMatchObject({ ok: true, created: true, rule: { words: "No more than $1.00 a month from your credit for sara's Brick" } });
      expect(again).toMatchObject({ ok: true, created: false });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id } })).toBe(1);
      // Only meanings are columns: there is no place for the words a person wrote
      const columns = Object.keys((await prisma.spendRule.findFirst({ where: { ownerPersonId: sara.id } })) ?? {});
      expect(columns).not.toEqual(expect.arrayContaining(['text', 'message', 'said']));
    });

    it('the same message id said by two people is two rules: a replay never finds or shows another person\'s rule', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const a = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'shared-id', scope: 'person', period: 'month', capMicros: 1_000_000 });
      // Omar says a different rule under the same message id, on Sara's Brick (a person-wide rule is about his own credit)
      const b = await proposeRule({ botId: sara.brickId, speakerId: omar.id, sayingKey: 'shared-id', scope: 'person', period: 'day', capMicros: 2_000_000 });
      expect(a).toMatchObject({ ok: true, created: true });
      expect(b).toMatchObject({ ok: true, created: true, rule: { words: expect.stringContaining('$2.00 a day') } });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id } })).toBe(1);
      expect(await prisma.spendRule.count({ where: { ownerPersonId: omar.id } })).toBe(1);
      // The same person and message id with a different cap is not that message again: nothing is saved and no rule is shown
      const clash = await proposeRule({ botId: sara.brickId, speakerId: omar.id, sayingKey: 'shared-id', scope: 'person', period: 'day', capMicros: 9_000_000 });
      expect(clash).toEqual({ ok: false, reason: 'key_reused' });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: omar.id } })).toBe(1);
      // Each person's own replay still finds their own rule
      expect(await proposeRule({ botId: sara.brickId, speakerId: omar.id, sayingKey: 'shared-id', scope: 'person', period: 'day', capMicros: 2_000_000 })).toMatchObject({ ok: true, created: false, rule: { words: expect.stringContaining('$2.00 a day') } });
    });

    it('a message id is a replay only of what that message said, even after the rule was corrected', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'edited-id', scope: 'person', period: 'month', capMicros: 1_000_000 });
      if (!made.ok) throw new Error('not made');
      expect((await changeRule(made.rule.id, sara.id, { capMicros: 3_000_000 })).ok).toBe(true);
      // Another proposal under the same id is not that message: nothing is saved and nothing shown
      expect(await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'edited-id', scope: 'person', period: 'month', capMicros: 50_000_000 })).toEqual({ ok: false, reason: 'key_reused' });
      // The same message again still finds its rule, as it stands now
      expect(await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'edited-id', scope: 'person', period: 'month', capMicros: 1_000_000 })).toMatchObject({ ok: true, created: false });
    });

    it('asks one short question when it is not clear, saves nothing, and saves when it is answered', async () => {
      const sara = await person('sara');
      const asked = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'm2', scope: 'bot', capMicros: 1_000_000 });
      expect(asked).toMatchObject({ ok: false, reason: 'needs_answer', ask: { about: 'period' } });
      // The question about where it applies names the Brick
      expect(await proposeRule({ botId: sara.brickId, speakerId: sara.id, capMicros: 500_000, period: 'month' })).toMatchObject({
        ok: false,
        reason: 'needs_answer',
        ask: { about: 'scope', question: "Is that just for sara's Brick, or for all your Bricks?" },
      });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id } })).toBe(0);
      const answered = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'm2', scope: 'bot', capMicros: 1_000_000, period: 'task' });
      expect(answered).toMatchObject({ ok: true, created: true, rule: { period: 'task' } });
    });

    it('is only for the person who pays: a Brick’s owner, a room bot’s universe owner, and everyone’s own "everything I pay for"', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const bot = await roomBot(sara.id);
      expect(await proposeRule({ botId: sara.brickId, speakerId: omar.id, scope: 'bot', period: 'day', capMicros: 1 })).toEqual({ ok: false, reason: 'not_allowed' });
      expect(await proposeRule({ botId: bot, speakerId: omar.id, scope: 'bot', period: 'day', capMicros: 1 })).toEqual({ ok: false, reason: 'not_allowed' });
      expect(await proposeRule({ botId: bot, speakerId: sara.id, scope: 'bot', period: 'day', capMicros: 1 })).toMatchObject({ ok: true });
      // Omar talking to Sara's Brick can still say it about his own credit
      expect(await proposeRule({ botId: sara.brickId, speakerId: omar.id, scope: 'person', onlyOwnAccounts: true })).toMatchObject({ ok: true, rule: { scope: 'person' } });
      expect((await prisma.spendRule.findFirst({ where: { ownerPersonId: omar.id } }))?.ownerPersonId).toBe(omar.id);
      expect(await proposeRule({ botId: randomUUID(), speakerId: omar.id, scope: 'person', onlyOwnAccounts: true })).toEqual({ ok: false, reason: 'not_allowed' });
    });

    it('can be seen, corrected and ended only by the person it protects', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      if (!made.ok) throw new Error('not made');
      expect((await listRules(sara.id)).map((rule) => rule.id)).toEqual([made.rule.id]);
      expect(await listRules(omar.id)).toEqual([]);
      expect(await changeRule(made.rule.id, omar.id, { capMicros: 99 })).toEqual({ ok: false, reason: 'not_found' });
      expect(await endRule(made.rule.id, omar.id)).toEqual({ ok: false, reason: 'not_found' });
      const changed = await changeRule(made.rule.id, sara.id, { capMicros: 2_500_000, period: 'day' });
      expect(changed).toMatchObject({ ok: true, rule: { capMicros: 2_500_000, period: 'day', version: 2 } });
      expect(await changeRule(made.rule.id, sara.id, { capMicros: null })).toMatchObject({ ok: false, reason: 'invalid' });
      expect(await endRule(made.rule.id, sara.id)).toEqual({ ok: true });
      expect(await endRule(made.rule.id, sara.id)).toEqual({ ok: true });
      expect(await listRules(sara.id)).toEqual([]);
      // It stays in the books as ended
      expect((await prisma.spendRule.findUnique({ where: { id: made.rule.id } }))?.state).toBe('ended');
    });
  });

  describe('holding a step to the rules', () => {
    it('counts this month’s credit spend and room still held, not last month’s, not settled room, not someone else’s, not another Brick’s', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const second = await createBrickFor(sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      const ask = (micros: number) => checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: micros }, NOW);
      expect(await ask(1_000_000)).toEqual({ ok: true });
      await spend(sara.id, sara.brickId, 400_000);
      await spend(sara.id, sara.brickId, 9_000_000, { at: LAST_MONTH });
      await spend(omar.id, sara.brickId, 9_000_000);
      await spend(sara.id, second, 9_000_000);
      expect(await ask(600_000)).toEqual({ ok: true });
      expect(await ask(600_001)).toMatchObject({ ok: false, why: 'cap', leftMicros: 600_000 });
      // Room held for a running job counts as taken; room that was settled is in the books already and is not counted twice
      await prisma.meterReservation.create({ data: { reservationKey: `held-${tag}`, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, amountMicros: BigInt(500_000), state: 'held', expiresAt: new Date(NOW.getTime() + 600_000), createdAt: NOW } });
      expect(await ask(100_001)).toMatchObject({ ok: false, leftMicros: 100_000 });
      await prisma.meterReservation.updateMany({ where: { reservationKey: `held-${tag}` }, data: { state: 'settled' } });
      expect(await ask(600_000)).toEqual({ ok: true });
      // The rule reaches only Sara's own paid steps for that Brick
      expect(await checkSpend({ payerPersonId: sara.id, botId: second, taskKey: null, chargeClass: 'computer', amountMicros: 1 }, NOW)).toEqual({ ok: true });
      expect(await checkSpend({ payerPersonId: omar.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 99_000_000 }, NOW)).toEqual({ ok: true });
    });

    it('reads no totals for a rule that is not about the step: another Brick’s', async () => {
      const sara = await person('sara');
      const second = await createBrickFor(sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 1_000 });
      await spend(sara.id, sara.brickId, 5_000);
      const reads = jest.spyOn(prisma.meterEvent, 'aggregate');
      try {
        // Another Brick is not held to it, and nothing the rule counts is read for it
        expect(await checkSpend({ payerPersonId: sara.id, botId: second, taskKey: null, chargeClass: 'computer', amountMicros: 1 }, NOW)).toEqual({ ok: true });
        expect(reads).not.toHaveBeenCalled();
        // The rule's own step does read, and is held
        expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 1 }, NOW)).toMatchObject({ ok: false, why: 'cap' });
        expect(reads).toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
    });

    it('a day’s cap starts again at 00:00 UTC, and a task’s cap counts that task only', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'day', capMicros: 300_000 });
      await spend(sara.id, sara.brickId, 300_000, { at: new Date('2026-11-14T23:59:00Z') });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 300_000 }, NOW)).toEqual({ ok: true });
      await spend(sara.id, sara.brickId, 250_000, { at: new Date('2026-11-15T01:00:00Z') });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 100_000 }, NOW)).toMatchObject({ ok: false, leftMicros: 50_000 });

      const rita = await person('rita');
      await proposeRule({ botId: rita.brickId, speakerId: rita.id, scope: 'bot', period: 'task', capMicros: 200_000 });
      await spend(rita.id, rita.brickId, 150_000, { jobId: 'job-a' });
      await spend(rita.id, rita.brickId, 150_000, { jobId: 'job-b' });
      const forTask = (taskKey: string | null, micros: number) => checkSpend({ payerPersonId: rita.id, botId: rita.brickId, taskKey, chargeClass: 'computer', amountMicros: micros }, NOW);
      expect(await forTask('job-a', 50_000)).toEqual({ ok: true });
      expect(await forTask('job-a', 50_001)).toMatchObject({ ok: false, leftMicros: 50_000 });
      expect(await forTask('job-c', 200_000)).toEqual({ ok: true });
      expect(await forTask(null, 200_001)).toMatchObject({ ok: false });
    });

    it('a rule said during one task holds that task only, and a rule about Instant Apps credit counts Instant runs only', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, taskKey: 'job-1', capMicros: 1_200_000, covers: 'apps' });
      await spend(sara.id, sara.brickId, 1_000_000, { jobId: 'job-1' });
      const instant = (taskKey: string | null, micros: number) => checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey, chargeClass: 'apps', amountMicros: micros }, NOW);
      // A computer's minutes are not Instant Apps credit
      expect(await instant('job-1', 1_200_000)).toEqual({ ok: true });
      await spend(sara.id, sara.brickId, 1_000_000, { jobId: 'job-1', instant: true });
      expect(await instant('job-1', 200_001)).toMatchObject({ ok: false, leftMicros: 200_000 });
      expect(await instant('job-2', 5_000_000)).toEqual({ ok: true });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: 'job-1', chargeClass: 'computer', amountMicros: 9_000_000 }, NOW)).toEqual({ ok: true });
    });

    it('the strictest of several rules decides, and an ended rule holds nothing', async () => {
      const sara = await person('sara');
      const small = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 50_000_000 });
      const ask = () => checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 150_000 }, NOW);
      expect(await ask()).toMatchObject({ ok: false, leftMicros: 100_000 });
      if (small.ok) await endRule(small.rule.id, sara.id);
      expect(await ask()).toEqual({ ok: true });
    });
  });

  describe('review findings on the rule checks', () => {
    const attemptOf = (sara: { id: string; brickId: string }, micros: number) => ({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer' as const, amountMicros: micros });

    it('a cap lowered while a step waits for the person’s lock is the cap the step is held to', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 10_000_000 });
      if (!made.ok) throw new Error('not made');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      // Another step has the person's lock
      const other = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`spend-check:${sara.id}`}))`;
        locked();
        await held;
      });
      await lockTaken;
      const waiting = prisma.$transaction((tx) => checkSpend(attemptOf(sara, 5_000_000), NOW, tx));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await changeRule(made.rule.id, sara.id, { capMicros: 2_000_000 });
      release();
      await other;
      expect(await waiting).toMatchObject({ ok: false, why: 'cap', leftMicros: 2_000_000 });
    });

    it('a first rule added while a step waits for the lock is held too', async () => {
      const sara = await person('sara');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const other = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`spend-check:${sara.id}`}))`;
        locked();
        await held;
      });
      await lockTaken;
      const waiting = prisma.$transaction((tx) => checkSpend(attemptOf(sara, 5_000_000), NOW, tx));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 1_000_000 });
      release();
      await other;
      expect(await waiting).toMatchObject({ ok: false, why: 'cap' });
    });

    it('ending a rule waits for an edit that is in the middle of saving it, so the edit never lands on an ended rule', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 1_000_000 });
      if (!made.ok) throw new Error('not made');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      // An edit has the rule's lock
      const editing = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`spend-rule:${made.rule.id}`}))`;
        locked();
        await held;
        await tx.spendRule.updateMany({ where: { id: made.rule.id, state: 'active' }, data: { capMicros: BigInt(9_000_000) } });
      });
      await lockTaken;
      let ended = false;
      const ending = endRule(made.rule.id, sara.id).then((answer) => { ended = true; return answer; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ended).toBe(false);
      release();
      await editing;
      expect(await ending).toEqual({ ok: true });
      expect((await prisma.spendRule.findUnique({ where: { id: made.rule.id } }))?.state).toBe('ended');
      expect(await changeRule(made.rule.id, sara.id, { capMicros: 2_000_000 })).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('two long message ids that start the same are two messages, not one', async () => {
      const sara = await person('sara');
      const long = 'x'.repeat(300);
      const first = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `${long}-a`, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      const second = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `${long}-b`, scope: 'bot', period: 'month', capMicros: 5_000_000 });
      expect(first).toMatchObject({ ok: true, created: true });
      expect(second).toMatchObject({ ok: true, created: true });
      // The same long message again still finds its rule
      expect(await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `${long}-a`, scope: 'bot', period: 'month', capMicros: 1_000_000 })).toMatchObject({ ok: true, created: false });
    });

    it('a message whose rule was saved before long ids were hashed (under the key cut to 255 characters) finds that rule when said again', async () => {
      const sara = await person('sara');
      const long = `m-${'y'.repeat(300)}`;
      const first = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: long, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      if (!first.ok) throw new Error('not made');
      // Put the rule back under the key the earlier code gave it
      const old = `chat:${sara.brickId}:${sara.id}:${long}`.slice(0, 255);
      await prisma.spendRule.update({ where: { id: first.rule.id }, data: { ruleKey: old } });
      expect(await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: long, scope: 'bot', period: 'month', capMicros: 1_000_000 })).toMatchObject({ ok: true, created: false });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id } })).toBe(1);
    });

    it('a cut legacy key is not an identity: an ended rule under it is not replayed for another message that starts the same', async () => {
      const sara = await person('sara');
      const long = `m-${'z'.repeat(300)}`;
      const first = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `${long}-a`, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      if (!first.ok) throw new Error('not made');
      const old = `chat:${sara.brickId}:${sara.id}:${long}-a`.slice(0, 255);
      await prisma.spendRule.update({ where: { id: first.rule.id }, data: { ruleKey: old, state: 'ended' } });
      // Another message, the same words: it must have a rule of its own, not be told the ended one is its rule
      const second = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `${long}-b`, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      expect(second).toMatchObject({ ok: true, created: true });
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id, state: 'active' } })).toBe(1);
    });

    it('a renewal at the exact cap goes on when the job can cost no more than it already could', async () => {
      const sara = await person('sara');
      // 100 millionths for a 10-minute stretch: a first stretch renewed with 33 more, five minutes in, can still cost 100
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100 });
      const key = `k-${tag}-exact`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 100, botId: sara.brickId, jobId: 'jx' }, NOW)).ok).toBe(true);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW } });
      expect(await renewRoom({ key, moreMicros: 33 }, new Date(NOW.getTime() + 300_000))).toMatchObject({ ok: true });
      await releaseRoom({ key }, NOW);
    });

    it('a renewal that waited for the lock past the end of its lease is a lapsed hold, not a renewed one', async () => {
      const sara = await person('sara');
      const key = `k-${tag}-lapse`;
      await prisma.meterReservation.create({ data: { reservationKey: key, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, jobId: 'jl', amountMicros: BigInt(100), state: 'held', expiresAt: new Date(Date.now() + 1_000) } });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const other = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meter:pool'))`;
        locked();
        await held;
      });
      await lockTaken;
      const renewing = renewRoom({ key, moreMicros: 0 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      release();
      await other;
      expect(await renewing).toEqual({ ok: false, reason: 'closed' });
    });

    it('a message id that reads like a hashed key never makes the same rule as the long id it was made from', async () => {
      const sara = await person('sara');
      const long = 'x'.repeat(300);
      const digest = createHash('sha256').update(long).digest('hex');
      const first = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: long, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      const second = await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: `sha256:${digest}`, scope: 'bot', period: 'month', capMicros: 5_000_000 });
      expect(first).toMatchObject({ ok: true, created: true });
      expect(second).toMatchObject({ ok: true, created: true });
    });

    it('a call priced between the two reads of a check is never missed: its cost or its room is counted, whichever read ran first', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      const jobId = randomUUID();
      const eventId = `computer:${jobId}:call:c1`;
      await prisma.meterEvent.create({
        data: { eventId, kind: 'model_call', pool: 'computer', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId, quantity: BigInt(1), unit: 'call', costMicros: null, basis: 'measured' },
      });
      await prisma.meterReservation.create({
        data: { reservationKey: `computer:call:${jobId}:c1`, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, jobId, amountMicros: BigInt(90_000), settledMicros: BigInt(90_000), state: 'settled', expiresAt: NOW },
      });
      // The price is written (as settleModelCall does for a call reported after the sweep wrote it unknown) right after the first of the two reads
      let priced = false;
      const price = async () => {
        if (priced) return;
        priced = true;
        await prisma.meterEvent.updateMany({ where: { eventId, costMicros: null }, data: { costMicros: BigInt(90_000), basis: 'measured' } });
      };
      const realAggregate = prisma.meterEvent.aggregate.bind(prisma.meterEvent) as (args: unknown) => Promise<unknown>;
      const realFind = prisma.meterEvent.findMany.bind(prisma.meterEvent) as (args: unknown) => Promise<unknown>;
      const aggregate = jest.spyOn(prisma.meterEvent, 'aggregate').mockImplementation(((args: unknown) => realAggregate(args).then(async (row) => (await price(), row))) as never);
      const find = jest.spyOn(prisma.meterEvent, 'findMany').mockImplementation(((args: unknown) => realFind(args).then(async (row) => (await price(), row))) as never);
      try {
        // 90,000 of the 100,000 was spent, so 20,000 more is over the cap
        expect(await checkSpend(attemptOf(sara, 20_000), NOW)).toMatchObject({ ok: false, why: 'cap' });
        expect(priced).toBe(true);
      } finally {
        aggregate.mockRestore();
        find.mockRestore();
      }
    });

    it('a model call whose id holds ":call:" still finds the room it settled', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      const jobId = randomUUID();
      const callId = 'part:call:2';
      await prisma.meterEvent.create({
        data: { eventId: `computer:${jobId}:call:${callId}`, kind: 'model_call', pool: 'computer', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId, quantity: BigInt(1), unit: 'call', costMicros: null, basis: 'measured' },
      });
      await prisma.meterReservation.create({
        data: { reservationKey: `computer:call:${jobId}:${callId}`, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, jobId, amountMicros: BigInt(90_000), settledMicros: BigInt(90_000), state: 'settled', expiresAt: NOW },
      });
      // The 90,000 the call took is counted, so 20,000 more is over the 100,000
      expect(await checkSpend(attemptOf(sara, 20_000), NOW)).toMatchObject({ ok: false, why: 'cap' });
    });
  });

  describe('Instant Apps credit and calls with no price', () => {
    const appsStep = (personId: string, botId: string, taskKey: string | null, micros: number) => checkSpend({ payerPersonId: personId, botId, taskKey, chargeClass: 'apps', amountMicros: micros }, NOW);
    const hold = (personId: string, botId: string, key: string, over: { state: 'held' | 'settled'; amount: number; took?: number; refunded?: number }) =>
      prisma.creditHold.create({
        data: { holdKey: `${key}-${tag}`, personId, botId, category: 'instant_apps', chargeClass: 'instant', state: over.state, amountMicros: BigInt(over.amount), customerMicros: over.took === undefined ? null : BigInt(over.took), refundedMicros: BigInt(over.refunded ?? 0), expiresAt: new Date(NOW.getTime() + 600_000), createdAt: NOW },
      });

    it('counts Instant credit from the funding books: held room, and what settled holds took less what was given back', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000, covers: 'apps' });
      await hold(sara.id, sara.brickId, 'held-1', { state: 'held', amount: 6_000 });
      await hold(sara.id, sara.brickId, 'done-1', { state: 'settled', amount: 5_000, took: 2_000 });
      expect(await appsStep(sara.id, sara.brickId, null, 2_000)).toEqual({ ok: true });
      expect(await appsStep(sara.id, sara.brickId, null, 2_001)).toMatchObject({ ok: false, why: 'cap', leftMicros: 2_000 });
      // What was given back is not counted any more
      await hold(sara.id, sara.brickId, 'done-2', { state: 'settled', amount: 9_000, took: 9_000, refunded: 9_000 });
      expect(await appsStep(sara.id, sara.brickId, null, 2_000)).toEqual({ ok: true });
      // A computer's time is a different class of credit
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 10_000 }, NOW)).toEqual({ ok: true });
    });

    it('holds an Instant step to a rule before any credit is held, with the rule’s words, and leaves a hold that already exists alone', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000, covers: 'apps' });
      const funds = createInstantFunds(() => NOW);
      const step = (key: string, micros: number) => funds.reserve({ key, personId: sara.id, amountMicros: micros, botId: sara.brickId, runId: 'run-1', charge: { class: 'instant', route: 'instant', provider: 'composio' } });
      const refused = await step(`instant-a-${tag}`, 50_000);
      expect(refused).toEqual({ ok: false, reason: 'rule', ruleId: expect.any(String), why: 'cap', leftMicros: 10_000, words: expect.stringContaining('No more than $0.01 a month') });
      expect(await prisma.creditHold.count({ where: { personId: sara.id } })).toBe(0);
      // Within the rule it goes on to the books (here nothing is funded, so the books answer, not the rule)
      expect(await step(`instant-b-${tag}`, 5_000)).not.toMatchObject({ reason: 'rule' });
      // A hold that is already there is asked about again: it is that hold, not a new step
      await hold(sara.id, sara.brickId, 'instant-c', { state: 'held', amount: 10_000 });
      expect(await step(`instant-c-${tag}`, 10_000)).not.toMatchObject({ reason: 'rule' });
    });

    it('two Instant steps asked at the same moment meet at the person’s lock: a cap with room for one lets exactly one through', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000, covers: 'apps' });
      const account = await prisma.fundingAccount.create({ data: { kind: 'person', ownerKey: sara.id, name: 'Sara', budgetMicros: BigInt(100_000_000) } });
      await prisma.creditLot.create({
        data: { slotKey: 'base:instant_apps', subjectKey: `person:${sara.id}`, periodKey: '2026-11', fundingAccountId: account.id, personId: sara.id, source: 'default', amountMicros: BigInt(1_000_000), covers: ['instant_apps'], startsAt: new Date('2026-11-01T00:00:00Z') },
      });
      const funds = createInstantFunds(() => NOW);
      const step = (key: string) => funds.reserve({ key: `${key}-${tag}`, personId: sara.id, amountMicros: 6_000, botId: sara.brickId, runId: null, charge: { class: 'instant', route: 'instant', provider: 'composio' } });
      const answers = await Promise.all([step('race-a'), step('race-b'), step('race-c')]);
      expect(answers.filter((one) => one.ok)).toHaveLength(1);
      expect(answers.filter((one) => !one.ok && one.reason === 'rule')).toHaveLength(2);
      expect(await prisma.creditHold.count({ where: { personId: sara.id, state: 'held' } })).toBe(1);
    });
  });

  describe('one rule over both kinds of credit', () => {
    it('a computer step and an Instant step asked at the same moment meet at one lock: a cap with room for one lets exactly one through', async () => {
      const funds = createInstantFunds(() => NOW);
      for (let round = 0; round < 20; round++) {
        const sara = await person(`sara${round}`);
        await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000, covers: 'all' });
        const account = await prisma.fundingAccount.create({ data: { kind: 'person', ownerKey: sara.id, name: 'Sara', budgetMicros: BigInt(100_000_000) } });
        await prisma.creditLot.create({
          data: { slotKey: 'base:instant_apps', subjectKey: `person:${sara.id}`, periodKey: '2026-11', fundingAccountId: account.id, personId: sara.id, source: 'default', amountMicros: BigInt(1_000_000), covers: ['instant_apps'], startsAt: new Date('2026-11-01T00:00:00Z') },
        });
        const computer = reserveRoom({ key: `mix-c-${round}-${tag}`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: `mix-job-${round}` }, NOW);
        const instant = funds.reserve({ key: `mix-i-${round}-${tag}`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, runId: null, charge: { class: 'instant', route: 'instant', provider: 'composio' } });
        const [a, b] = await Promise.all([computer, instant]);
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        // The one that did not get through was stopped by the rule, not by anything else
        expect([a, b].filter((one) => !one.ok)).toEqual([expect.objectContaining({ reason: 'rule' })]);
      }
    });
  });

  describe('a message id used for a different rule', () => {
    it('through the route: answers 409 in plain words with none of the other rule, and saves nothing', async () => {
      const sara = await person('sara');
      expect((await postRule(json('/x', 'POST', { userId: sara.uuid, sayingKey: 'say-clash', scope: 'bot', period: 'month', capMicros: 1_000_000 }), ctx(sara.brickId))).status).toBe(201);
      const clash = await postRule(json('/x', 'POST', { userId: sara.uuid, sayingKey: 'say-clash', scope: 'bot', period: 'month', capMicros: 5_000_000 }), ctx(sara.brickId));
      expect(clash.status).toBe(409);
      const body = await clash.json();
      expect(body).toEqual({ error: expect.stringContaining('already used for a different rule') });
      expect(Object.keys(body)).toEqual(['error']);
      expect(JSON.stringify(body)).not.toMatch(/\$|capMicros|words/);
      expect(await prisma.spendRule.count({ where: { ownerPersonId: sara.id } })).toBe(1);
    });
  });

  describe('where room is taken', () => {
    it('refuses room a rule does not allow, takes nothing, and says it is the rule: never "your allowance", so more credit is not offered', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 60_000 });
      const no = await reserveRoom({ key: `k-${tag}-1`, personId: sara.id, amountMicros: 70_000, botId: sara.brickId, jobId: 'j1' }, NOW);
      expect(no).toMatchObject({ ok: false, reason: 'rule', why: 'cap', leftMicros: 60_000 });
      expect(no.ok === false && no.reason).not.toBe('allowance');
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}` } })).toBe(0);
      const yes = await reserveRoom({ key: `k-${tag}-2`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j2' }, NOW);
      expect(yes).toMatchObject({ ok: true, created: true });
      // The same room asked for again is the same room: the rule does not see it as new spending
      expect(await reserveRoom({ key: `k-${tag}-2`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j2' }, NOW)).toMatchObject({ ok: true, created: false });
      // With 60,000 held, nothing more fits under a 60,000 cap
      expect(await reserveRoom({ key: `k-${tag}-3`, personId: sara.id, amountMicros: 1, botId: sara.brickId, jobId: 'j3' }, NOW)).toMatchObject({ ok: false, reason: 'rule', leftMicros: 0 });
    });

    it('a job that keeps running may not go on past what the rule allows, and a corrected rule lets it', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const key = `k-${tag}-4`;
      const room = await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j4' }, NOW);
      expect(room.ok).toBe(true);
      // The test clock is not the database's: the room starts when the test says it did
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW } });
      const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
      // Five minutes in, the job has used half a stretch and still has one stretch of lease: 90,000 can still be spent, under 100,000
      expect(await renewRoom({ key, moreMicros: 60_000 }, at(300))).toMatchObject({ ok: true });
      // Ten minutes in the job could cost 120,000 by the end of its lease: that is over, so it stops safely with the room it holds
      // (the lease it holds ends at minute 15 and can cost 90,000 whatever the clock says, so 10,000 is left of the cap: not enough for the 30,000 the renewal adds)
      expect(await renewRoom({ key, moreMicros: 60_000 }, at(600))).toMatchObject({ ok: false, reason: 'rule', leftMicros: 10_000 });
      expect((await prisma.meterReservation.findUnique({ where: { reservationKey: key } }))?.amountMicros).toBe(BigInt(120_000));
      await changeRule(made.rule.id, sara.id, { capMicros: 500_000 });
      expect(await renewRoom({ key, moreMicros: 60_000 }, at(600))).toMatchObject({ ok: true });
      await releaseRoom({ key }, NOW);
    });

    it('a renewal of room taken in an earlier month is held to this month’s rule for all it adds, not for the difference to room that rule never counted', async () => {
      const sara = await person('sara');
      // This month's cap of 100,000. The job's room was taken last month (its createdAt is before this month began), so this month's rule counts none of it
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const key = `k-${tag}-boundary`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'jb' }, NOW)).ok).toBe(true);
      const lastMonth = new Date(NOW.getTime() - 40 * 86_400_000);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: lastMonth, expiresAt: new Date(NOW.getTime() + 300_000), terms: [{ at: lastMonth.getTime(), micros: 60_000, stretchMs: 600_000 }] } });
      // Renewing adds 80,000 of room: the room is then 140,000, over the cap of 100,000 that this month never counted any of. Only the difference (80,000) was asked before, and passed
      expect(await renewRoom({ key, moreMicros: 80_000 }, NOW)).toMatchObject({ ok: false, reason: 'rule' });
      await releaseRoom({ key }, NOW);
    });

    it('room renewed across the end of a month counts in the new month: the next step may take only what is left of the cap, not the whole cap', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const key = `k-${tag}-boundary-after`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'jb2' }, NOW)).ok).toBe(true);
      // Taken last month (its createdAt is before this month began), lease still running
      const lastMonth = new Date(NOW.getTime() - 40 * 86_400_000);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: lastMonth, expiresAt: new Date(NOW.getTime() + 300_000), terms: [{ at: lastMonth.getTime(), micros: 60_000, stretchMs: 600_000 }] } });
      // Renewed by 20,000 this month: passes (80,000 of the 100,000)
      expect(await renewRoom({ key, moreMicros: 20_000 }, NOW)).toMatchObject({ ok: true });
      // The renewal is now part of this month: a new step of 30,000 is over what is left (20,000), and one of 20,000 is not
      const attempt = (amountMicros: number) => ({ payerPersonId: sara.id, botId: sara.brickId, taskKey: 'other', chargeClass: 'computer' as const, amountMicros });
      expect(await checkSpend(attempt(30_000), NOW)).toMatchObject({ ok: false, why: 'cap', leftMicros: 20_000 });
      expect(await checkSpend(attempt(20_000), NOW)).toMatchObject({ ok: true });
      // A second renewal in the same month is asked for the difference only (the room is already counted)
      expect(await renewRoom({ key, moreMicros: 10_000 }, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
      await releaseRoom({ key }, NOW);
    });

    describe('a computer lease that crosses the end of a month (N1)', () => {
      // 5 minutes into November. A 10 minute stretch is 60,000. The lease began at 23:55 on 31 October and was renewed once (120,000 held), now ending at 00:15:
      // 15 of its 20 minutes fall in November: 90,000 of November's cap of 100,000 is taken, and 10,000 is left
      const BOUNDARY = new Date('2026-11-01T00:05:00Z');
      const crossing = async (name: string) => {
        const sara = await person(name);
        const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
        if (!made.ok) throw new Error('not made');
        const key = `k-${tag}-${name}`;
        expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: `j-${name}` }, new Date('2026-10-31T23:55:00Z'))).ok).toBe(true);
        await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: new Date('2026-10-31T23:55:00Z'), expiresAt: new Date('2026-11-01T00:15:00Z'), amountMicros: BigInt(120_000), renewals: 1 } });
        const ask = (micros: number, class_: 'apps' | 'computer' = 'apps') => checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: class_, amountMicros: micros }, BOUNDARY);
        return { sara, key, made, ask };
      };

      it('is seen by an Instant App in the new month before any renewal: exactly what is left passes, one micro more is refused', async () => {
        const { key, ask } = await crossing('mia');
        expect(await ask(10_000)).toEqual({ ok: true });
        expect(await ask(10_001)).toMatchObject({ ok: false, why: 'cap', leftMicros: 10_000 });
        await releaseRoom({ key }, BOUNDARY);
      });

      it('is renewed for the growth of what the month counts of it, not for all of it', async () => {
        const { key } = await crossing('noa');
        // Renewed at 00:10, the lease would end at 00:20 and cover 20 minutes of November (120,000): 30,000 more than the 90,000 it counts now, with 10,000 left
        expect(await renewRoom({ key, moreMicros: 60_000 }, new Date('2026-11-01T00:10:00Z'))).toMatchObject({ ok: false, reason: 'rule', leftMicros: 10_000 });
        // Renewed at 00:05 it would end at 00:15, where it already ends: November's count does not grow, so it goes on though it is over the cap's last 10,000 for any new step
        expect(await renewRoom({ key, moreMicros: 60_000 }, BOUNDARY)).toMatchObject({ ok: true });
        await releaseRoom({ key }, BOUNDARY);
      });

      it('counts the same after the job ends: the job’s cost is split by the time before and after the boundary', async () => {
        const { sara, key, ask } = await crossing('oli');
        await releaseRoom({ key }, BOUNDARY);
        // The job ran 20 minutes (23:55 to 00:15) and cost 120,000, written as one event when it ended at 00:15: 15 minutes of it are November's, 90,000
        await prisma.meterEvent.create({
          data: { eventId: `rules-${tag}-cross`, kind: 'computer_time', pool: 'computer', occurredAt: new Date('2026-11-01T00:15:00Z'), personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: 'jx', quantity: 1200, unit: 'second', costMicros: BigInt(120_000), basis: 'measured', detail: { startedMs: Date.parse('2026-10-31T23:55:00Z') } },
        });
        const later = (micros: number) => checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: micros }, new Date('2026-11-01T00:16:00Z'));
        expect(await later(10_000)).toEqual({ ok: true });
        expect(await later(10_001)).toMatchObject({ ok: false, why: 'cap', leftMicros: 10_000 });
        void ask;
      });

      it('splits a job that was charged for seconds after it ended (a hand over) over all the seconds charged', async () => {
        const sara = await person('vic');
        await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 1_000_000 });
        // Held from 23:59:50 to 00:00:10 (20 seconds) and 20 more seconds handing over files: 40 seconds, 400,000. A quarter of it, 100,000, is October's
        await prisma.meterEvent.create({
          data: { eventId: `rules-${tag}-handover`, kind: 'computer_time', pool: 'computer', occurredAt: new Date('2026-11-01T00:00:10Z'), personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: 'jh', quantity: 40, unit: 'second', costMicros: BigInt(400_000), basis: 'measured', detail: { startedMs: Date.parse('2026-10-31T23:59:50Z') } },
        });
        const answer = await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 700_001 }, new Date('2026-11-01T00:16:00Z'));
        expect(answer).toMatchObject({ ok: false, why: 'cap', leftMicros: 700_000 });
      });

      it('counts a job event written without its start (older) whole in the month it ended in', async () => {
        const sara = await person('pat');
        await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
        await prisma.meterEvent.create({
          data: { eventId: `rules-${tag}-legacy`, kind: 'computer_time', pool: 'computer', occurredAt: new Date('2026-11-01T00:15:00Z'), personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: 'jy', quantity: 1200, unit: 'second', costMicros: BigInt(120_000), basis: 'measured' },
        });
        expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 1 }, new Date('2026-11-01T00:16:00Z'))).toMatchObject({ ok: false, why: 'cap', leftMicros: 0 });
      });

      it('a job that crossed into the month and was written while the cap was being counted is counted whole, never taken off without being added', async () => {
        const sara = await person('stu');
        await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
        // The job's event lands between the cap's two reads of the books (whichever it makes first)
        let landed = false;
        const land = async () => {
          if (landed) return;
          landed = true;
          await prisma.meterEvent.create({
            data: { eventId: `rules-${tag}-between`, kind: 'computer_time', pool: 'computer', occurredAt: new Date('2026-11-01T00:15:00Z'), personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: 'jz', quantity: 1200, unit: 'second', costMicros: BigInt(120_000), basis: 'measured', detail: { startedMs: Date.parse('2026-10-31T23:55:00Z') } },
          });
        };
        const events = prisma.meterEvent as unknown as { aggregate: (...args: unknown[]) => Promise<unknown>; findMany: (...args: unknown[]) => Promise<unknown> };
        const aggregate = events.aggregate;
        const findMany = events.findMany;
        let reads = 0;
        const spies = [
          jest.spyOn(events, 'aggregate').mockImplementation(async (...args) => { const out = await aggregate.apply(prisma.meterEvent, args); await land(); return out; }),
          // The check reads the calls with no price first, then what crossed into the month, then the total: the event lands after the second read (the
          // crossed one), so the total has it and the crossed part does not (the order that must never take it off without adding it)
          jest.spyOn(events, 'findMany').mockImplementation(async (...args) => { const out = await findMany.apply(prisma.meterEvent, args); reads += 1; if (reads >= 2) await land(); return out; }),
        ];
        try {
          const answer = await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 1 }, new Date('2026-11-01T00:16:00Z'));
          expect(answer).toMatchObject({ ok: false, why: 'cap' });
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });

      it('two admissions at the same moment never both take the last room', async () => {
        const sara = await person('quin');
        await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
        const take = (index: number) => reserveRoom({ key: `k-${tag}-par-${index}`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: `jp-${index}` }, NOW);
        const answers = await Promise.all([take(1), take(2)]);
        expect(answers.filter((one) => one.ok)).toHaveLength(1);
        for (const index of [1, 2]) await releaseRoom({ key: `k-${tag}-par-${index}` }, NOW);
      });

      it('a cap lowered while a step waited is the cap it is held to', async () => {
        const { sara, made, key } = await crossing('rae');
        await releaseRoom({ key }, BOUNDARY);
        await changeRule(made.rule.id, sara.id, { capMicros: 30_000 });
        expect(await reserveRoom({ key: `k-${tag}-cap`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'jcap' }, BOUNDARY)).toMatchObject({ ok: false, reason: 'rule' });
      });
    });

    it('a price that changed in the middle of a lease counts each stretch at its own price: $0.25 through minute 15, not the $0.225 an average gives', async () => {
      const sara = await person('sara');
      // A stretch is 10 minutes. The first is held at 100,000; renewed at minute 5 for 200,000 (the price doubled): 5 minutes at 100,000 per ten and 10 at 200,000 per ten
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 240_000 });
      if (!made.ok) throw new Error('not made');
      const key = `k-${tag}-price`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 100_000, botId: sara.brickId, jobId: 'jprice' }, NOW)).ok).toBe(true);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW } });
      const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
      // Equal stretches would count 225,000, under 240,000; at its own prices the lease can cost 250,000, which is over
      expect(await renewRoom({ key, moreMicros: 200_000 }, at(300))).toMatchObject({ ok: false, reason: 'rule' });
      await changeRule(made.rule.id, sara.id, { capMicros: 250_000 });
      expect(await renewRoom({ key, moreMicros: 200_000 }, at(300))).toMatchObject({ ok: true });
      const stored = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: key } });
      expect(stored.terms).toEqual([{ at: NOW.getTime(), micros: 100_000, stretchMs: 600_000 }, { at: at(300).getTime(), micros: 200_000, stretchMs: 600_000 }]);
      // Another step sees the same $0.25: exactly what is left of the cap passes nothing, one micro more is refused
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 1 }, at(301))).toMatchObject({ ok: false, why: 'cap', leftMicros: 0 });
      await releaseRoom({ key }, NOW);
    });

    it('a lease taken before terms were recorded is counted as equal stretches', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      const key = `k-${tag}-legacy`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'jleg' }, NOW)).ok).toBe(true);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW, terms: Prisma.DbNull, amountMicros: BigInt(120_000), renewals: 1, expiresAt: new Date(NOW.getTime() + 900_000) } });
      // 120,000 held over two stretches, covering 15 minutes: 90,000, so 10,000 is left
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 10_000 }, new Date(NOW.getTime() + 60_000))).toEqual({ ok: true });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'apps', amountMicros: 10_001 }, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: false, why: 'cap' });
      await releaseRoom({ key }, NOW);
    });

    it('renewing often does not stop a job early: a rule counts what the job can really cost, not the room stacked up by every renewal', async () => {
      const sara = await person('sara');
      // $0.15 is 25 minutes of a computer at 6,000 a minute: with one stretch (10 minutes, 60,000) of lease on top, the job may use 15 minutes
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 150_000 });
      const key = `k-${tag}-8`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j8' }, NOW)).ok).toBe(true);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW } });
      const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
      // Asked every 4 minutes (0.4 of a stretch), each renewal holds a whole stretch more: the held room is 300,000 by the fourth renewal
      for (const seconds of [240, 480, 720, 840]) {
        expect(await renewRoom({ key, moreMicros: 60_000 }, at(seconds))).toMatchObject({ ok: true });
      }
      // Sixteen minutes in the job could cost 156,000: that is what the rule stops
      expect(await renewRoom({ key, moreMicros: 60_000 }, at(960))).toMatchObject({ ok: false, reason: 'rule' });
      await releaseRoom({ key }, NOW);
    });

    it('a first stretch is not renewed when the lease it would add could take the job past the cap, though one more millionth would still fit', async () => {
      const sara = await person('sara');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 80_000 });
      const key = `k-${tag}-9`;
      expect((await reserveRoom({ key, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j9' }, NOW)).ok).toBe(true);
      await prisma.meterReservation.update({ where: { reservationKey: key }, data: { createdAt: NOW } });
      // At the end of the first stretch, renewing would let the job use ten minutes more (120,000 in all): over 80,000, so it stops with what it holds
      expect(await renewRoom({ key, moreMicros: 60_000 }, new Date(NOW.getTime() + 600_000 - 1000))).toMatchObject({ ok: false, reason: 'rule' });
      expect((await prisma.meterReservation.findUnique({ where: { reservationKey: key } }))?.renewals).toBe(0);
      await releaseRoom({ key }, NOW);
    });

    it('"only my own accounts" refuses any paid step charged to credit, and being asked by someone else changes nothing for them', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', onlyOwnAccounts: true });
      expect(await reserveRoom({ key: `k-${tag}-5`, personId: sara.id, amountMicros: 1, botId: sara.brickId, jobId: 'j5' }, NOW)).toMatchObject({ ok: false, reason: 'rule', why: 'own_accounts' });
      expect(await reserveRoom({ key: `k-${tag}-6`, personId: sara.id, amountMicros: 1, botId: sara.brickId, jobId: 'j6', chargeClass: 'apps' }, NOW)).toMatchObject({ ok: false, reason: 'rule' });
      // Omar's credit and Omar's Brick are not touched by Sara's rule, and nothing falls back to anyone's account
      expect(await reserveRoom({ key: `k-${tag}-7`, personId: omar.id, amountMicros: 10_000, botId: omar.brickId, jobId: 'j7' }, NOW)).toMatchObject({ ok: true });
    });
  });

  describe('a computer job under a rule', () => {
    const env = process.env.COMPUTER_PROVIDER;
    beforeAll(() => {
      process.env.COMPUTER_PROVIDER = 'fake';
      setComputerProviderForTests(new FakeComputerProvider());
    });
    afterAll(() => {
      setComputerProviderForTests(null);
      process.env.COMPUTER_PROVIDER = env;
    });

    it('is refused at the start with the rule’s words, leaves no job behind, and is not a wait in line that would be retried', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      // Under the cap for a first step of 1 millionth, over it for a stretch of room (60,000)
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Make the report' }, NOW);
      expect(started).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.01 a month') });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}` } })).toBe(0);
    });

    it('a start asked again for a run that already has its job finds that job, even when its own held room used the cap up exactly', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 60_000 });
      const job = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'running', runId: 'run-x', startedAt: NOW } });
      await prisma.meterReservation.create({ data: { reservationKey: `own-${tag}`, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, jobId: job.id, amountMicros: BigInt(60_000), state: 'held', expiresAt: new Date(NOW.getTime() + 600_000), createdAt: NOW } });
      // The job's own room is the whole cap: asked again for the same run it is that job, not a refusal; for anything else nothing is left
      expect(await ownerSpendAllowed(sara.brickId, sara.id, 'computer', NOW, 'run-x')).toEqual({ ok: true });
      expect(await ownerSpendAllowed(sara.brickId, sara.id, 'computer', NOW, 'run-other')).toMatchObject({ ok: false, why: 'cap' });
      expect(await ownerSpendAllowed(sara.brickId, sara.id, 'computer', NOW, null)).toMatchObject({ ok: false, why: 'cap' });
    });

    it('a queued job for a run, asked again after a rule is said, is refused with the rule’s words and taken away, not reported as started', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Make the report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: new Date(NOW.getTime() + 600_000) } });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'queued', runId: run.id } });
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: run.id }, NOW);
      expect(again).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.01 a month') });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
    });

    it('a second ask for a run, made while the first is being refused by a rule, gets the same rule words: never "started" and never "controls not set up"', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Make the report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      // The job the first ask has just stopped for the rule, not yet taken away
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: new Date(NOW.getTime() + 600_000) } });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'stopped', endedBy: 'rule', endedAt: NOW, runId: run.id } });
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: run.id }, NOW)).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.01 a month') });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      // Then the real thing, many times: two asks at once for one run are both the rule's refusal, whichever got there first
      for (let round = 0; round < 15; round++) {
        const again = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: new Date(NOW.getTime() + (round + 1) * 60_000), revision: round + 2, leaseUntil: new Date(NOW.getTime() + 600_000) } });
        const ask = () => startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: again.id }, NOW);
        const answers = await Promise.all([ask(), ask(), ask()]);
        for (const answer of answers) expect(answer).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.01 a month') });
      }
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
    });

    it('a replay for a run whose job a task rule has just stopped gets that rule’s words, not the generic ones', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Make the report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: new Date(NOW.getTime() + 600_000) } });
      const stopped = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'stopped', endedBy: 'rule', endedAt: NOW, runId: run.id } });
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'task', taskKey: stopped.id, period: 'task', capMicros: 10_000 });
      expect(made.ok).toBe(true);
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: run.id }, NOW);
      expect(again).toMatchObject({ ok: false, reason: 'rule' });
      expect(again.ok === false && 'words' in again && again.words).not.toBe('A rule you said stopped this job');
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
    });

    it('a job that ran and was stopped later by a rule is never removed when its run is asked for again: it is over, returned as it stands', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Make the report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: new Date(NOW.getTime() + 600_000) } });
      const ran = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'stopped', endedBy: 'rule', startedAt: NOW, endedAt: NOW, runId: run.id } });
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Report', runId: run.id }, NOW);
      expect(again).toMatchObject({ ok: true, job: { id: ran.id, status: 'stopped' } });
      expect(await prisma.computerJob.count({ where: { id: ran.id } })).toBe(1);
    });

    it('through the route: what is left is above the first millionth but under a stretch of room, so the pre-check passes and the start itself is refused, still with the rule’s words', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const body = await (await postJob(json('/x', 'POST', { userId: sara.uuid, title: 'Make the report' }), ctx(sara.brickId))).json();
      expect(body).toEqual({ ok: false, reason: 'rule', rule: { id: null, why: null, leftMicros: null, words: expect.stringContaining('No more than $0.01 a month') } });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
    });

    it('through the route: a replayed start for a run whose job is still queued gets the same refusal with the words, and no job is left', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'goal', words: 'Make the report', outcome: 'Done', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait' } as never });
      const run = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: new Date(NOW.getTime() + 600_000) } });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Report', status: 'queued', runId: run.id } });
      const body = await (await postJob(json('/x', 'POST', { userId: sara.uuid, title: 'Report', runId: run.id }), ctx(sara.brickId))).json();
      expect(body).toEqual({ ok: false, reason: 'rule', rule: { id: null, why: null, leftMicros: null, words: expect.stringContaining('No more than $0.01 a month') } });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
    });

    it('a model call inside a running job that a rule does not allow is refused as the rule, with its words, not as "pool"', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      // The job holds 60,000 of the 100,000; a call asking 50,000 more does not fit under the rule
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      const refused = await authorizeModelCall({ token: minted.token, callId: 'call-1', estimateMicros: 50_000, payer: 'universe' }, NOW);
      expect(refused).toEqual({ ok: false, reason: 'rule', ruleId: expect.any(String), why: 'cap', leftMicros: 40_000, words: expect.stringContaining('No more than $0.10 a month') });
      // Nothing was held for it, and the job is over as "rule" (as a refused renewal ends it): its key is no longer good, so no call goes after it
      expect(await prisma.meterReservation.count({ where: { jobId: started.job.id, reservationKey: { contains: 'call' } } })).toBe(0);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'rule' });
      expect(await authorizeModelCall({ token: minted.token, callId: 'call-2', estimateMicros: 30_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'refused' });
    });

    it('a try refused by a rule leaves alone a job another try put on the machine at the same moment', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 10_000 });
      // The other try claims the job just before this one hears the rule's refusal
      const reserve = reserveRoom as jest.MockedFunction<typeof reserveRoom>;
      const real = jest.requireActual('@/lib/meter-allowance').reserveRoom as typeof reserveRoom;
      reserve.mockImplementationOnce(async (input, at) => {
        await prisma.computerJob.updateMany({ where: { botId: sara.brickId, status: 'queued' }, data: { status: 'running', reservationKey: 'other-try', startedAt: NOW, stretchStarted: NOW } });
        return real(input, at);
      });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Make the report' }, NOW);
      expect(started).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(await prisma.computerJob.findMany({ where: { botId: sara.brickId }, select: { status: true, endedBy: true } })).toEqual([{ status: 'running', endedBy: null }]);
    });

    it('counts a model call with no price at the room it held, never as nothing', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      const call = await authorizeModelCall({ token: minted.token, callId: 'unknown-1', estimateMicros: 30_000, payer: 'universe' }, NOW);
      expect(call).toMatchObject({ ok: true, reservedMicros: 30_000 });
      // The call ran and its price is not known: its room settles, and its event has no cost
      expect(await settleModelCall(started.job.id, 'unknown-1', { costMicros: null, basis: 'unknown', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: true });
      // The job holds 60,000 and the call took 30,000: 10,000 is left, not 40,000
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 10_001 }, NOW)).toMatchObject({ ok: false, leftMicros: 10_000 });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 10_000 }, NOW)).toEqual({ ok: true });
    });

    it('does not count a model call on the owner\'s own key against a cap on the platform credit', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      // The call ran on her own key and cost $0.50: no room was taken, and her credit paid none of it
      expect(await authorizeModelCall({ token: minted.token, callId: 'own-1', estimateMicros: 500_000, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
      expect(await settleModelCall(started.job.id, 'own-1', { costMicros: 500_000, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW)).toEqual({ ok: true });
      // Only the job's own held room (60,000) counts: 40,000 is left under 100,000
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 40_000 }, NOW)).toEqual({ ok: true });
      expect(await checkSpend({ payerPersonId: sara.id, botId: sara.brickId, taskKey: null, chargeClass: 'computer', amountMicros: 40_001 }, NOW)).toMatchObject({ ok: false, leftMicros: 40_000 });
    });

    it('a job that is running when a rule stops more room ends as "rule", saying so, not as "our room is used up"', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      expect(started.job.status).toBe('running');
      await prisma.meterReservation.updateMany({ where: { jobId: started.job.id }, data: { createdAt: NOW } });
      // 60,000 is held. A minute in, the job can still cost 66,000 by the end of its lease: that fits
      expect(await renewJob(started.job.id, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
      // Ten minutes in it could cost 120,000, which is over 100,000
      const renewed = await renewJob(started.job.id, new Date(NOW.getTime() + 600_000));
      expect(renewed).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.10 a month') });
      const ended = await prisma.computerJob.findUnique({ where: { id: started.job.id } });
      expect(ended).toMatchObject({ status: 'stopped', endedBy: 'rule' });
    });

    it('a model call a rule refuses ends the job right there as "rule", so a later "failed, ours" from the runner changes nothing and nothing is given back', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      // 60,000 is the job's own room; a call for 30,000 fits under 100,000, and the next for 30,000 does not
      expect(await authorizeModelCall({ token: minted.token, callId: 'c1', estimateMicros: 30_000, payer: 'universe' }, NOW)).toMatchObject({ ok: true });
      await settleModelCall(started.job.id, 'c1', { costMicros: 30_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect(await authorizeModelCall({ token: minted.token, callId: 'c2', estimateMicros: 30_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'rule' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'rule', endNote: expect.stringContaining('No more than $0.10 a month') });
      await finishJob(started.job.id, 'failed', NOW, 'Three turns failed', 'ours');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'rule' });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${started.job.id}:call:c1` } })).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
    });
  });

  describe('through the bot server’s routes', () => {
    it('POST saves a rule, answers the one question, refuses a guest and someone who does not pay, and GET lists what reaches the Brick', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const asked = await (await postRule(json('/x', 'POST', { userId: sara.uuid, scope: 'bot', capMicros: 1_000_000 }), ctx(sara.brickId))).json();
      expect(asked).toMatchObject({ ok: false, reason: 'needs_answer', ask: { question: 'Is $1.00 for each task, each day or each month?' } });
      const saved = await postRule(json('/x', 'POST', { userId: sara.uuid, sayingKey: 'say-1', scope: 'bot', period: 'month', capMicros: 1_000_000 }), ctx(sara.brickId));
      expect(saved.status).toBe(201);
      const again = await postRule(json('/x', 'POST', { userId: sara.uuid, sayingKey: 'say-1', scope: 'bot', period: 'month', capMicros: 1_000_000 }), ctx(sara.brickId));
      expect(again.status).toBe(200);
      expect(await (await postRule(json('/x', 'POST', { userId: omar.uuid, scope: 'bot', period: 'day', capMicros: 5 }), ctx(sara.brickId))).json()).toEqual({ ok: false, reason: 'not_allowed' });
      expect(await (await postRule(json('/x', 'POST', { userId: 'guest-1', isGuest: true, scope: 'person', onlyOwnAccounts: true }), ctx(sara.brickId))).json()).toEqual({ ok: false, reason: 'not_allowed' });
      expect((await postRule(json('/x', 'POST', { userId: sara.uuid, nothing: true }), ctx(sara.brickId))).status).toBe(400);
      expect((await postRule(json('/x', 'POST', { userId: sara.uuid, scope: 'bot' }), ctx(sara.brickId))).status).toBe(400);
      const listed = await (await getRules(new NextRequest(`http://localhost/x?userId=${sara.uuid}`), ctx(sara.brickId))).json();
      expect(listed.rules).toHaveLength(1);
      expect(listed.rules[0].words).toContain('No more than $1.00 a month');
    });

    it('a computer job is refused with the rule’s words before any job exists, and only for the Brick’s own owner', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 0 });
      const refused = await (await postJob(json('/x', 'POST', { userId: sara.uuid, title: 'Make the report' }), ctx(sara.brickId))).json();
      expect(refused).toMatchObject({ ok: false, reason: 'rule', rule: { why: 'cap', leftMicros: 0 } });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      // Someone who is not the Brick's owner hears "not_owner" from the start itself, not a rule of theirs
      expect(await (await postJob(json('/x', 'POST', { userId: omar.uuid, title: 'x' }), ctx(sara.brickId))).json()).toEqual({ ok: false, reason: 'not_owner' });
    });

    it('the person corrects and ends a rule on their own page; someone else’s rule is not found', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 1_000_000 });
      if (!made.ok) throw new Error('not made');
      const call = (verb: 'PATCH' | 'DELETE', body?: unknown) => (verb === 'PATCH' ? patchRule : deleteRule)(json('/x', verb, body), { params: Promise.resolve({ ruleId: made.rule.id }) });
      (getSessionUser as jest.Mock).mockResolvedValue({ id: omar.id });
      expect((await call('PATCH', { capMicros: 5 })).status).toBe(404);
      expect((await call('DELETE')).status).toBe(404);
      (getSessionUser as jest.Mock).mockResolvedValue({ id: sara.id });
      const patched = await call('PATCH', { capMicros: 3_000_000, period: 'day' });
      expect(patched.status).toBe(200);
      expect((await patched.json()).rule).toMatchObject({ capMicros: 3_000_000, period: 'day', version: 2 });
      expect((await call('PATCH', { capMicros: -4 })).status).toBe(400);
      expect((await call('DELETE')).status).toBe(204);
      (getSessionUser as jest.Mock).mockResolvedValue(null);
    });
  });

  describe('receipts', () => {
    it('opens once per Brick and task, with a link the reply can carry and the words for who pays; the first title stands', async () => {
      const sara = await person('sara');
      const first = await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'task-1', title: 'Welcome video', category: 'apps', boundMicros: 1_200_000 }, NOW);
      const again = await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'task-1', title: 'Another name' }, NOW);
      expect(first).toMatchObject({ created: true, link: expect.stringMatching(/^\[What it used\]\(#usage=act_.+\)$/) });
      expect(again).toMatchObject({ created: false, id: first.id });
      expect((await prisma.taskReceipt.findFirst({ where: { personId: sara.id } }))?.title).toBe('Welcome video');
      await expect(openReceipt({ botId: sara.brickId, personId: (await person('omar')).id, taskKey: 'task-1', title: 'Mine' }, NOW)).rejects.toThrow(RangeError);
      await expect(openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: '', title: 'x' }, NOW)).rejects.toThrow(RangeError);
    });

    it('lists a finished task with what it used from the books, what it took and who paid; a running task is not listed yet', async () => {
      const sara = await person('sara');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'trip', runId: 'run-9', title: 'Trip page: Web Summit Qatar', category: 'apps' }, NOW);
      expect(await activityFor(sara.id)).toEqual([]);
      await spend(sara.id, sara.brickId, 30_000, { jobId: 'trip', instant: true });
      await spend(sara.id, sara.brickId, 30_000, { jobId: 'trip', instant: true });
      await prisma.meterEvent.create({
        data: { eventId: `think-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'universe-ai', quantity: BigInt(1), unit: 'call', costMicros: BigInt(1000), basis: 'measured', detail: { runId: 'run-9' } },
      });
      // Another person's task with the same key shows nothing of it here
      await spend(sara.id, sara.brickId, 777_000, { jobId: 'other-task', instant: true });
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'trip', personId: sara.id, state: 'done', chargedMicros: 60_000 }, NOW)).toMatchObject({ ok: true, state: 'done' });
      const [item] = await activityFor(sara.id);
      expect(item).toMatchObject({
        title: 'Trip page: Web Summit Qatar',
        state: 'done',
        spentMicros: 60_000,
        category: 'apps',
        payer: 'you',
        paidBy: 'Paid by you',
        lines: [
          { label: 'Instant Apps, 2 uses', amountMicros: 60_000 },
          { label: "sara's Brick's own thinking", note: 'Universe AI' },
        ],
      });
      expect(item.id).toMatch(/^act_/);
    });

    it('two tasks of one run do not both show the run\'s own cost, and another job of the run is never added to either', async () => {
      const sara = await person('sara');
      const later = new Date(NOW.getTime() + 1000);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'first', runId: 'run-7', title: 'First', category: 'apps' }, NOW);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'second', runId: 'run-7', title: 'Second', category: 'apps' }, later);
      await prisma.meterEvent.create({
        data: { eventId: `think7-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'universe-ai', quantity: BigInt(1), unit: 'call', costMicros: BigInt(1000), basis: 'measured', detail: { runId: 'run-7' } },
      });
      // A job of the same run that took computer time is that job's, never the receipts'
      await prisma.meterEvent.create({
        data: { eventId: `job7-${tag}`, kind: 'computer_time', pool: 'computer', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: 'other-job', quantity: BigInt(60), unit: 'second', costMicros: BigInt(500_000), basis: 'measured', detail: { runId: 'run-7' } },
      });
      await closeReceipt({ botId: sara.brickId, taskKey: 'first', personId: sara.id, state: 'done' }, NOW);
      await closeReceipt({ botId: sara.brickId, taskKey: 'second', personId: sara.id, state: 'done' }, later);
      const items = await activityFor(sara.id);
      const first = items.find((one) => one.title === 'First');
      const second = items.find((one) => one.title === 'Second');
      // The run's own thinking is on the first receipt only; the other job's computer time is on neither
      expect(first?.lines).toEqual([expect.objectContaining({ note: 'Universe AI' })]);
      expect(second?.lines).toEqual([]);
    });

    it('a job a rule refused before it ever ran is not an Activity line, and one that ran and was stopped by a rule is', async () => {
      const sara = await person('sara');
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Never ran', status: 'stopped', endedBy: 'rule', endedAt: NOW } });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Ran then stopped', status: 'stopped', endedBy: 'rule', startedAt: NOW, endedAt: new Date(NOW.getTime() + 1000) } });
      // Jobs with nothing said about how they ended are listed as before (a missing value is not "not a rule")
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Plain done', status: 'done', endedAt: new Date(NOW.getTime() + 2000) } });
      expect((await activityFor(sara.id)).map((item) => item.title)).toEqual(['Plain done', 'Ran then stopped']);
    });

    it('closing says what happened and then stays: done and refunded do not change, checking can still become either', async () => {
      const sara = await person('sara');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'vid', title: 'Welcome video', category: 'apps' }, NOW);
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'checking' }, NOW)).toMatchObject({ ok: true, state: 'checking' });
      // A task being looked up is not listed: nobody reads a state they cannot act on. It shows once it settles.
      expect(await activityFor(sara.id)).toEqual([]);
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'refunded', chargedMicros: 920_000 }, NOW)).toMatchObject({ ok: true, state: 'refunded' });
      // A refund took nothing, whatever figure came with it; an Apps task that came to nothing (no run, nothing in the books) is not listed
      expect(await prisma.taskReceipt.findFirstOrThrow({ where: { botId: sara.brickId, taskKey: 'vid' } })).toMatchObject({ state: 'refunded', chargedMicros: BigInt(0) });
      expect(await activityFor(sara.id)).toEqual([]);
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'done', chargedMicros: 5 }, NOW)).toMatchObject({ ok: true, state: 'refunded' });
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'nope', personId: sara.id, state: 'done' }, NOW)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('a replayed open answers with the payer stored on the receipt, not whoever pays now', async () => {
      const sara = await person('sara');
      const first = await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'pay-1', title: 'Flights', payer: { kind: 'sponsor', name: 'BAWES Universe' } }, NOW);
      expect(first.payer).toEqual({ kind: 'sponsor', name: 'BAWES Universe' });
      const again = await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'pay-1', title: 'Flights', payer: { kind: 'person', personId: sara.id, name: null } }, NOW);
      expect(again).toMatchObject({ created: false, payer: { kind: 'sponsor', name: 'BAWES Universe' } });
    });

    it('a task’s total is what the books say, whatever charge came with the close, and the charge only stands in when the books have none', async () => {
      const sara = await person('sara');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'tot-1', title: 'Report', category: 'apps' }, NOW);
      await spend(sara.id, sara.brickId, 500_000, { jobId: 'tot-1', instant: true });
      await closeReceipt({ botId: sara.brickId, taskKey: 'tot-1', personId: sara.id, state: 'done', chargedMicros: 0 }, NOW);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'tot-2', title: 'Other', category: 'apps' }, NOW);
      await spend(sara.id, sara.brickId, 500_000, { jobId: 'tot-2', instant: true });
      await closeReceipt({ botId: sara.brickId, taskKey: 'tot-2', personId: sara.id, state: 'done', chargedMicros: 900_000 }, NOW);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'tot-3', title: 'Nothing recorded', category: 'apps' }, NOW);
      await closeReceipt({ botId: sara.brickId, taskKey: 'tot-3', personId: sara.id, state: 'done', chargedMicros: 70_000 }, NOW);
      const byTitle = new Map((await activityFor(sara.id)).map((item) => [item.title, item.spentMicros]));
      expect(byTitle.get('Report')).toBe(500_000);
      expect(byTitle.get('Other')).toBe(500_000);
      expect(byTitle.get('Nothing recorded')).toBe(70_000);
    });

    it('the newest finished task is listed when there are more than the list holds, even if it began first', async () => {
      const sara = await person('sara');
      const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'long', title: 'Began first, ended last', category: 'apps' }, at(0));
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'a', title: 'A', category: 'apps' }, at(1));
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'b', title: 'B', category: 'apps' }, at(2));
      await closeReceipt({ botId: sara.brickId, taskKey: 'a', personId: sara.id, state: 'done' }, at(3));
      await closeReceipt({ botId: sara.brickId, taskKey: 'b', personId: sara.id, state: 'done' }, at(4));
      await closeReceipt({ botId: sara.brickId, taskKey: 'long', personId: sara.id, state: 'done' }, at(60));
      expect((await activityFor(sara.id, 2)).map((item) => item.title)).toEqual(['Began first, ended last', 'B']);
    });

    it('a failed computer job is "refunded" only when the books show nothing was taken: a price not known yet is not nothing', async () => {
      const sara = await person('sara');
      await prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, enabled: true, provider: 'fake' }, update: {} });
      const unknown = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Price unknown', status: 'failed', endedBy: 'error', startedAt: NOW, endedAt: new Date(NOW.getTime() + 1000) } });
      await prisma.meterEvent.create({
        data: { eventId: `unk-${tag}`, kind: 'computer_time', pool: 'computer', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'universe', route: 'computer', jobId: unknown.id, quantity: BigInt(60), unit: 'second', costMicros: null, basis: 'unknown' },
      });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Took nothing', status: 'failed', endedBy: 'error', endedAt: new Date(NOW.getTime() + 2000) } });
      const byTitle = new Map((await activityFor(sara.id)).map((item) => [item.title, item.state]));
      expect(byTitle.get('Price unknown')).toBe('done');
      expect(byTitle.get('Took nothing')).toBe('refunded');
    });

    it('a computer’s job whose receipt is still being looked up (checking) is not listed as the job’s own line either', async () => {
      const sara = await person('sara');
      await prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, enabled: true, provider: 'fake' }, update: {} });
      const job = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Hidden while checked', status: 'done', startedAt: NOW, endedAt: new Date(NOW.getTime() + 1000) } });
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: job.id, title: 'Hidden while checked', category: 'computer' }, NOW);
      await prisma.taskReceipt.updateMany({ where: { personId: sara.id, taskKey: job.id }, data: { state: 'checking' } });
      expect((await activityFor(sara.id)).map((item) => item.title)).not.toContain('Hidden while checked');
      await prisma.taskReceipt.updateMany({ where: { personId: sara.id, taskKey: job.id }, data: { state: 'done', endedAt: NOW } });
      expect((await activityFor(sara.id)).filter((item) => item.title === 'Hidden while checked')).toHaveLength(1);
    });

    it('names a sponsor that pays, to the person it paid for, with nothing taken from their credit', async () => {
      const sara = await person('sara');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'flights', title: 'Flights to Doha', payer: { kind: 'sponsor', name: 'BAWES Universe' } }, NOW);
      await closeReceipt({ botId: sara.brickId, taskKey: 'flights', personId: sara.id, state: 'done', chargedMicros: 0 }, NOW);
      expect((await activityFor(sara.id))[0]).toMatchObject({ payer: 'sponsor', payerName: 'BAWES Universe', paidBy: 'Paid by BAWES Universe', spentMicros: null });
    });

    it('a computer’s job shows without anyone opening a receipt, newest first, and one that failed and took nothing is "refunded"', async () => {
      const sara = await person('sara');
      await prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, enabled: true, provider: 'fake' }, update: {} });
      const done = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Weekly sales report', status: 'done', startedAt: new Date('2026-11-14T10:00:00Z'), endedAt: new Date('2026-11-14T10:10:00Z') } });
      const failed = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Broken start', status: 'failed', endedBy: 'error', endedAt: new Date('2026-11-15T09:00:00Z') } });
      await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Still going', status: 'running', startedAt: NOW } });
      await spend(sara.id, sara.brickId, 410_000, { jobId: done.id, at: new Date('2026-11-14T10:10:00Z') });
      const list = await activityFor(sara.id);
      expect(list.map((item) => item.title)).toEqual(['Broken start', 'Weekly sales report']);
      expect(list[0]).toMatchObject({ state: 'refunded', spentMicros: null, category: 'computer' });
      expect(list[1]).toMatchObject({ state: 'done', spentMicros: 410_000, category: 'computer', paidBy: 'Paid by you', lines: [{ label: 'Computer, 1 minute', amountMicros: 410_000 }] });
      expect(list[1].id).toBe(`act_job_${done.id}`);
      expect(failed.id).toBeTruthy();
    });

    it('through the routes: open, close and the Usage page’s Activity, and the words for who pays', async () => {
      const sara = await person('sara');
      const opened = await postReceipt(json('/x', 'POST', { userId: sara.uuid, taskKey: 'route-1', action: 'open', title: 'Welcome video', category: 'apps', boundMicros: 1_200_000 }), ctx(sara.brickId));
      expect(opened.status).toBe(201);
      expect(await opened.json()).toMatchObject({ link: expect.stringContaining('#usage=act_'), paidBy: { payer: 'you', label: 'Paid by you' }, created: true });
      expect((await postReceipt(json('/x', 'POST', { userId: sara.uuid, taskKey: 'route-1', action: 'open', title: 'Welcome video' }), ctx(sara.brickId))).status).toBe(200);
      expect((await postReceipt(json('/x', 'POST', { userId: sara.uuid, taskKey: 'route-1', action: 'open' }), ctx(sara.brickId))).status).toBe(400);
      expect((await postReceipt(json('/x', 'POST', { userId: sara.uuid, taskKey: 'route-1', action: 'close' }), ctx(sara.brickId))).status).toBe(400);
      expect(await (await postReceipt(json('/x', 'POST', { userId: sara.uuid, taskKey: 'route-1', action: 'close', state: 'done', chargedMicros: 920_000 }), ctx(sara.brickId))).json()).toMatchObject({ ok: true, state: 'done' });
      expect(await (await postReceipt(json('/x', 'POST', { userId: 'g', isGuest: true, taskKey: 'g', action: 'open', title: 'x' }), ctx(sara.brickId))).json()).toEqual({ ok: false, reason: 'not_allowed' });
      const usage = await memberUsage(sara.id);
      expect(usage.activity).toHaveLength(1);
      expect(usage.activity[0]).toMatchObject({ title: 'Welcome video', spentMicros: 920_000, payer: 'you' });
      // There is no "Didn’t work?" any more: nothing on an Activity item offers it
      expect(usage.activity[0]).not.toHaveProperty('canReport');
    });

    it('says who pays for a Brick to its owner ("you") and to anyone else (the owner, named)', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const forSara = await (await getPaidBy(new NextRequest(`http://localhost/x?userId=${sara.uuid}`), ctx(sara.brickId))).json();
      const forOmar = await (await getPaidBy(new NextRequest(`http://localhost/x?userId=${omar.uuid}`), ctx(sara.brickId))).json();
      const forGuest = await (await getPaidBy(new NextRequest('http://localhost/x?userId=g&isGuest=true'), ctx(sara.brickId))).json();
      expect(forSara).toEqual({ payer: 'you', payerName: null, label: 'Paid by you' });
      expect(forOmar).toEqual({ payer: 'sponsor', payerName: 'sara', label: 'Paid by sara' });
      expect(forGuest.label).toBe('Paid by sara');
      const room = await roomBot(sara.id);
      expect((await (await getPaidBy(new NextRequest(`http://localhost/x?userId=${omar.uuid}`), ctx(room))).json()).label).toBe('Paid by Universe');
    });
  });
});

async function createBrickFor(ownerId: string): Promise<string> {
  return (await createBrick({ ownerId, name: `Second Brick ${++made}` })).id;
}
