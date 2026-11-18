/**
 * The money rules of a computer's model steps (brief B: R1, R2, R4, R7, R9, R10, D2, D3, the check before a paid wake, storage booked once),
 * against a real database and the PRETEND provider (a pretend minute costs 6,000 millionths, so a 10 minute stretch is 60,000). Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest -i __tests__/api/computer-money-rules-db.test.ts
 *
 * A step used in these tests: 1,000 input tokens that cost 10,000, output at $15 a million (15,000,000 millionths), an answer limit of 28,000
 * tokens. The most the provider can bill is 10,000 + 420,000 = 430,000 ($0.43); with no history the member's estimate is 4,096 answer tokens,
 * 10,000 + 61,440 = 71,440.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { recordMeterEvent } from '@/lib/meter';
import { finishJob, giveComputer, renewJob, startJob, sweepComputers } from '@/lib/computer';
import { authorizeModelCall, authorizeStep, getComputerLimits, saveComputerLimits, settleModelCall, settleStep, type StepAsk } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { computerCreditFor } from '@/lib/computer-credit';
import { createGiftFor } from '@/lib/grants-admin';
import { proposeRule } from '@/lib/spend-rules';
import { currentEnvelope, reserveDiskRoom } from '@/lib/meter-allowance';
import { POST as authorizeRoute } from '@/app/api/computer/llm/authorize/route';
import { POST as settleRoute } from '@/app/api/computer/llm/settle/route';
import { POST as startRoute } from '@/app/api/bots/[id]/computer-jobs/route';
import { POST as jobActionRoute } from '@/app/api/bots/[id]/computer-jobs/[jobId]/route';
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
const RATE = 6_000;
const MEMBER_ESTIMATE = 71_440;
const PROVIDER_MAX = 430_000;

async function person(name: string, computer = true) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  if (computer) await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id };
}

/** A person with a job running on the pretend machine, and the key its computer holds. */
async function running(name = 'sara', title = 'Job', runId?: string) {
  const sara = await person(name);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title, ...(runId ? { runId } : {}) }, NOW);
  if (!started.ok) throw new Error(`the job did not start: ${started.reason}`);
  const minted = await mintJobToken(started.job.id, 'model', NOW);
  if (!minted.ok) throw new Error('no key');
  return { sara, jobId: started.job.id, token: minted.token };
}

const ask = (token: string, operationId: string, over: Partial<StepAsk> = {}): StepAsk => ({
  token,
  operationId,
  payer: 'universe',
  route: 'universe-ai',
  model: 'model-a',
  stepKind: 'reply',
  inputTokens: 1_000,
  inputMicros: 10_000,
  outputMicrosPerMillion: 15_000_000,
  maxOutputTokens: 28_000,
  ...over,
});

const wipe = async () => {
  await prisma.computerEffect.deleteMany({ where: { job: { personId: { in: people } } } });
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.brickItemRun.deleteMany({ where: { item: { ownerId: { in: people } } } });
  await prisma.brickItem.deleteMany({ where: { ownerId: { in: people } } });
  await prisma.computerCallAuthorisation.deleteMany({});
  await prisma.computerModelSeen.deleteMany({});
  await prisma.spendRule.deleteMany({ where: { ownerPersonId: { in: people } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: ['computer-limits'] } } });
  await wipeComputerCredit();
};

const credit = (id: string, at: Date = NOW) => computerCreditFor(id, at);
const post = (route: (request: NextRequest, context?: never) => Promise<Response>, body: unknown) =>
  route(new NextRequest('http://localhost/api/computer/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

run('the money rules of a computer’s model steps, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.updateMany({ where: { bot: { ownerId: { in: people } } }, data: {} });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await setUpComputerCredit({}, NOW);
  });
  afterAll(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('R1, D1, D2: two amounts and the funding record', () => {
    it('the $0.43 step on a member with $0.25 and pool room: the member holds the estimate, the pool holds the most, and the rest of a bigger bill is taken only from what is free', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      const answer = await authorizeStep(ask(token, 'op-1'), NOW);
      expect(answer).toMatchObject({ ok: true, contract: 2, operationId: 'op-1', jobId, memberMicros: MEMBER_ESTIMATE, providerMaxMicros: PROVIDER_MAX });
      // The member's credit holds the job's stretch and the estimate; the pool holds the job's stretch and the provider's most
      expect(await credit(sara.id)).toMatchObject({ inProgressMicros: STRETCH + MEMBER_ESTIMATE, availableMicros: 250_000 - STRETCH - MEMBER_ESTIMATE });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(STRETCH + PROVIDER_MAX);
      // The step cost $0.20: the member is charged the estimate and, beyond it, only what their credit still has free (118,560); the provider bill is kept apart
      const settled = await settleStep({ jobId, operationId: 'op-1', costMicros: 200_000, providerCostMicros: 200_000, basis: 'measured', tokens: { output: 12_000 } }, NOW);
      expect(settled).toEqual({ ok: true, state: 'settled', chargedMicros: 190_000, providerCostMicros: 200_000 });
      expect((await credit(sara.id)).availableMicros).toBe(0);
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:op-1` } })).toMatchObject({ state: 'settled', customerMicros: BigInt(MEMBER_ESTIMATE), providerCostMicros: BigInt(200_000) });
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:op-1:x` } })).toMatchObject({ state: 'settled', customerMicros: BigInt(118_560) });
      // The pool's room for the step is closed in the same step as its cost is booked: nothing is held, and the cost is counted once
      const envelope = await currentEnvelope(NOW);
      expect(envelope.reservedMicros).toBe(STRETCH);
      expect(envelope.committedMicros + envelope.unsettledMicros).toBe(200_000);
      // The funding authorisation was recorded before the step was sent, and then the figures it took
      expect(await prisma.computerCallAuthorisation.findUniqueOrThrow({ where: { callKey: `computer:call:${jobId}:op-1` } })).toMatchObject({
        payerKind: 'owner',
        contract: 2,
        state: 'settled',
        memberMicros: BigInt(MEMBER_ESTIMATE),
        providerMaxMicros: BigInt(PROVIDER_MAX),
        chargedMicros: BigInt(190_000),
        providerCostMicros: BigInt(200_000),
        outputTokens: 12_000,
      });
    });

    it('the same step on a pool without room: refused before anything is spent, as the budget, with the job saved and paused', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000, poolCeilingMicros: 400_000 }, NOW);
      const { sara, jobId, token } = await running();
      const answer = await authorizeStep(ask(token, 'op-1'), NOW);
      expect(answer).toEqual({ ok: false, contract: 2, operationId: 'op-1', reason: 'budget', paused: true, words: null, canAskForMore: false });
      expect(await prisma.computerCallAuthorisation.count()).toBe(0);
      expect(await prisma.creditHold.count({ where: { jobKey: jobId, chargeClass: 'computer_model' } })).toBe(0);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'queued', queuedFor: 'pool', pausedFor: 'budget', endedBy: null });
      expect((await credit(sara.id)).inProgressMicros).toBe(0);
    });

    it('a pool that is only full of what is held right now says "holds" with a wait time, and the job is not paused', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000, poolCeilingMicros: 480_000 }, NOW);
      const { jobId, token } = await running();
      const answer = await authorizeStep(ask(token, 'op-1'), NOW);
      expect(answer).toMatchObject({ ok: false, reason: 'holds', retryAfterSeconds: 20, paused: false });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
    });

    it('a person with no credit left is told "allowance" with "Ask for more", and the job is saved and paused', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 10_000 }, NOW);
      const { jobId, token } = await running();
      expect(await authorizeStep(ask(token, 'op-1'), NOW)).toMatchObject({ ok: false, reason: 'allowance', canAskForMore: true, paused: true });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'queued', pausedFor: 'allowance' });
    });

    it('asked again with the same operation id it is the same answer and nothing more is held, however the history changed between', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      const first = await authorizeStep(ask(token, 'op-1'), NOW);
      const again = await Promise.all([authorizeStep(ask(token, 'op-1'), NOW), authorizeStep(ask(token, 'op-1'), NOW)]);
      expect(again.every((answer) => answer.ok && answer.memberMicros === MEMBER_ESTIMATE)).toBe(true);
      expect(again[0]).toEqual(first);
      expect(await prisma.creditHold.count({ where: { jobKey: jobId, chargeClass: 'computer_model' } })).toBe(1);
      expect(await prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: 'computer:call:' } } })).toBe(1);
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH + MEMBER_ESTIMATE);
    });

    it('the estimate is twice the median answer of the last settled steps once five have settled, never above the answer limit the call really has', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 5_000_000 }, NOW);
      const { jobId, token } = await running();
      for (let step = 0; step < 5; step++) {
        expect(await authorizeStep(ask(token, `h-${step}`), NOW)).toMatchObject({ ok: true });
        await settleStep({ jobId, operationId: `h-${step}`, costMicros: 20_000, providerCostMicros: 20_000, basis: 'measured', tokens: { output: 1_000 } }, NOW);
      }
      // Twice the median (1,000) is 2,000 answer tokens: 10,000 + 30,000
      expect(await authorizeStep(ask(token, 'h-5'), NOW)).toMatchObject({ ok: true, memberMicros: 40_000, providerMaxMicros: PROVIDER_MAX });
      // A call really allowed only 1,500 answer tokens is estimated at 1,500, whatever the history says
      expect(await authorizeStep(ask(token, 'h-6', { maxOutputTokens: 1_500 }), NOW)).toMatchObject({ ok: true, memberMicros: 10_000 + 22_500, providerMaxMicros: 10_000 + 22_500 });
      // A different model is another group, which has no history yet: it starts at 4,096
      expect(await authorizeStep(ask(token, 'h-7', { model: 'model-b' }), NOW)).toMatchObject({ ok: true, memberMicros: MEMBER_ESTIMATE });
    });

    it('a step that costs more than the provider maximum the game said is still booked whole, and the larger of two readings is held', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 5_000_000 }, NOW);
      const { token } = await running();
      // The game's own reading is smaller than the recomputed one: it is never trusted. A larger one is kept.
      expect(await authorizeStep(ask(token, 'a', { providerMaxMicros: 1 }), NOW)).toMatchObject({ ok: true, providerMaxMicros: PROVIDER_MAX });
      expect(await authorizeStep(ask(token, 'b', { providerMaxMicros: 900_000 }), NOW)).toMatchObject({ ok: true, providerMaxMicros: 900_000 });
    });

    it('calls at once for one job are limited from the Limits, read on every call, and waiting helps', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 5_000_000 }, NOW);
      const { jobId, token } = await running();
      await saveComputerLimits({ maxCallsInFlight: 2 }, 'admin');
      expect(await authorizeStep(ask(token, 'one'), NOW)).toMatchObject({ ok: true, limits: { maxOutputTokens: 32_768, maxCallsInFlight: 2, maxWaitSeconds: 600 } });
      expect(await authorizeStep(ask(token, 'two'), NOW)).toMatchObject({ ok: true });
      expect(await authorizeStep(ask(token, 'three'), NOW)).toMatchObject({ ok: false, reason: 'holds', retryAfterSeconds: 20, paused: false });
      // One finishes: the same operation id asked again after the wait is let through
      await settleStep({ jobId, operationId: 'one', costMicros: 1_000, providerCostMicros: 1_000, basis: 'measured' }, NOW);
      expect(await authorizeStep(ask(token, 'three'), NOW)).toMatchObject({ ok: true });
      // A changed Limit is in effect at once
      await saveComputerLimits({ maxCallsInFlight: 1, maxWaitSeconds: 30 }, 'admin');
      expect(await getComputerLimits()).toEqual({ maxOutputTokens: 32_768, maxCallsInFlight: 1, maxWaitSeconds: 30 });
      expect(await authorizeStep(ask(token, 'four'), NOW)).toMatchObject({ ok: false, reason: 'holds' });
    });

    it('a rule the person said stops a step that would pass it, with the rule’s own words, and a cap on the Brick is recorded with the step', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 5_000_000 }, NOW);
      const { sara, token, jobId } = await running();
      // 150,000 for the Brick: the job's stretch (60,000) and a step of 71,440 fit; a second step does not
      const made = await proposeRule({ botId: sara.brickId, speakerId: sara.id, scope: 'bot', period: 'month', capMicros: 150_000 });
      if (!made.ok) throw new Error('not made');
      const first = await authorizeStep(ask(token, 'op-1'), NOW);
      expect(first).toMatchObject({ ok: true, authorisation: { payer: 'owner', limits: { botMicros: 150_000, taskMicros: null, grantId: null, fixedPriceMicros: null } } });
      const second = await authorizeStep(ask(token, 'op-2'), NOW);
      expect(second).toMatchObject({ ok: false, reason: 'rule', paused: false, words: expect.stringContaining('$0.15') });
      // Nothing for the refused step was held, and the first is untouched
      expect(await prisma.creditHold.count({ where: { jobKey: jobId, chargeClass: 'computer_model', state: 'held' } })).toBe(1);
    });

    it('a run of a schedule is recorded as the schedule’s, bounded by the limits recorded for it, and a gift that ends is recorded with the day it ends', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: null }, NOW);
      const sara = await person('sara', false);
      await giveComputer(sara.brickId, sara.id);
      const gifted = await createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [sara.id] }, scope: 'computers', amountMicros: 400_000, shared: false, endsAt: days(20).toISOString(), settlement: 'gift' } as Parameters<typeof createGiftFor>[0], root, NOW);
      expect(gifted).toBeTruthy();
      const item = await prisma.brickItem.create({ data: { ownerId: sara.id, botId: sara.brickId, kind: 'schedule', words: 'Check the page every day', cadence: {}, timeZone: 'UTC' } });
      const itemRun = await prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: NOW, revision: 1, leaseUntil: days(1) } });
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Scheduled', runId: itemRun.id }, NOW);
      if (!started.ok) throw new Error(`not started: ${started.reason}`);
      const minted = await mintJobToken(started.job.id, 'model', NOW);
      if (!minted.ok) throw new Error('no key');
      const answer = await authorizeStep(ask(minted.token, 'op-1'), NOW);
      expect(answer).toMatchObject({ ok: true, authorisation: { payer: 'schedule', limits: { periodEnds: days(20).toISOString(), grantId: expect.any(String) } } });
      expect(answer.ok && answer.authorisation?.fundingAccountId).toBeTruthy();
      expect(answer.ok && answer.authorisation?.tariffVersion).toMatch(/^t-[0-9a-f]{16}$/);
    });
  });

  describe('contract versions: v1 bodies, v2 bodies and the pairings', () => {
    // The routes read the clock themselves: only the date is pretended, so the key made at NOW is alive
    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('a version 1 body is answered in the version 1 shapes only, holds one amount, and never records the version 2 authorisation', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      const response = await post(authorizeRoute, { token, callId: 'v1-call', estimateMicros: 100_000, payer: 'universe' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, jobId, botId: sara.brickId, personId: sara.id, reservedMicros: 100_000 });
      expect(body).not.toHaveProperty('contract');
      expect(await prisma.computerCallAuthorisation.count()).toBe(0);
      // One amount for the member and for the pool, as today
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:v1-call` } })).toMatchObject({ amountMicros: BigInt(100_000) });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(STRETCH + 100_000);
      const settled = await post(settleRoute, { jobId, callId: 'v1-call', costMicros: 30_000, basis: 'measured', route: 'universe-ai' });
      expect(await settled.json()).toEqual({ ok: true });
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:v1-call` } })).toMatchObject({ state: 'settled', customerMicros: BigInt(30_000) });
    });

    it('a version 1 refusal is one of refused, allowance, pool and rule, with no contract field', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 1_000, poolCeilingMicros: 100_000_000 }, NOW);
      const { token } = await running();
      const refused = await (await post(authorizeRoute, { token, callId: 'big', estimateMicros: 500_000, payer: 'universe' })).json();
      expect(refused).toEqual({ ok: false, reason: 'allowance' });
      expect(await (await post(authorizeRoute, { token: 'nope', callId: 'x', estimateMicros: 1, payer: 'universe' })).json()).toEqual({ ok: false, reason: 'refused' });
    });

    it('a version 2 body is answered with the contract, both amounts, the record and the Limits; unknown names are refused with 400 in both versions', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { token } = await running();
      const body = {
        contract: 2,
        token,
        operationId: 'v2-op',
        payer: 'universe',
        route: 'universe-ai',
        model: 'model-a',
        modelFormat: 'openai',
        stepKind: 'reply',
        inputTokens: 1_000,
        inputMicros: 10_000,
        outputMicrosPerMillion: 15_000_000,
        maxOutputTokens: 28_000,
        providerMaxMicros: 430_000,
      };
      const response = await post(authorizeRoute, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, contract: 2, operationId: 'v2-op', memberMicros: MEMBER_ESTIMATE, providerMaxMicros: PROVIDER_MAX, limits: { maxOutputTokens: 32_768, maxCallsInFlight: 8, maxWaitSeconds: 600 }, authorisation: { payer: 'owner', limits: expect.any(Object) } });
      // The old route's answer to a body it does not know is the same 400 a newer game falls back from
      expect((await post(authorizeRoute, { ...body, surprise: 1 })).status).toBe(400);
      expect((await post(authorizeRoute, { token, callId: 'c', estimateMicros: 1, payer: 'universe', contract: 3 })).status).toBe(400);
      expect((await post(authorizeRoute, { token, callId: 'c', estimateMicros: 1, payer: 'universe', surprise: 1 })).status).toBe(400);
      expect((await post(settleRoute, { contract: 2, jobId: 'x', operationId: 'y', surprise: 1 })).status).toBe(400);
    });

    it('a version 2 settle answers state, what the person was charged and what the provider billed, and an unknown call is 404', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { jobId, token } = await running();
      await authorizeStep(ask(token, 'op-1'), NOW);
      const settled = await post(settleRoute, { contract: 2, jobId, operationId: 'op-1', costMicros: 5_000, providerCostMicros: 4_000, basis: 'measured', route: 'universe-ai', tokens: { input: 1_000, output: 300, cached: null, reasoning: null, cacheWrite: null, cacheWrite1h: null } });
      expect(settled.status).toBe(200);
      expect(await settled.json()).toEqual({ ok: true, contract: 2, operationId: 'op-1', state: 'settled', chargedMicros: 5_000, providerCostMicros: 4_000 });
      expect(await (await post(settleRoute, { contract: 2, jobId, operationId: 'op-1', costMicros: 9_999, providerCostMicros: 9_999, basis: 'measured' })).json()).toEqual({ ok: true, contract: 2, operationId: 'op-1', state: 'replay', chargedMicros: 5_000, providerCostMicros: 4_000 });
      const unknown = await post(settleRoute, { contract: 2, jobId, operationId: 'never-asked', costMicros: 1, providerCostMicros: 1 });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ ok: false, reason: 'unknown_call' });
      // Nothing went out: the room is given back and nothing is written
      await authorizeStep(ask(token, 'op-2'), NOW);
      expect(await (await post(settleRoute, { contract: 2, jobId, operationId: 'op-2', sent: false })).json()).toEqual({ ok: true, contract: 2 });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:op-2` } })).toBe(0);
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(STRETCH);
    });

    it('a call on the owner’s own key takes no room, no credit and records no authorisation', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      const answer = await authorizeStep(ask(token, 'own', { payer: 'own-key', route: 'own-key', inputMicros: null, outputMicrosPerMillion: null }), NOW);
      expect(answer).toMatchObject({ ok: true, contract: 2, memberMicros: 0, providerMaxMicros: 0, authorisation: null });
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH);
      expect(await prisma.computerCallAuthorisation.count({ where: { jobId } })).toBe(0);
    });
  });

  describe('R10, N1: the model with no price, and the check before a paid wake', () => {
    it('a Universe-paid step with no price is refused "unpriced" and nothing is held; the model is noted for readiness, and a price clears it', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, token } = await running();
      const answer = await authorizeStep(ask(token, 'op-1', { model: 'mystery', inputMicros: null, outputMicrosPerMillion: null }), NOW);
      expect(answer).toMatchObject({ ok: false, reason: 'unpriced', paused: false });
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH);
      expect(await prisma.computerModelSeen.findFirstOrThrow({ where: { model: 'mystery' } })).toMatchObject({ route: 'universe-ai', priced: false });
      expect(await authorizeStep(ask(token, 'op-2', { model: 'mystery' }), NOW)).toMatchObject({ ok: true });
      expect(await prisma.computerModelSeen.findFirstOrThrow({ where: { model: 'mystery' } })).toMatchObject({ priced: true });
    });

    it('a route a computer cannot run on is refused before a job is written, a room is held or a machine is made or woken', async () => {
      const sara = await person('sara', false);
      await giveComputer(sara.brickId, sara.id);
      const calls = provider.calls?.length ?? 0;
      const refused = await startJob({ botId: sara.brickId, personId: sara.id, title: 'On a Claude key', modelFormat: 'other' }, NOW);
      expect(refused).toEqual({ ok: false, reason: 'unsupported' });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      expect(await prisma.meterReservation.count({ where: { personId: sara.id } })).toBe(0);
      expect(provider.calls?.length ?? 0).toBe(calls);
      // Through the route too, and a route in OpenAI's format (or none said: what every route was) goes on as before
      const through = await startRoute(new NextRequest('http://localhost/api/bots/x/computer-jobs', { method: 'POST', body: JSON.stringify({ userId: sara.id, title: 'x', modelFormat: 'other' }) }), { params: Promise.resolve({ id: sara.brickId }) });
      expect(through.status).toBeLessThan(500);
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'On OpenAI', modelFormat: 'openai' }, NOW)).toMatchObject({ ok: true });
    });

    it('a step on a format a computer cannot run is "unsupported", before anything is held', async () => {
      const { token, sara } = await running();
      expect(await authorizeStep(ask(token, 'op-1', { modelFormat: 'other' }), NOW)).toMatchObject({ ok: false, reason: 'unsupported' });
      expect(await authorizeStep(ask(token, 'op-2', { modelFormat: 'gemini-compatible' }), NOW)).toMatchObject({ ok: true });
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH + MEMBER_ESTIMATE);
    });
  });

  describe('R4, R7: unknown stays in the pool, zero stays zero, a late receipt corrects once', () => {
    it('a measured zero stays zero: nothing is charged, and it is not charged a millionth', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      await authorizeStep(ask(token, 'free'), NOW);
      expect(await settleStep({ jobId, operationId: 'free', costMicros: 0, providerCostMicros: 0, basis: 'measured' }, NOW)).toEqual({ ok: true, state: 'settled', chargedMicros: 0, providerCostMicros: 0 });
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:free` } })).toMatchObject({ state: 'settled', customerMicros: BigInt(0) });
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:free` } })).costMicros).toBe(BigInt(0));
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH);
    });

    it('unknown stays unknown and in the pool at what was held (60,000), and a late receipt of 67,000 replaces it exactly once', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      // An answer limit of 60,000 tokens at $1 a million, and no input cost: the most the provider can bill is 60,000
      await authorizeStep(ask(token, 'late', { inputMicros: 0, outputMicrosPerMillion: 1_000_000, maxOutputTokens: 60_000 }), NOW);
      const before = await currentEnvelope(NOW);
      expect(before.reservedMicros).toBe(STRETCH + 60_000);
      const unknown = await settleStep({ jobId, operationId: 'late', costMicros: null, providerCostMicros: null, basis: 'unknown' }, NOW);
      // The person is charged no more than what was set aside for them (4,096 tokens at $1 a million)
      expect(unknown).toEqual({ ok: true, state: 'settled', chargedMicros: 4_096, providerCostMicros: null });
      const during = await currentEnvelope(NOW);
      expect(during.unknownHeldMicros).toBe(60_000);
      expect(during.unknownEvents).toBe(1);
      expect(during.totalMicros).toBe(before.totalMicros);
      // The late receipt: 67,000. The pool stops counting the held 60,000 and counts 67,000, once
      const late = await settleStep({ jobId, operationId: 'late', costMicros: 4_096, providerCostMicros: 67_000, basis: 'measured' }, NOW);
      expect(late).toMatchObject({ ok: true, state: 'corrected', providerCostMicros: 67_000 });
      const after = await currentEnvelope(NOW);
      expect(after.unknownHeldMicros).toBe(0);
      expect(after.unknownEvents).toBe(0);
      expect(after.totalMicros).toBe(before.totalMicros + 7_000);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late` } })).costMicros).toBe(BigInt(67_000));
      // Any other word after it returns what was recorded: a second late receipt, or a plain repeat, changes nothing
      expect(await settleStep({ jobId, operationId: 'late', costMicros: 1, providerCostMicros: 1, basis: 'measured' }, NOW)).toMatchObject({ ok: true, state: 'replay', providerCostMicros: 67_000 });
      expect((await currentEnvelope(NOW)).totalMicros).toBe(after.totalMicros);
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH);
    });

    it('a late receipt that is lower than what an unknown step charged gives the difference back into the lots it came from, once', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      await authorizeStep(ask(token, 'late'), NOW);
      await settleStep({ jobId, operationId: 'late', costMicros: null, providerCostMicros: null, basis: 'unknown' }, NOW);
      expect((await credit(sara.id)).availableMicros).toBe(250_000 - STRETCH - MEMBER_ESTIMATE);
      const late = await settleStep({ jobId, operationId: 'late', costMicros: 20_000, providerCostMicros: 20_000, basis: 'measured' }, NOW);
      expect(late).toEqual({ ok: true, state: 'corrected', chargedMicros: 20_000, providerCostMicros: 20_000 });
      expect((await credit(sara.id)).availableMicros).toBe(250_000 - STRETCH - 20_000);
      expect(await prisma.creditRefund.count({ where: { reason: 'correction' } })).toBe(1);
      await settleStep({ jobId, operationId: 'late', costMicros: 20_000, providerCostMicros: 20_000, basis: 'measured' }, NOW);
      expect(await prisma.creditRefund.count({ where: { reason: 'correction' } })).toBe(1);
    });

    it('a step the sweep settled as unknown (it never reported) is corrected once by a late receipt after the sweep', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { sara, jobId, token } = await running();
      await authorizeStep(ask(token, 'lost'), NOW);
      // The job keeps going (its room is renewed), the step never reports; the sweep finds the room lapsed
      expect(await renewJob(jobId, minutes(9))).toMatchObject({ ok: true });
      await sweepComputers(minutes(11));
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:lost` } });
      expect(event.costMicros).toBeNull();
      expect(event.detail).toMatchObject({ heldMicros: PROVIDER_MAX });
      expect((await currentEnvelope(minutes(11))).unknownHeldMicros).toBe(PROVIDER_MAX);
      expect(await prisma.meterReservation.count({ where: { jobId: null, state: 'held', reservationKey: { startsWith: 'computer:call:pool:' } } })).toBe(0);
      const late = await settleStep({ jobId, operationId: 'lost', costMicros: 30_000, providerCostMicros: 30_000, basis: 'measured' }, minutes(12));
      expect(late).toMatchObject({ ok: true, state: 'corrected', providerCostMicros: 30_000 });
      expect((await currentEnvelope(minutes(12))).unknownHeldMicros).toBe(0);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:lost` } })).costMicros).toBe(BigInt(30_000));
      expect((await credit(sara.id, minutes(12))).inProgressMicros).toBeLessThanOrEqual(2 * STRETCH);
    });

    it('a version 1 step that settled with no price also keeps counting at what was held, until a receipt settles it', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { jobId, token } = await running();
      await authorizeModelCall({ token, callId: 'v1', estimateMicros: 90_000, payer: 'universe' }, NOW);
      await settleModelCall(jobId, 'v1', { costMicros: null, basis: 'unknown', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect((await currentEnvelope(NOW)).unknownHeldMicros).toBe(90_000);
      await settleModelCall(jobId, 'v1', { costMicros: 70_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      const after = await currentEnvelope(NOW);
      expect(after.unknownHeldMicros).toBe(0);
      expect(after.committedMicros + after.unsettledMicros).toBe(70_000);
    });

    it('a 60,000 reservation that was lost counts across the month until it is settled or released', async () => {
      await setUpComputerCredit({}, NOW);
      const { jobId } = await running();
      await prisma.meterReservation.create({ data: { reservationKey: `lost-${tag}`, personKey: 'system:pool', personId: null, amountMicros: BigInt(60_000), state: 'held', expiresAt: minutes(-60), createdAt: new Date('2026-10-30T12:00:00Z'), jobId: null } });
      const december = new Date('2026-12-03T12:00:00Z');
      expect((await currentEnvelope(december)).unsettledMicros).toBeGreaterThanOrEqual(60_000);
      expect(jobId).toBeTruthy();
    });

    it('D3: a Gemini compatible step whose usage fields do not explain the bill keeps one defensible liability in place of the gross reservation, never both', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 250_000 }, NOW);
      const { jobId, token } = await running();
      await authorizeStep(ask(token, 'gem', { modelFormat: 'gemini-compatible' }), NOW);
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(STRETCH + PROVIDER_MAX);
      await settleStep({ jobId, operationId: 'gem', costMicros: 20_000, providerCostMicros: 25_000, basis: 'estimated', unexplained: { tokens: 700, costMicros: 5_000 } }, NOW);
      const envelope = await currentEnvelope(NOW);
      // The gross 430,000 is gone; the bill (25,000) and the unexplained liability (5,000) are what the pool counts, as separate lines
      expect(envelope.reservedMicros).toBe(STRETCH);
      expect(envelope.committedMicros + envelope.unsettledMicros).toBe(30_000);
      const liability = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:gem:unexplained` } });
      expect(liability).toMatchObject({ costMicros: BigInt(5_000), personKey: 'unknown', basis: 'estimated' });
      // The unexplained part is never charged to the person as measured use
      expect(await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: `computer:call:${jobId}:gem` } })).toMatchObject({ customerMicros: BigInt(20_000) });
    });
  });

  describe('R9: renewals count once', () => {
    it('a job of five hours never says the month ran out: each renewal holds the time used plus one stretch, for the member and the pool', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 2_000_000 }, NOW);
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Five hours' }, NOW);
      if (!started.ok) throw new Error('not started');
      // The runner asks every four minutes (0.4 of the ten minute stretch): 75 renewals in five hours
      for (let step = 1; step <= 75; step++) {
        const renewed = await renewJob(started.job.id, minutes(4 * step));
        expect(renewed).toMatchObject({ ok: true });
      }
      const at = minutes(300);
      const job = await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } });
      expect(job).toMatchObject({ status: 'running', pausedAt: null, endedBy: null });
      // Five hours at 6,000 a minute is 1,800,000: the room holds that and one stretch more, and the credit holds the same
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: job.reservationKey as string } });
      expect(Number(room.amountMicros)).toBe(300 * RATE + STRETCH);
      expect((await credit(sara.id, at)).inProgressMicros).toBe(300 * RATE + STRETCH);
      expect((await currentEnvelope(at)).reservedMicros).toBe(300 * RATE + STRETCH);
      // It finishes: the person is charged what ran (1,800,000), no more, and the room goes back
      await finishJob(started.job.id, 'done', at);
      expect((await credit(sara.id, at)).availableMicros).toBe(2_000_000 - 300 * RATE);
      expect((await currentEnvelope(at)).reservedMicros).toBe(0);
    });

    it('a renewal that arrives before the next stretch is needed holds nothing more', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: 2_000_000 }, NOW);
      const sara = await person('sara');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Quick renewals' }, NOW);
      if (!started.ok) throw new Error('not started');
      expect(await renewJob(started.job.id, minutes(0))).toMatchObject({ ok: true });
      const room = async () => Number((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: (await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).reservationKey as string } })).amountMicros);
      expect(await room()).toBe(STRETCH);
      expect((await credit(sara.id)).inProgressMicros).toBe(STRETCH);
      expect(await renewJob(started.job.id, minutes(2))).toMatchObject({ ok: true });
      expect(await room()).toBe(2 * RATE + STRETCH);
    });
  });

  describe('R2: pause and resume', () => {
    it('a job that is out is saved and paused, a grant lets it start again, once, and it never starts twice', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 10_000 }, NOW);
      const { sara, jobId, token } = await running();
      expect(await authorizeStep(ask(token, 'op-1'), NOW)).toMatchObject({ ok: false, reason: 'allowance', paused: true });
      const paused = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(paused).toMatchObject({ status: 'queued', queuedFor: 'allowance', pausedFor: 'allowance', resumeCount: 0, reservationKey: null, endedBy: null });
      // The machine sleeps, the key ended with the pause, and a step asked with it is told "paused" (not "refused": the game must not end the job)
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      expect(await authorizeStep(ask(token, 'op-2'), minutes(1))).toMatchObject({ ok: false, reason: 'paused', paused: true });
      // What it ran is in the books as this segment's time, and nothing stays held
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:time:p0` } })).toBe(1);
      expect(await prisma.creditHold.count({ where: { jobKey: jobId, state: 'held' } })).toBe(0);
      // Nothing changed: the sweep leaves it waiting, and does not resume it
      await sweepComputers(minutes(2));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'queued', resumeCount: 0 });
      // A gift makes room: the sweep starts it again, once
      await createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [sara.id] }, scope: 'computers', amountMicros: 500_000, shared: false, endsAt: days(20).toISOString(), settlement: 'gift' } as Parameters<typeof createGiftFor>[0], root, NOW);
      await sweepComputers(minutes(3));
      const resumed = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(resumed).toMatchObject({ status: 'running', queuedFor: null, pausedAt: null, pausedFor: null, resumeCount: 1 });
      await sweepComputers(minutes(4));
      await sweepComputers(minutes(5));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'running', resumeCount: 1 });
      expect(await prisma.meterReservation.count({ where: { jobId, state: 'held', reservationKey: { startsWith: 'computer:job:' } } })).toBe(1);
      // The game starts a new turn with a new operation id and a new key
      const minted = await mintJobToken(jobId, 'model', minutes(5));
      if (!minted.ok) throw new Error('no key');
      expect(await authorizeStep(ask(minted.token, 'op-3'), minutes(5))).toMatchObject({ ok: true });
      // The job's own end writes only the time since it started again
      await finishJob(jobId, 'done', minutes(8));
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:time` } })).toBe(1);
      const total = await prisma.meterEvent.aggregate({ where: { jobId, kind: 'computer_time' }, _sum: { quantity: true } });
      expect(Number(total._sum.quantity)).toBe(8 * 60 - 3 * 60 + 0);
    });

    it('a job that already did something outside the computer in the step it was in is not started again: it ends, as one out of credit ended before', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 10_000 }, NOW);
      const { sara, jobId, token } = await running();
      expect(await authorizeStep(ask(token, 'op-1'), NOW)).toMatchObject({ ok: false, reason: 'allowance', paused: true });
      await prisma.computerEffect.create({ data: { jobId, effectKey: 'send:1', kind: 'send', state: 'done', createdAt: minutes(1) } });
      await createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [sara.id] }, scope: 'computers', amountMicros: 500_000, shared: false, endsAt: days(20).toISOString(), settlement: 'gift' } as Parameters<typeof createGiftFor>[0], root, NOW);
      await sweepComputers(minutes(3));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'allowance', resumeCount: 0 });
    });

    it('a job the person stopped while it was paused stays stopped and is never resumed', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 10_000 }, NOW);
      const { sara, jobId, token } = await running();
      await authorizeStep(ask(token, 'op-1'), NOW);
      const { stopJobFor } = await import('@/lib/computer');
      await stopJobFor(sara.brickId, sara.id, minutes(1));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
      await createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [sara.id] }, scope: 'computers', amountMicros: 500_000, shared: false, endsAt: days(20).toISOString(), settlement: 'gift' } as Parameters<typeof createGiftFor>[0], root, NOW);
      await sweepComputers(minutes(3));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', resumeCount: 0 });
    });
  });

  describe('fencing: an action from an older hand changes nothing', () => {
    const act = (brickId: string, jobId: string, body: unknown) =>
      jobActionRoute(new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.BOT_SERVICE_TOKEN}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: brickId, jobId }) });

    it('a finish with the generation the runner holds ends the job; an older one is refused as stale and ends nothing; one sent with no generation works as before', async () => {
      const a = await running('fence-a');
      const view = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.jobId } });
      const stale = await act(a.sara.brickId, a.jobId, { action: 'finish', outcome: 'done', generation: view.controlGeneration + 1 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ ok: false, reason: 'stale', generation: view.controlGeneration });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.jobId } })).status).toBe('running');
      const ok = await act(a.sara.brickId, a.jobId, { action: 'finish', outcome: 'done', generation: view.controlGeneration });
      expect(ok.status).toBe(200);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.jobId } })).status).toBe('done');
      const b = await running('fence-b');
      expect((await act(b.sara.brickId, b.jobId, { action: 'finish', outcome: 'done' })).status).toBe(200);
    });

    it('the generation the job shows moves when it pauses and again when it resumes, so a finish from before either ends nothing', async () => {
      await setUpComputerCredit({ memberAllowanceMicros: STRETCH + 10_000 }, NOW);
      const { sara, jobId, token } = await running();
      const first = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).controlGeneration;
      await authorizeStep(ask(token, 'op-1'), NOW);
      const paused = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).controlGeneration;
      expect(paused).toBeGreaterThan(first);
      await createGiftFor({ what: 'gift', audience: { kind: 'people', userIds: [sara.id] }, scope: 'computers', amountMicros: 500_000, shared: false, endsAt: days(20).toISOString(), settlement: 'gift' } as Parameters<typeof createGiftFor>[0], root, NOW);
      await sweepComputers(minutes(3));
      const resumed = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(resumed).toMatchObject({ status: 'running', resumeCount: 1 });
      expect(resumed.controlGeneration).toBeGreaterThan(paused);
      const old = await act(sara.brickId, jobId, { action: 'finish', outcome: 'done', generation: first });
      expect(old.status).toBe(409);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
    });
  });

  describe('P8: kept storage is booked once', () => {
    const kept = (bytes: number) =>
      recordMeterEvent({ eventId: `stored-${tag}-${bytes}`, kind: 'stored_bytes', pool: 'computer', occurredAt: NOW, personKey: 'unknown', personId: null, botId: randomUUID(), brick: true, payerKind: 'universe', payerPersonId: null, route: 'computer', jobId: null, quantity: bytes, unit: 'byte', costMicros: null, basis: 'estimated', sourceRef: 'test', detail: {} });

    it('with no storage budget set, kept disks stay inside the pool’s total as before', async () => {
      await setUpComputerCredit({ storageMicrosPerGbMonth: 1_000_000 }, NOW);
      await kept(2_000_000_000);
      const envelope = await currentEnvelope(NOW);
      expect(envelope).toMatchObject({ storageBudgeted: false, keptStorageMicros: 2_000_000, totalMicros: 2_000_000 });
    });

    it('with a storage budget, kept disks leave the pool’s total and are checked against the budget, once', async () => {
      await setUpComputerCredit({ storageMicrosPerGbMonth: 1_000_000, storageBudgetMicros: 3_000_000 }, NOW);
      await kept(2_000_000_000);
      const envelope = await currentEnvelope(NOW);
      expect(envelope).toMatchObject({ storageBudgeted: true, keptStorageMicros: 2_000_000, storageMicros: 2_000_000, totalMicros: 0 });
      // One more gigabyte fits the budget; two do not, whatever room the pool has
      expect(await reserveDiskRoom({ botId: randomUUID(), jobId: 'j1', bytes: 1_000_000_000 }, NOW)).toEqual({ ok: true });
      expect(await reserveDiskRoom({ botId: randomUUID(), jobId: 'j2', bytes: 2_000_000_000 }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
      // The room held for the disk is storage, not the pool's total
      expect((await currentEnvelope(NOW)).totalMicros).toBe(0);
      expect((await currentEnvelope(NOW)).storageMicros).toBe(3_000_000);
    });
  });
});
