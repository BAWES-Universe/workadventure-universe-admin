/**
 * Rules said in chat, and one receipt per task, against a real database (paying spec 3, part O4; acceptance tests 7 and 12, rules part).
 * What only the database can show: a rule is made once, held where room is taken, counted from the books and from held room, and a
 * receipt reads only what was recorded. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/spend-rules-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { getSessionUser } from '@/lib/auth-session';
import { saveMeterSettings } from '@/lib/meter';
import { releaseRoom, renewRoom, reserveRoom } from '@/lib/meter-allowance';
import { memberUsage } from '@/lib/meter-usage';
import { changeRule, checkSpend, endRule, listRules, ownerSpendAllowed, proposeRule } from '@/lib/spend-rules';
import { activityFor, closeReceipt, openReceipt, reportProblem } from '@/lib/task-receipts';
import { POST as postRule, GET as getRules } from '@/app/api/bots/[id]/spend-rules/route';
import { POST as postReceipt } from '@/app/api/bots/[id]/task-receipts/route';
import { GET as getPaidBy } from '@/app/api/bots/[id]/paid-by/route';
import { POST as postJob } from '@/app/api/bots/[id]/computer-jobs/route';
import { POST as postDidntWork } from '@/app/api/me/usage/activity/[id]/didnt-work/route';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { giveComputer, renewJob, startJob } from '@/lib/computer';
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
  await prisma.creditHold.deleteMany({ where: { personId: { in: ids } } });
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

    it('a job that keeps running may not take more room than the rule allows, and a corrected rule lets it', async () => {
      const sara = await person('sara');
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'person', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const room = await reserveRoom({ key: `k-${tag}-4`, personId: sara.id, amountMicros: 60_000, botId: sara.brickId, jobId: 'j4' }, NOW);
      expect(room.ok).toBe(true);
      expect(await renewRoom({ key: `k-${tag}-4`, moreMicros: 60_000 }, NOW)).toMatchObject({ ok: false, reason: 'rule', leftMicros: 40_000 });
      // The room it holds is untouched: the job saves its work and stops safely
      expect((await prisma.meterReservation.findUnique({ where: { reservationKey: `k-${tag}-4` } }))?.amountMicros).toBe(BigInt(60_000));
      expect(await renewRoom({ key: `k-${tag}-4`, moreMicros: 40_000 }, NOW)).toMatchObject({ ok: true });
      await changeRule(made.rule.id, sara.id, { capMicros: 500_000 });
      expect(await renewRoom({ key: `k-${tag}-4`, moreMicros: 60_000 }, NOW)).toMatchObject({ ok: true });
      await releaseRoom({ key: `k-${tag}-4` }, NOW);
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
      // Nothing was held for it, and a call that fits is let through
      expect(await prisma.meterReservation.count({ where: { jobId: started.job.id, reservationKey: { contains: 'call' } } })).toBe(0);
      expect(await authorizeModelCall({ token: minted.token, callId: 'call-2', estimateMicros: 30_000, payer: 'universe' }, NOW)).toMatchObject({ ok: true, reservedMicros: 30_000 });
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

    it('a job that is running when a rule stops more room ends as "rule", saying so, not as "our room is used up"', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 100_000 });
      if (!made.ok) throw new Error('not made');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long job' }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      expect(started.job.status).toBe('running');
      // 60,000 is held; another stretch of 60,000 does not fit under 100,000
      const renewed = await renewJob(started.job.id, new Date(NOW.getTime() + 60_000));
      expect(renewed).toEqual({ ok: false, reason: 'rule', words: expect.stringContaining('No more than $0.10 a month') });
      const ended = await prisma.computerJob.findUnique({ where: { id: started.job.id } });
      expect(ended).toMatchObject({ status: 'stopped', endedBy: 'rule' });
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

    it('lists a finished task with what it used from the books, what it took, who paid and a "Didn’t work?"; a running task is not listed yet', async () => {
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
        canReport: true,
        lines: [
          { label: 'Instant Apps, 2 uses', amountMicros: 60_000 },
          { label: "sara's Brick's own thinking", note: 'Universe AI' },
        ],
      });
      expect(item.id).toMatch(/^act_/);
    });

    it('closing says what happened and then stays: done and refunded do not change, checking can still become either', async () => {
      const sara = await person('sara');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'vid', title: 'Welcome video', category: 'apps' }, NOW);
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'checking' }, NOW)).toMatchObject({ ok: true, state: 'checking' });
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'checking', canReport: false });
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'refunded', chargedMicros: 920_000 }, NOW)).toMatchObject({ ok: true, state: 'refunded' });
      // A refund took nothing, whatever figure came with it
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'vid', personId: sara.id, state: 'done', chargedMicros: 5 }, NOW)).toMatchObject({ ok: true, state: 'refunded' });
      expect(await closeReceipt({ botId: sara.brickId, taskKey: 'nope', personId: sara.id, state: 'done' }, NOW)).toEqual({ ok: false, reason: 'not_found' });
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

    it('"Didn’t work?" is kept once, only for the person it is theirs, and answers that it was sent', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await openReceipt({ botId: sara.brickId, personId: sara.id, taskKey: 'v2', title: 'Welcome video', category: 'apps' }, NOW);
      await closeReceipt({ botId: sara.brickId, taskKey: 'v2', personId: sara.id, state: 'done', chargedMicros: 100 }, NOW);
      const [item] = await activityFor(sara.id);
      expect(await reportProblem(omar.id, item.id)).toEqual({ ok: false, reason: 'not_found' });
      expect(await reportProblem(sara.id, item.id)).toEqual({ ok: true, outcome: 'sent' });
      expect(await reportProblem(sara.id, item.id)).toEqual({ ok: true, outcome: 'sent' });
      expect((await activityFor(sara.id))[0].canReport).toBe(false);
      expect(await reportProblem(sara.id, 'act_nothing')).toEqual({ ok: false, reason: 'not_found' });
      expect(await reportProblem(sara.id, 'garbage')).toEqual({ ok: false, reason: 'not_found' });
      // A computer's job is reported the same way: a receipt is made for it so the report has somewhere to be kept
      const job = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Weekly sales report', status: 'done', endedAt: NOW } });
      expect(await reportProblem(sara.id, `act_job_${job.id}`)).toEqual({ ok: true, outcome: 'sent' });
      expect(await reportProblem(omar.id, `act_job_${job.id}`)).toEqual({ ok: false, reason: 'not_found' });
      expect((await activityFor(sara.id)).filter((one) => one.title === 'Weekly sales report')).toHaveLength(1);
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
      expect(usage.activity[0]).toMatchObject({ title: 'Welcome video', spentMicros: 920_000, payer: 'you', canReport: true });
      (getSessionUser as jest.Mock).mockResolvedValue({ id: sara.id });
      const reported = await postDidntWork(json('/x', 'POST'), ctx(usage.activity[0].id));
      expect(await reported.json()).toEqual({ outcome: 'sent' });
      expect((await postDidntWork(json('/x', 'POST'), ctx('act_missing'))).status).toBe(404);
      (getSessionUser as jest.Mock).mockResolvedValue(null);
      expect((await postDidntWork(json('/x', 'POST'), ctx(usage.activity[0].id))).status).toBe(401);
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
