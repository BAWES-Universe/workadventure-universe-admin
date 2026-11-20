/**
 * The bounded Instant executor (spec O2, acceptance tests 5, 6, 9, 10), against a real database, a FAKE credit source and a FAKE
 * provider. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database. Composio is never called.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { setAdapterForTests, type InstantAdapter, type InstantCall, type InstantLog, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { evaluatePause, exposureIn, giveBack, instantRunKey, reconcileRun, runInstant, setInstantHooks } from '@/lib/instant/executor';
import { setInstantFunds, shutFunds, type InstantFunds } from '@/lib/instant/funds';
import { getInstantPause, resumeInstant, saveInstantLimits } from '@/lib/instant/state';
import { checkPriceDrift, forgetDriftClock, sweepInstant } from '@/lib/instant/sweep';
import { denyInstantOnSessions } from '@/lib/instant/sessions';
import { admitInstantTool } from '@/lib/instant/values';
import { instantRulesAndReceipts } from '@/lib/instant/rules-and-receipts';
import { proposeRule } from '@/lib/spend-rules';
import { activityFor, closeReceipt, openReceipt, settleCheckingReceipts } from '@/lib/task-receipts';
import { POST as runRoute } from '@/app/api/instant/run/route';
import { GET as toolsRoute } from '@/app/api/instant/tools/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const SEARCH = admitInstantTool('EXA_SEARCH', { query: 'x' });
const TOP = SEARCH.ok ? SEARCH.topMicros : 0;
const MIN = 60 * 1000;

/** A pretend credit source: a balance, holds by key, and the same idempotence the real books promise. */
function fakeFunds(balance: number) {
  const holds = new Map<string, { amount: number; state: 'held' | 'charged' | 'released'; charged: number }>();
  const state = { balance, settleOk: true, releaseOk: true, reserveReason: null as null | 'unavailable' | 'not_set' | 'credit_used_up', refunds: new Map<string, number>() };
  const left = () => state.balance - [...holds.values()].filter((h) => h.state === 'held').reduce((sum, h) => sum + h.amount, 0) - [...holds.values()].filter((h) => h.state === 'charged').reduce((sum, h) => sum + h.charged, 0);
  const funds = {
    reserve: jest.fn(async (input: { key: string; amountMicros: number }): ReturnType<InstantFunds['reserve']> => {
      if (state.reserveReason) return { ok: false as const, reason: state.reserveReason };
      const known = holds.get(input.key);
      if (known) return { ok: true as const, created: false };
      if (left() < input.amountMicros) return { ok: false as const, reason: 'credit_used_up' as const };
      holds.set(input.key, { amount: input.amountMicros, state: 'held', charged: 0 });
      return { ok: true as const, created: true };
    }),
    settle: jest.fn(async (input: { key: string; chargeMicros: number }): Promise<{ ok: true; chargedMicros: number } | { ok: false }> => {
      if (!state.settleOk) return { ok: false };
      const hold = holds.get(input.key);
      if (!hold) return { ok: false };
      if (hold.state === 'held') {
        expect(input.chargeMicros).toBeLessThanOrEqual(hold.amount);
        hold.state = 'charged';
        hold.charged = input.chargeMicros;
      }
      // Said again, the books answer with the FIRST amount
      return { ok: true, chargedMicros: hold.charged };
    }),
    release: jest.fn(async (input: { key: string }) => {
      if (!state.releaseOk) return { ok: false };
      const hold = holds.get(input.key);
      if (hold && hold.state === 'held') hold.state = 'released';
      return { ok: !!hold };
    }),
    refund: jest.fn(async (input: { key: string; refundKey: string; amountMicros: number }): Promise<{ ok: boolean; refundedMicros: number; reason?: string }> => {
      if (state.refunds.has(input.refundKey)) return { ok: true, refundedMicros: state.refunds.get(input.refundKey)! };
      state.refunds.set(input.refundKey, input.amountMicros);
      const hold = holds.get(input.key);
      if (hold) hold.charged -= input.amountMicros;
      return { ok: true, refundedMicros: input.amountMicros };
    }),
    // Read only, as the real one: what the books gave under the key, never a give-back made by looking
    refundLookup: jest.fn(async (input: { key: string; refundKey: string }): ReturnType<InstantFunds['refundLookup']> => (state.refunds.has(input.refundKey) ? { status: 'found' as const, refundedMicros: state.refunds.get(input.refundKey)! } : { status: 'none' as const })),
  } satisfies InstantFunds;
  return { funds, holds, state, left };
}

type Script = { runs: (InstantCall | Error)[]; logs: Map<string, InstantLog>; byUser: Map<string, InstantLog[]>; responses: Map<string, unknown> };
function fakeProvider() {
  const script: Script = { runs: [], logs: new Map(), byUser: new Map(), responses: new Map() };
  const sent: { runUserId: string; tool: string; arguments: Record<string, unknown> }[] = [];
  let logsDown = false;
  const instant = {
    run: jest.fn(async (input: { runUserId: string; tool: string; arguments: Record<string, unknown> }) => {
      sent.push(input);
      const next = script.runs.shift();
      if (next instanceof Error) throw next;
      return next ?? ({ kind: 'done', successful: true, data: { hits: 1 }, error: null, logId: `log-${sent.length}`, chargeMicros: 7_000 } as InstantCall);
    }),
    log: jest.fn(async (id: string) => {
      if (logsDown) throw new Error('down');
      const log = script.logs.get(id);
      return log ? { log, response: script.responses.get(id) ?? null } : null;
    }),
    findLogs: jest.fn(async (input: { userId: string }) => {
      if (logsDown) throw new Error('down');
      return script.byUser.get(input.userId) ?? [];
    }),
    tool: jest.fn(async () => null),
    sessionInstant: jest.fn(async () => 'allowed' as const),
    denySessionInstant: jest.fn(async () => 'denied' as const),
  } satisfies InstantAdapter;
  const adapter = { instant } as unknown as ReadyMadeAdapter;
  const line = (userId: string, status: InstantLog['status'], chargeMicros: number | null, id = `line-${randomUUID().slice(0, 6)}`): InstantLog => ({ id, status, chargeMicros, credentialSource: 'instant', tool: 'EXA_SEARCH', userId, atMs: Date.now() });
  return { adapter, instant, script, sent, line, setLogsDown: (down: boolean) => (logsDown = down) };
}

let sara = '';
let omar = '';
let brick = '';
let omarBrick = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN };
const callId = () => `call-${randomUUID()}`;
const ask = (over: Record<string, unknown> = {}) => ({ botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: { query: 'weather' }, callId: callId(), ...over });
const setLimits = (over: Record<string, number | null> = {}) =>
  saveInstantLimits({ maxRunMicros: 50_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 5_000, pauseMinRuns: 10, ...over }, sara);
/** The owner switches an App on for a Brick: a ready-made App of theirs, granted to that Brick (nothing is on by default). */
async function giveApp(botId: string, ownerId: string, toolkit: string, enabled = true) {
  const connection = await prisma.appConnection.create({ data: { ownerId, name: `${toolkit}-${tag}`, serverUrl: `https://backend.composio.dev/tool_router/trs_${toolkit}_${randomUUID().slice(0, 6)}/mcp`, authType: 'none', source: 'ready_made', providerToolkit: toolkit } as never });
  await prisma.botMcpServer.create({ data: { botId, name: toolkit, serverUrl: connection.serverUrl, connectionId: connection.id, enabled } as never });
  return connection;
}
const runOf = (id: string) => prisma.instantRun.findUniqueOrThrow({ where: { id } });
const runIdOf = async (key: string) => (await prisma.instantRun.findUniqueOrThrow({ where: { runKey: instantRunKey(brick, key) } })).id;

run('the bounded Instant executor, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    brick = (await prisma.bot.create({ data: { name: `Brick ${tag}`, ownerId: sara, roomId: null } as never })).id;
    omarBrick = (await prisma.bot.create({ data: { name: `Omar ${tag}`, ownerId: omar, roomId: null } as never })).id;
  });
  beforeEach(async () => {
    setAdapterForTests(null);
    setInstantFunds(undefined);
    forgetDriftClock();
    await resumeInstant(sara);
    await prisma.appSetting.deleteMany({ where: { key: { in: ['instant-limits'] } } });
    await giveApp(brick, sara, 'exa');
  });
  afterEach(async () => {
    setAdapterForTests(undefined);
    setInstantFunds(undefined);
    await prisma.instantRefund.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.instantRun.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.instantSessionCheck.deleteMany({});
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
  });
  afterAll(async () => {
    if (envBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = envBefore.service;
    await prisma.appSetting.deleteMany({ where: { key: { in: ['instant-limits', 'instant-state'] } } });
    await prisma.bot.deleteMany({ where: { id: { in: [brick, omarBrick] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.$disconnect();
  });

  describe('nothing runs until it is bounded (test 6)', () => {
    it('refuses with no limits set, and never calls the provider or the credit books', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'not_set' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.funds.reserve).not.toHaveBeenCalled();
    });

    it('with the credit books not wired (the shut door), holds nothing and runs nothing', async () => {
      await setLimits();
      const p = fakeProvider();
      expect(await runInstant(ask(), { adapter: p.adapter, funds: shutFunds })).toMatchObject({ status: 'refused', reason: 'credit_unavailable' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('refuses a tool not in the table, arguments with no bound, and a run over the most one run may cost', async () => {
      await setLimits({ maxRunMicros: TOP - 1 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      expect(await runInstant(ask({ tool: 'GMAIL_FETCH_EMAILS' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_offered' });
      expect(await runInstant(ask({ arguments: {} }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'unbounded' });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'too_costly' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.funds.reserve).not.toHaveBeenCalled();
    });

    it('refuses an adapter that cannot run Instant', async () => {
      await setLimits();
      expect(await runInstant(ask(), { adapter: {} as ReadyMadeAdapter, funds: fakeFunds(1_000_000).funds })).toMatchObject({ reason: 'not_set' });
    });

    it('refuses anyone but the owner of a personal Brick, and a room bot', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      expect(await runInstant(ask({ personId: omar }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_owner' });
      expect(await runInstant(ask({ botId: omarBrick }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_owner' });
      expect(await runInstant(ask({ botId: randomUUID() }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_owner' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('does not start when the person credit does not cover the top price, and says so without a provider call', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(TOP - 1);
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'credit_used_up' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(await prisma.instantRun.findFirst({ where: { personId: sara }, select: { state: true, reason: true } })).toEqual({ state: 'refused', reason: 'credit_used_up' });
    });

    it('a rule the person said in chat that the books apply at the hold ends the run in the rule\'s own words: nothing sent, nothing to ask more credit for', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.reserve.mockResolvedValueOnce({ ok: false as const, reason: 'rule' as const, ruleId: 'r1', why: 'cap' as const, leftMicros: 5, words: 'No more than $1 a month' });
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'rule', words: 'No more than $1 a month', leftMicros: 5 });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(await prisma.instantRun.findFirst({ where: { personId: sara }, select: { state: true, reason: true } })).toEqual({ state: 'refused', reason: 'rule' });
    });

    it("says the books cannot be read as that, never as the person's credit being used up", async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.reserveReason = 'unavailable';
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'credit_unavailable' });
      f.funds.reserve.mockRejectedValueOnce(new Error('db down'));
      f.state.reserveReason = null;
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'credit_unavailable' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('stops at the exposure ceiling, and two runs at the same moment cannot both take the last room', async () => {
      await setLimits({ exposureCeilingMicros: TOP });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const results = await Promise.all([runInstant(ask({ arguments: { query: 'a' } }), { adapter: p.adapter, funds: f.funds }), runInstant(ask({ arguments: { query: 'b' } }), { adapter: p.adapter, funds: f.funds })]);
      expect(results.filter((r) => r.status === 'refused' && r.reason === 'exposure_full')).toHaveLength(1);
      expect(p.instant.run).toHaveBeenCalledTimes(1);
    });

    it('settled charges of the month count against the ceiling, not only runs in flight', async () => {
      await setLimits({ exposureCeilingMicros: 7_000 + TOP - 1 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      expect((await runInstant(ask({ arguments: { query: 'a' } }), { adapter: p.adapter, funds: f.funds })).status).toBe('done');
      // 7,000 charged + a second top price of 7,600 is one micro past the ceiling
      expect(await runInstant(ask({ arguments: { query: 'b' } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'exposure_full' });
    });

    it('does not run while paused', async () => {
      await setLimits();
      const { pauseInstant } = await import('@/lib/instant/state');
      await pauseInstant('manual', sara);
      const p = fakeProvider();
      expect(await runInstant(ask(), { adapter: p.adapter, funds: fakeFunds(1_000_000).funds })).toMatchObject({ reason: 'paused' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });
  });

  describe('a run that works (test 10)', () => {
    it('holds the top price before the run, charges Composios figure, and keeps customer and provider apart', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.settle.mockImplementation(async (input: { key: string; chargeMicros: number }) => {
        const hold = f.holds.get(input.key)!;
        hold.state = 'charged';
        hold.charged = input.chargeMicros;
        return { ok: true, chargedMicros: input.chargeMicros };
      });
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', ok: true, chargedMicros: 7_000, pending: false, data: { hits: 1 } });
      // The hold was the top price, taken before the provider was called
      expect(f.funds.reserve.mock.invocationCallOrder[0]).toBeLessThan(p.instant.run.mock.invocationCallOrder[0]);
      expect(f.funds.reserve.mock.calls[0][0]).toMatchObject({ amountMicros: TOP, charge: { class: 'instant', route: 'composio', provider: 'composio' } });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row).toMatchObject({ state: 'succeeded', customerState: 'charged', providerState: 'settled', providerBasis: 'measured' });
      expect(Number(row.customerMicros)).toBe(7_000);
      expect(Number(row.providerMicros)).toBe(7_000);
      expect(Number(row.topMicros)).toBe(TOP);
      // Sent through the Instant path under an opaque id, never a person's id
      expect(p.sent[0].runUserId).toBe(`universe-instant-${row.id}`);
      expect(JSON.stringify(p.sent[0])).not.toContain(sara);
      // One line in the meter's books, labelled Instant, provider cost only
      const events = await prisma.meterEvent.findMany({ where: { personId: sara } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'app_use', route: 'instant', pool: 'chat', payerKind: 'universe', eventId: `instant:${row.id}` });
      expect(events[0].detail).toMatchObject({ instant: true, provider: 'composio', tool: 'EXA_SEARCH' });
      expect(Number(events[0].costMicros)).toBe(7_000);
    });

    it('a meter event the database refuses does not undo the settlement: the run is still settled and charged', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      // A real database refusal on the meter's table: the failed statement would abort the whole transaction, settlement included
      // (dropped first, in case an earlier run stopped before its cleanup; the add is inside the try so the cleanup always runs)
      await prisma.$executeRawUnsafe('ALTER TABLE meter_events DROP CONSTRAINT IF EXISTS instant_event_refused');
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE meter_events ADD CONSTRAINT instant_event_refused CHECK (event_id NOT LIKE 'instant:%') NOT VALID`);
        const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
        expect(outcome).toMatchObject({ status: 'done', ok: true, chargedMicros: 7_000 });
        const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
        expect(row).toMatchObject({ state: 'succeeded', providerState: 'settled', customerState: 'charged' });
        expect(Number(row.providerMicros)).toBe(7_000);
        expect(await prisma.meterEvent.count({ where: { personId: sara } })).toBe(0);
        expect(quiet).toHaveBeenCalledWith('[Instant] Could not write the meter event:', expect.any(String));
      } finally {
        quiet.mockRestore();
        await prisma.$executeRawUnsafe('ALTER TABLE meter_events DROP CONSTRAINT IF EXISTS instant_event_refused');
      }
      // Once the database takes it, the next sweep writes the event the run missed: one event, at the provider cost, with what the person was charged
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: new Date() });
      const events = await prisma.meterEvent.findMany({ where: { personId: sara } });
      expect(events).toHaveLength(1);
      expect(Number(events[0].costMicros)).toBe(7_000);
      expect(events[0].detail).toMatchObject({ customerMicros: 7_000, runId: (await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } })).id });
      // And a sweep after that writes nothing more
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await prisma.meterEvent.count({ where: { personId: sara } })).toBe(1);
    });

    it('applies the markup a super admin set to what the person pays, never past the hold', async () => {
      await setLimits({ markupBps: 1_000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', chargedMicros: 7_700 });
      expect(f.funds.reserve.mock.calls[0][0].amountMicros).toBe(Math.ceil(TOP * 1.1));
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(Number(row.providerMicros)).toBe(7_000);
      expect(Number(row.customerMicros)).toBe(7_700);
    });

    it('reads the charge from Composios log when the answer does not carry it', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'done', successful: true, data: { a: 1 }, error: null, logId: 'log-x', chargeMicros: null });
      p.script.logs.set('log-x', p.line('whatever', 'success', 6_500, 'log-x'));
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'done', chargedMicros: 6_500, pending: false });
    });

    it('with no charge anywhere, hands the answer over and keeps the top price pending, then settles on the log, or at the top price after the wait', async () => {
      await setLimits({ chargeWaitMinutes: 60 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: true, data: { a: 1 }, error: null, logId: 'log-y', chargeMicros: null });
      const outcome = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', pending: true });
      let row = await runOf(await runIdOf(id));
      expect(row).toMatchObject({ customerState: 'held', providerState: 'pending' });
      // Still no charge before the wait is over: nothing changes, and the top price still counts as exposure
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 10 * MIN) });
      expect(await runOf(row.id)).toMatchObject({ customerState: 'held', providerState: 'pending' });
      // Past the wait: the top price stands as an estimate, the person pays at most the hold
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 61 * MIN) });
      row = await runOf(row.id);
      expect(row).toMatchObject({ customerState: 'charged', providerState: 'settled', providerBasis: 'estimated' });
      expect(Number(row.customerMicros)).toBe(TOP);
      expect(Number(row.providerMicros)).toBe(TOP);
    });

    it('settles on the logs figure when it turns up before the wait ends', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: true, data: {}, error: null, logId: 'log-z', chargeMicros: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      p.script.logs.set('log-z', p.line('u', 'success', 5_000, 'log-z'));
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date() });
      const row = await runOf(rowId);
      expect(row).toMatchObject({ customerState: 'charged', providerState: 'settled', providerBasis: 'measured' });
      expect(Number(row.customerMicros)).toBe(5_000);
    });

    it('a charge above the top price still settles, the person pays the hold at most, and Instant stops', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'done', successful: true, data: {}, error: null, logId: 'l', chargeMicros: TOP * 5 });
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', chargedMicros: TOP });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(Number(row.providerMicros)).toBe(TOP * 5);
      expect(Number(row.customerMicros)).toBe(TOP);
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'price_over_top' });
    });
  });

  describe('a failure never costs the person, and our provider charge stays on our books (test 5)', () => {
    it('releases the whole hold when the tool ran and did not work, and records our own charge from the log', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-f', chargeMicros: null });
      const outcome = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'failed', reason: 'provider_failed', message: 'It did not work. You were not charged.' });
      expect(f.left()).toBe(1_000_000);
      const rowId = await runIdOf(id);
      expect(await runOf(rowId)).toMatchObject({ state: 'failed', customerState: 'released', providerState: 'pending' });
      // Our own charge is on our books: at the top price (estimated) until the log or the wait settles it
      p.script.logs.set('log-f', p.line('u', 'failed', 3_000, 'log-f'));
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date() });
      const row = await runOf(rowId);
      expect(row).toMatchObject({ providerState: 'settled', providerBasis: 'measured', customerState: 'released' });
      expect(Number(row.providerMicros)).toBe(3_000);
      expect(Number(row.customerMicros)).toBe(0);
      expect(f.funds.settle).not.toHaveBeenCalled();
    });

    it('an absent charge on a failed run is not read as free: the top price stands as an estimate after the wait', async () => {
      await setLimits({ chargeWaitMinutes: 30 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-f', chargeMicros: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      p.script.logs.set('log-f', p.line('u', 'failed', null, 'log-f'));
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 31 * MIN) });
      const row = await runOf(rowId);
      expect(row).toMatchObject({ providerState: 'settled', providerBasis: 'estimated' });
      expect(Number(row.providerMicros)).toBe(TOP);
    });

    it('a refusal before anything ran releases the hold and costs nothing; an empty provider balance pauses Instant', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'rejected', status: 402, code: 'Metering_WalletBalanceExhausted' });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'failed', reason: 'provider_empty' });
      expect(f.left()).toBe(1_000_000);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row).toMatchObject({ providerState: 'settled', customerState: 'released' });
      expect(Number(row.providerMicros)).toBe(0);
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'provider_empty' });
    });

    it("Instant not switched on for the tool reads as off, and nothing is charged", async () => {
      await setLimits({ pauseMinRuns: 100 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'rejected', status: 403, code: 'ManagedCredential_NotEnabled' });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'failed', reason: 'provider_off' });
      expect(f.left()).toBe(1_000_000);
    });

    it('an invalid request releases the hold and waits for the log to say whether anything was charged', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'invalid', status: 400, code: 'Bad' });
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'failed', reason: 'invalid_request' });
      expect(await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } })).toMatchObject({ customerState: 'released', providerState: 'pending', reason: 'invalid_request' });
    });

    it('details Composio would not take never count toward the failure rate, and only one waits at a time for a person', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 2 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      p.script.runs.push({ kind: 'invalid', status: 400, code: 'Bad' });
      await runInstant(ask({ arguments: { query: 'bad1' } }), { adapter: p.adapter, funds: f.funds });
      // The next ask waits while the first one's charge is still unread
      expect(await runInstant(ask({ arguments: { query: 'bad2' } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'already_checking' });
      await prisma.instantRun.updateMany({ where: { personId: sara }, data: { providerState: 'settled', providerMicros: BigInt(0) } });
      p.script.runs.push({ kind: 'invalid', status: 400, code: 'Bad' });
      await runInstant(ask({ arguments: { query: 'bad3' } }), { adapter: p.adapter, funds: f.funds });
      await prisma.instantRun.updateMany({ where: { personId: sara }, data: { providerState: 'settled', providerMicros: BigInt(0) } });
      expect(await evaluatePause()).toBe(false);
      expect((await getInstantPause()).paused).toBe(false);
    });

    it('a hold the books may have made before they failed is given back, and when that fails too the run stays open', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.reserve.mockImplementationOnce(async (input: { key: string; amountMicros: number }) => {
        f.holds.set(input.key, { amount: input.amountMicros, state: 'held', charged: 0 });
        throw new Error('connection lost after commit');
      });
      expect(await runInstant(ask({ arguments: { query: 'lost1' } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'credit_unavailable' });
      expect(f.left()).toBe(1_000_000);
      expect(await prisma.instantRun.findFirstOrThrow({ where: { personId: sara }, orderBy: { createdAt: 'desc' } })).toMatchObject({ state: 'refused' });
      // The release fails as well: the run is not closed over a hold that may exist
      f.state.releaseOk = false;
      f.funds.reserve.mockImplementationOnce(async (input: { key: string; amountMicros: number }) => {
        f.holds.set(input.key, { amount: input.amountMicros, state: 'held', charged: 0 });
        throw new Error('connection lost after commit');
      });
      expect(await runInstant(ask({ arguments: { query: 'lost2' } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'credit_unavailable' });
      const open = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara }, orderBy: { createdAt: 'desc' } });
      expect(open.state).toBe('reserving');
      f.state.releaseOk = true;
      await reconcileRun(open.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 6 * MIN) });
      expect(await runOf(open.id)).toMatchObject({ state: 'refused' });
      expect(f.left()).toBe(1_000_000);
    });

    it('when the books do not take the release, the hold stays and the sweep says it again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.releaseOk = false;
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: 'l', chargeMicros: null });
      await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } })).toMatchObject({ state: 'failed', customerState: 'held' });
      f.state.releaseOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } })).toMatchObject({ customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
    });

    it('when the books do not take the charge, the person is not marked charged and the sweep says it again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.settleOk = false;
      const outcome = await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', pending: true });
      expect(await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } })).toMatchObject({ customerState: 'held', providerState: 'settled' });
      f.state.settleOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row.customerState).toBe('charged');
      expect(Number(row.customerMicros)).toBe(7_000);
    });
  });

  describe('an ambiguous result is looked up before anything is decided or repeated (test 5)', () => {
    it('a timeout keeps the hold, says checking, and a second ask for the same call never runs again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      const first = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(first).toMatchObject({ status: 'checking' });
      expect(f.holds.get(`instant:${await runIdOf(id)}`)?.state).toBe('held');
      const again = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(again).toMatchObject({ status: 'checking' });
      expect(p.instant.run).toHaveBeenCalledTimes(1);
    });

    it('a saved run is only handed back to the person it belongs to: the same Brick and call id from someone else gets a refusal and nothing of the run', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      const mine = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(mine).toMatchObject({ status: 'done', ok: true });
      const theirs = await runInstant(ask({ callId: id, personId: omar }), { adapter: p.adapter, funds: f.funds });
      expect(theirs).toMatchObject({ status: 'refused', reason: 'not_owner' });
      expect(JSON.stringify(theirs)).not.toContain('weather');
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      // The owner asking again still gets their own run back
      expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'already_done' });
    });

    it('the very same ask under a new call id waits while the first is unclear: never paid twice', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 502 });
      await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'already_checking' });
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      // A different ask is not held up by it
      expect((await runInstant(ask({ arguments: { query: 'something else' } }), { adapter: p.adapter, funds: f.funds })).status).toBe('done');
    });

    it('finds the run by its own id: a log that says it worked charges the person and the answer is handed back from that log, never run again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', 7_000, 'log-late')]);
      p.script.logs.set('log-late', p.line(row.providerUserId, 'success', 7_000, 'log-late'));
      p.script.responses.set('log-late', { successful: true, data: { hits: 42 } });
      const outcome = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'done', recovered: true, data: { hits: 42 }, chargedMicros: 7_000 });
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      expect(p.instant.findLogs.mock.calls[0][0]).toMatchObject({ userId: row.providerUserId });
      expect(await runOf(row.id)).toMatchObject({ state: 'succeeded', customerState: 'charged', providerState: 'settled' });
    });

    it('a log that says it failed releases the hold', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'network', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'failed', null)]);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await runOf(row.id)).toMatchObject({ state: 'failed', customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
    });

    it('a log line that does not name the run id is still ours when the search by id found it, but another id never is', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'network', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      // A line of somebody else's id is not this run's
      p.script.byUser.set(row.providerUserId, [{ ...p.line('someone-else', 'failed', null), userId: 'someone-else' }]);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect((await runOf(row.id)).state).toBe('ambiguous');
      // A line with no id on it, found by the search for this id, is
      p.script.byUser.set(row.providerUserId, [{ ...p.line('x', 'failed', null), userId: null }]);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await runOf(row.id)).toMatchObject({ state: 'failed', customerState: 'released' });
    });

    it('Composio is asked outside the database transaction: no lock is held while it is', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      const held: number[] = [];
      const asking = async () => {
        const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`;
        held.push(Number(rows[0].n));
      };
      p.instant.findLogs.mockImplementation((async () => {
        await asking();
        return [p.line(row.providerUserId, 'failed', null)];
      }) as never);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(held.length).toBeGreaterThan(0);
      expect(held.every((n) => n === 0)).toBe(true);
    });

    it('a log line with a status nobody can read is looked at again until the wait is over, then ends like no log: the hold goes back and exposure is closed', async () => {
      await setLimits({ unclearWaitMinutes: 30 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'unknown', null, 'log-odd')]);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 10 * MIN) });
      expect((await runOf(row.id)).state).toBe('ambiguous');
      expect(f.left()).toBeLessThan(1_000_000);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 40 * MIN) });
      expect(await runOf(row.id)).toMatchObject({ state: 'failed', reason: 'unclear', customerState: 'released', providerState: 'settled', providerBasis: 'estimated', providerLogId: 'log-odd' });
      expect(f.left()).toBe(1_000_000);
    });

    it('no log yet is not a decision: the run stays unclear and the hold stays until the wait is over', async () => {
      await setLimits({ unclearWaitMinutes: 30 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 500 });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 10 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ state: 'ambiguous', customerState: 'held', providerState: 'pending' });
    });

    it('past the wait with no log at all, the person hold goes back and our exposure closes at the top price as an estimate', async () => {
      await setLimits({ unclearWaitMinutes: 30 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 500 });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 31 * MIN) });
      const row = await runOf(rowId);
      expect(row).toMatchObject({ state: 'failed', customerState: 'released', providerState: 'settled', providerBasis: 'estimated' });
      expect(Number(row.providerMicros)).toBe(TOP);
      expect(f.left()).toBe(1_000_000);
    });

    it('when Composio cannot be asked, nothing is decided on a guess, even past the wait', async () => {
      await setLimits({ unclearWaitMinutes: 30 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 500 });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      p.setLogsDown(true);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 120 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ state: 'ambiguous', customerState: 'held', providerState: 'pending' });
    });

    it('when Composio cannot be asked for a long while, the hold is let go and the run is written off as released unconfirmed', async () => {
      await setLimits({ unclearWaitMinutes: 30, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 500 });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      p.setLogsDown(true);
      // Still inside the long wait: nothing is decided on a guess
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 599 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ state: 'ambiguous', customerState: 'held', providerState: 'pending' });
      expect(f.left()).toBeLessThan(1_000_000);
      // Past it: the person's credit comes back, our exposure closes at the top price as an estimate, and the run says why
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 601 * MIN) });
      const row = await runOf(rowId);
      expect(row).toMatchObject({ state: 'failed', reason: 'unclear', customerState: 'released', providerState: 'settled', providerBasis: 'estimated' });
      expect(Number(row.providerMicros)).toBe(TOP);
      expect(row.detail).toMatchObject({ releasedUnconfirmed: true });
      expect(f.left()).toBe(1_000_000);
      // And the Costs report says so on the Instant row
      const { costsReport } = await import('@/lib/meter-costs');
      const day = new Date(Date.now() + 601 * MIN);
      const report = await costsReport(new Date(day.getTime() - 3 * 86_400_000), new Date(day.getTime() + 2 * 86_400_000), day);
      expect(report.goes.find((entry) => entry.key === 'instant')?.releasedUnconfirmed).toBeGreaterThanOrEqual(1);
      // Asked again, the person is told it could not be confirmed and that they were not charged (never "failed")
      const again = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds, now: day });
      expect(again).toMatchObject({ status: 'failed', reason: 'unclear', message: 'We couldn’t confirm this one, so you weren’t charged.' });
      // The log is reachable again later: nothing is charged to the person afterwards, and the credit stays whole
      p.setLogsDown(false);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(day.getTime() + 60 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ state: 'failed', customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
    });

    it('a run still in flight is never called unclear by a look-up that happens during its wait', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      const created = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(created.status).toBe('done');
      // Make a "sent" run by hand, as if the request were still going out
      const inflight = await prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: 'h', priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'sent', customerState: 'held', providerState: 'pending', providerUserId: 'u-x', sentAt: new Date() } });
      f.holds.set(`instant:${inflight.id}`, { amount: TOP, state: 'held', charged: 0 });
      await reconcileRun(inflight.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + MIN) });
      expect((await runOf(inflight.id)).state).toBe('sent');
    });

    it('a run that crashed between its steps never went out, so its hold goes back', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const stuck = await prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: 'h2', priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'held', customerState: 'held', providerUserId: 'u-y' } });
      f.holds.set(`instant:${stuck.id}`, { amount: TOP, state: 'held', charged: 0 });
      await reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 6 * MIN) });
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('a crashed run whose hold the books could not release is not closed: it is asked again', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const stuck = await prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: 'h3', priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'held', customerState: 'held', providerUserId: 'u-z' } });
      f.holds.set(`instant:${stuck.id}`, { amount: TOP, state: 'held', charged: 0 });
      f.state.releaseOk = false;
      await reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 6 * MIN) });
      // Closed (nothing can send it) but marked as still holding: the books did not say the hold is gone
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'held' });
      expect(f.holds.get(`instant:${stuck.id}`)?.state).toBe('held');
      f.state.releaseOk = true;
      await reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 7 * MIN) });
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
    });
  });

  describe('nothing is on for a Brick unless its owner switched that App on for it', () => {
    const toolNames = async () => ((await (await toolsRoute(new NextRequest(`http://localhost/api/instant/tools?botId=${brick}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } }))).json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();

    it('a Brick with no App on is offered nothing and refused anything, and the provider and the credit books are never touched', async () => {
      await setLimits();
      await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
      setInstantFunds(fakeFunds(1_000_000).funds);
      const p = fakeProvider();
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: {}, instantSupported: true, priceWords: null })) as never);
      setAdapterForTests(p.adapter);
      expect(await toolNames()).toEqual([]);
      const f = fakeFunds(1_000_000);
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'not_offered' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.funds.reserve).not.toHaveBeenCalled();
    });

    it('only the Apps the owner switched on are offered and run: one App, not all of them', async () => {
      await setLimits();
      setInstantFunds(fakeFunds(1_000_000).funds);
      const p = fakeProvider();
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: {}, instantSupported: true, priceWords: null })) as never);
      setAdapterForTests(p.adapter);
      const names = await toolNames();
      expect(names).toEqual(['EXA_ANSWER', 'EXA_GET_CONTENTS_ACTION', 'EXA_SEARCH']);
      // The schema a Brick is offered is cut to the arguments a run may carry: no contents, no result count past the limit
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: { type: 'object', properties: { query: {}, contents: {}, type: {} }, required: ['query'] }, instantSupported: true, priceWords: null })) as never);
      const { forgetToolSchemas } = await import('@/lib/instant/tools');
      forgetToolSchemas();
      const listed = (await (await toolsRoute(new NextRequest(`http://localhost/api/instant/tools?botId=${brick}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } }))).json()) as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[] };
      const search = listed.tools.find((tool) => tool.name === 'EXA_SEARCH');
      expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual(['query']);
      expect(search?.inputSchema.required).toEqual(['query']);
      const f = fakeFunds(1_000_000);
      // Exa is on: it runs. Tavily is not on: it is refused without a hold.
      expect(await runInstant(ask({ tool: 'TAVILY_SEARCH' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'not_offered' });
      expect(f.funds.reserve).not.toHaveBeenCalled();
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'done' });
    });

    it('an App the owner switched off for the Brick, or only has on another Brick, is not on for this one', async () => {
      await setLimits();
      await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
      await giveApp(brick, sara, 'tavily', false);
      const other = (await prisma.bot.create({ data: { name: `Other ${tag}`, ownerId: sara, roomId: null } as never })).id;
      await giveApp(other, sara, 'exa');
      const f = fakeFunds(1_000_000);
      const p = fakeProvider();
      expect(await runInstant(ask({ tool: 'TAVILY_SEARCH' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_offered' });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'not_offered' });
      expect(f.funds.reserve).not.toHaveBeenCalled();
      await prisma.bot.delete({ where: { id: other } });
    });

    it("matches an App's name loosely (the provider's spelling, any case)", async () => {
      await setLimits();
      await giveApp(brick, sara, 'TAVILY');
      const f = fakeFunds(1_000_000);
      const p = fakeProvider();
      expect(await runInstant(ask({ tool: 'TAVILY_SEARCH' }), { adapter: p.adapter, funds: f.funds })).not.toMatchObject({ reason: 'not_offered' });
    });
  });

  describe('the same call never runs or pays twice', () => {
    it('a retry with the same call id gets the same run back and the provider is called once', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: true, data: { hits: 7 }, error: null, logId: 'log-r', chargeMicros: 7_000 });
      p.script.logs.set('log-r', p.line('u', 'success', 7_000, 'log-r'));
      p.script.responses.set('log-r', { data: { hits: 7 } });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const again = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(again).toMatchObject({ status: 'done', recovered: true, data: { hits: 7 } });
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      expect(f.funds.reserve).toHaveBeenCalledTimes(1);
    });

    it('a retry of a run whose saved answer is gone says it was done, without running it again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'already_done', chargedMicros: 7_000 });
      expect(p.instant.run).toHaveBeenCalledTimes(1);
    });

    it('two asks for the same call id at the same moment make one run', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      await Promise.all([runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds }), runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds })]);
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      expect(await prisma.instantRun.count({ where: { personId: sara } })).toBe(1);
    });

    it('a refused call stays refused for that call id', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(0);
      const id = callId();
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: fakeFunds(1_000_000).funds })).toMatchObject({ status: 'refused', reason: 'credit_used_up' });
    });
  });

  describe('review findings on pausing and on what the books confirm', () => {
    afterEach(() => setInstantHooks(undefined));

    it('an ask that waited for the person’s rules while Instant was paused is stopped, and holds and sends nothing', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { pauseInstant } = await import('@/lib/instant/state');
      setInstantHooks({ beforeRun: async () => { await pauseInstant('manual', sara); return null; } });
      const key = callId();
      expect(await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'paused' });
      expect(f.funds.reserve).not.toHaveBeenCalled();
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(await prisma.instantRun.count({ where: { runKey: instantRunKey(brick, key) } })).toBe(0);
    });

    it('a duplicate of a call whose run was saved while it waited is answered with that run, not "paused"; another person’s is "not_owner"', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { pauseInstant } = await import('@/lib/instant/state');
      for (const [owner, expected] of [[sara, { status: 'already_done' }], [omar, { status: 'refused', reason: 'not_owner' }]] as const) {
        const key = callId();
        // After this ask's first look for the run and before it takes the admission lock, the run is saved (by the twin that got there first)
        // and Instant is paused
        setInstantHooks({
          beforeRun: async () => {
            await prisma.instantRun.create({ data: { runKey: instantRunKey(brick, key), botId: brick, personId: owner, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'succeeded', customerState: 'charged', customerMicros: BigInt(7_000), providerState: 'settled', providerMicros: BigInt(7_000), providerUserId: `u-${randomUUID().slice(0, 6)}`, finishedAt: new Date() } as never });
            await pauseInstant('manual', sara);
            return null;
          },
        });
        const answer = await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds });
        expect(answer).toMatchObject(expected);
        expect(f.funds.reserve).not.toHaveBeenCalled();
        expect(p.instant.run).not.toHaveBeenCalled();
        await resumeInstant(sara);
      }
    });

    it('a give-back the books never confirmed, and a give-back for a run outside the window, are not failures', async () => {
      await setLimits({ pauseFailureRateBps: 3_000, pauseMinRuns: 2 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      const ids: string[] = [];
      // Three runs: when the first leaves the window two are still counted, so the minimum is met and only the give-back decides
      for (const n of [1, 2, 3]) {
        const key = callId();
        await runInstant(ask({ callId: key, arguments: { query: `gw${n}` } }), { adapter: p.adapter, funds: f.funds });
        ids.push(await runIdOf(key));
      }
      // An intent the books may or may not have acted on: nothing is known to have been given back
      await prisma.instantRefund.create({ data: { refundKey: `gw-a-${tag}`, runId: ids[0], personId: sara, kind: 'goodwill', amountMicros: BigInt(1_000) } });
      expect(await evaluatePause()).toBe(false);
      // Confirmed, but for a run that finished before the window
      await prisma.instantRun.update({ where: { id: ids[0] }, data: { finishedAt: new Date(Date.now() - 48 * 3_600_000) } });
      await prisma.instantRefund.updateMany({ where: { refundKey: `gw-a-${tag}` }, data: { confirmedAt: new Date() } });
      expect(await evaluatePause()).toBe(false);
      // Confirmed, for a run in the window: that is a failure of the runs being counted
      await prisma.instantRun.update({ where: { id: ids[0] }, data: { finishedAt: new Date() } });
      // Confirmed at zero: the person got nothing back, so it is not a failure of the runs being counted
      await prisma.instantRefund.updateMany({ where: { refundKey: `gw-a-${tag}` }, data: { amountMicros: BigInt(0) } });
      expect(await evaluatePause()).toBe(false);
      await prisma.instantRefund.updateMany({ where: { refundKey: `gw-a-${tag}` }, data: { amountMicros: BigInt(1_000) } });
      expect(await evaluatePause()).toBe(true);
    });

    it('a resume that comes while the failure counts are being read drops that pause', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 2 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      for (const n of [1, 2]) {
        p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: `rs${n}`, chargeMicros: null });
        await runInstant(ask({ arguments: { query: `rs${n}` } }), { adapter: p.adapter, funds: f.funds });
      }
      expect(await getInstantPause()).toMatchObject({ paused: true });
      await resumeInstant(sara);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Two more failures after that resume; the counts are read, then a super admin resumes again before the pause is taken
      await prisma.instantRun.updateMany({ where: { state: 'failed' }, data: { finishedAt: new Date() } });
      // The counts are read in one transaction: the resume comes as it ends, before the pause is taken
      const realTx = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => {
        spy.mockRestore();
        return realTx(fn, ...rest).then(async (answer) => {
          await resumeInstant(sara);
          return answer;
        });
      }) as never);
      expect(await evaluatePause()).toBe(false);
      expect((await getInstantPause()).paused).toBe(false);
    });

    it('reads all its counts from one snapshot: a run that fails while they are being read is in all of them or in none', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 2 });
      const make = (state: 'succeeded' | 'failed') =>
        prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state, customerState: state === 'failed' ? 'released' : 'charged', providerUserId: `u-${randomUUID().slice(0, 6)}`, finishedAt: new Date() } as never });
      await make('succeeded');
      await make('succeeded');
      await make('failed');
      // One failure in three is under the half a super admin set. A second failure lands after the first count is read (the later counts wait for it, so
      // that is the order whichever way they are asked): read apart, the rate is two in three, a count of runs from before a run and a count of failures from after it
      let asked = 0;
      let landed: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (landed = resolve));
      const interleaved = (count: (args: unknown) => Promise<number>) => async (args: unknown) => {
        const mine = ++asked;
        if (mine > 1) await gate;
        const answer = await count(args);
        if (mine === 1) {
          await make('failed');
          landed();
        }
        return answer;
      };
      const realCount = prisma.instantRun.count.bind(prisma.instantRun) as (args: unknown) => Promise<number>;
      const countSpy = jest.spyOn(prisma.instantRun, 'count').mockImplementation(interleaved(realCount) as never);
      const realTx = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => {
        txSpy.mockRestore();
        if (typeof fn !== 'function') return realTx(fn, ...rest);
        return realTx(async (tx: { instantRun: { count: (args: unknown) => Promise<number> } }) => {
          const counted = new Proxy(tx.instantRun, { get: (target, key) => (key === 'count' ? interleaved((args) => target.count(args)) : Reflect.get(target, key)) });
          return (fn as (tx: unknown) => Promise<unknown>)(new Proxy(tx, { get: (target, key) => (key === 'instantRun' ? counted : Reflect.get(target, key)) }));
        }, ...rest);
      }) as never);
      try {
        expect(await evaluatePause()).toBe(false);
      } finally {
        countSpy.mockRestore();
        txSpy.mockRestore();
      }
      expect((await getInstantPause()).paused).toBe(false);
    });

    it('a run the books could not settle shows no customer charge in the meter event, and shows it once the books confirm it', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.settle.mockRejectedValueOnce(new Error('books down'));
      const key = callId();
      await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds });
      const id = await runIdOf(key);
      expect((await runOf(id)).customerState).toBe('held');
      const before = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect((before.detail as { customerMicros: number | null }).customerMicros).toBeNull();
      // The sweep says it again, and the books confirm
      await reconcileRun(id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      const after = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect((after.detail as { customerMicros: number }).customerMicros).toBe(Number((await runOf(id)).customerMicros));
      expect(Number((await runOf(id)).customerMicros)).toBeGreaterThan(0);
    });
    it('a meter event update that fails does not leave a run charged without its customer charge in the event: the run stays held, and the next sweep writes both', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const key = callId();
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION instant_update_refused() RETURNS trigger AS $$ BEGIN IF NEW.event_id LIKE 'instant:%' AND (NEW.detail::jsonb ? 'customerMicros') THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER instant_update_refused BEFORE UPDATE ON meter_events FOR EACH ROW EXECUTE FUNCTION instant_update_refused()');
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let id = '';
      try {
        await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds }).catch(() => undefined);
        id = await runIdOf(key);
        expect((await runOf(id)).customerState).toBe('held');
        expect(((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } })).detail as { customerMicros?: number | null }).customerMicros ?? null).toBeNull();
      } finally {
        quiet.mockRestore();
        await prisma.$executeRawUnsafe('DROP TRIGGER instant_update_refused ON meter_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION instant_update_refused()');
      }
      await reconcileRun(id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect((await runOf(id)).customerState).toBe('charged');
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect((event.detail as { customerMicros: number }).customerMicros).toBe(Number((await runOf(id)).customerMicros));
    });
  });

  describe('charging a run and telling the meter event, in one step', () => {
    it('a meter event that cannot be updated leaves the run held, and the next sweep charges it and writes the amount', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const key = callId();
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION instant_test_refuse_event_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'cannot update the event for the test'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER instant_test_refuse_event_update BEFORE UPDATE ON meter_events FOR EACH ROW WHEN (NEW.event_id LIKE 'instant:%') EXECUTE FUNCTION instant_test_refuse_event_update()`);
      const silenced = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let id = '';
      try {
        await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds }).catch(() => undefined);
        id = await runIdOf(key);
        // Not marked charged: nothing about the run says it is done while the event does not
        expect((await runOf(id)).customerState).toBe('held');
      } finally {
        silenced.mockRestore();
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS instant_test_refuse_event_update ON meter_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS instant_test_refuse_event_update()');
      }
      // The books answer again with the same amount, and both are written
      await reconcileRun(id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      const run = await runOf(id);
      expect(run.customerState).toBe('charged');
      expect(Number(run.customerMicros)).toBeGreaterThan(0);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect((event.detail as { customerMicros: number }).customerMicros).toBe(Number(run.customerMicros));
    });
  });

  describe('writers of one run take its lock: a backfilled meter event, and the charge being recorded', () => {
    const lockRun = (id: string) => {
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const locked = new Promise<void>((resolve) => (ready = resolve));
      const work = (after?: (tx: Prisma.TransactionClient) => Promise<void>) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`instant:run:${id}`}, 0))`;
            ready();
            await held;
            if (after) await after(tx);
          },
          { timeout: 30_000, maxWait: 15_000 },
        );
      return { release, locked, work };
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('a missing meter event is written from the run as it stands after a late measured cost, never from a read made before it', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const key = callId();
      await prisma.$executeRawUnsafe(`ALTER TABLE meter_events ADD CONSTRAINT instant_event_refused CHECK (event_id NOT LIKE 'instant:%') NOT VALID`);
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds });
      } finally {
        quiet.mockRestore();
        await prisma.$executeRawUnsafe('ALTER TABLE meter_events DROP CONSTRAINT instant_event_refused');
      }
      const id = await runIdOf(key);
      expect(await prisma.meterEvent.count({ where: { eventId: `instant:${id}` } })).toBe(0);
      const { backfillMeterEvents } = await import('@/lib/instant/executor');
      // A late measured cost is being written under the run's lock when the sweep's backfill starts
      const lock = lockRun(id);
      const writing = lock.work((tx) => tx.instantRun.update({ where: { id }, data: { providerMicros: BigInt(4_000), providerBasis: 'measured' } }).then(() => undefined));
      await lock.locked;
      const backfill = backfillMeterEvents(new Date());
      await pause(400);
      lock.release();
      await writing;
      expect(await backfill).toBeGreaterThanOrEqual(1);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect(event).toMatchObject({ basis: 'measured', costMicros: BigInt(4_000) });
    });

    it('runs whose event cannot be written do not keep the runs behind them from being tried, and a run missed long ago is still written', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      const ids: string[] = [];
      await prisma.$executeRawUnsafe(`ALTER TABLE meter_events ADD CONSTRAINT instant_event_refused CHECK (event_id NOT LIKE 'instant:%') NOT VALID`);
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        for (let n = 0; n < 26; n += 1) {
          const key = callId();
          await runInstant(ask({ callId: key, arguments: { query: `bf${n}` } }), { adapter: p.adapter, funds: f.funds });
          ids.push(await runIdOf(key));
        }
        // The oldest 25 are the ones whose event cannot be written (the first of them far past any age limit), and the 26th, the newest of the
        // lot but still long ago, can be
        for (const [n, id] of ids.entries()) {
          await prisma.instantRun.update({ where: { id }, data: { finishedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, n)) } });
        }
        await prisma.$executeRawUnsafe('ALTER TABLE meter_events DROP CONSTRAINT instant_event_refused');
        const refused = ids.slice(0, 25).map((id) => `'instant:${id}'`).join(', ');
        await prisma.$executeRawUnsafe(`ALTER TABLE meter_events ADD CONSTRAINT instant_event_refused CHECK (event_id NOT IN (${refused})) NOT VALID`);
        const { backfillMeterEvents } = await import('@/lib/instant/executor');
        await backfillMeterEvents(new Date(), 25);
      } finally {
        quiet.mockRestore();
        await prisma.$executeRawUnsafe('ALTER TABLE meter_events DROP CONSTRAINT IF EXISTS instant_event_refused');
      }
      // The 25 that cannot be written do not hold up the 26th, however old it is
      expect(await prisma.meterEvent.count({ where: { eventId: `instant:${ids[25]}` } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { eventId: { in: ids.slice(0, 25).map((id) => `instant:${id}`) } } })).toBe(0);
      // And once they can be written they are, however old
      const { backfillMeterEvents } = await import('@/lib/instant/executor');
      await backfillMeterEvents(new Date(), 25);
      expect(await prisma.meterEvent.count({ where: { eventId: { in: ids.map((id) => `instant:${id}`) } } })).toBe(26);
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${ids[0]}` } })).toMatchObject({ occurredAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 0)) });
    }, 60_000);

    it('the charge is recorded under the run lock, so a backfill reading the run first cannot leave the event saying "not known" for good', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const key = callId();
      // The books answer, and at that moment another writer of the run holds its lock: recording the charge must wait for it
      const real = f.funds.settle.getMockImplementation()!;
      const state = { id: '', lock: null as ReturnType<typeof lockRun> | null, writing: null as Promise<void> | null };
      f.funds.settle.mockImplementationOnce((async (input: never) => {
        const answer = await real(input);
        state.id = await runIdOf(key);
        state.lock = lockRun(state.id);
        state.writing = state.lock.work();
        await state.lock.locked;
        return answer;
      }) as never);
      const running = runInstant(ask({ callId: key }), { adapter: p.adapter, funds: f.funds });
      const id = await (async () => {
        try {
          // Bounded: a run that never reaches the books' answer fails here with a plain message, and nothing is left waiting
          for (let waited = 0; !state.lock; waited += 50) {
            if (waited >= 5_000) throw new Error('the run never reached the books’ answer');
            await pause(50);
          }
          await state.lock.locked;
          await pause(500);
          expect((await runOf(state.id)).customerState).toBe('held');
          return state.id;
        } finally {
          // However the checks above end, the lock is let go and both workers are joined: no transaction is left open into the next test
          state.lock?.release();
          await Promise.allSettled([state.writing, running]);
        }
      })();
      expect(await runOf(id)).toMatchObject({ customerState: 'charged' });
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `instant:${id}` } });
      expect((event.detail as { customerMicros: number }).customerMicros).toBe(Number((await runOf(id)).customerMicros));
    });
  });

  describe('Instant stops by itself', () => {
    it('pauses when the failure share of recent runs passes what a super admin set, once enough runs happened', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 4 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      for (const n of [1, 2, 3]) {
        p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: `l${n}`, chargeMicros: null });
        await runInstant(ask({ arguments: { query: `q${n}` } }), { adapter: p.adapter, funds: f.funds });
      }
      // Three failures but fewer runs than the minimum: not an alarm yet
      expect((await getInstantPause()).paused).toBe(false);
      p.script.runs.push({ kind: 'done', successful: true, data: {}, error: null, logId: 'l4', chargeMicros: 7_000 });
      await runInstant(ask({ arguments: { query: 'q4' } }), { adapter: p.adapter, funds: f.funds });
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'failure_rate' });
      // New runs stop
      expect(await runInstant(ask({ arguments: { query: 'q5' } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ reason: 'paused' });
      // And only a super admin turns it back on
      await resumeInstant(sara);
      expect((await getInstantPause()).paused).toBe(false);
      // The runs they already looked at never pause it again, however often it is checked
      expect(await evaluatePause()).toBe(false);
      expect(await evaluatePause()).toBe(false);
      expect((await getInstantPause()).paused).toBe(false);
    });

    it('after a resume, only runs that finish after it count toward the next pause', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 2 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      for (const n of [1, 2]) {
        p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: `r${n}`, chargeMicros: null });
        await runInstant(ask({ arguments: { query: `r${n}` } }), { adapter: p.adapter, funds: f.funds });
      }
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'failure_rate' });
      await resumeInstant(sara);
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const n of [3, 4]) {
        p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: `r${n}`, chargeMicros: null });
        await runInstant(ask({ arguments: { query: `r${n}` } }), { adapter: p.adapter, funds: f.funds });
      }
      // New failures after the resume are a new alarm
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'failure_rate' });
    });

    it('does not pause on a healthy run history', async () => {
      await setLimits({ pauseFailureRateBps: 5_000, pauseMinRuns: 2 });
      const p = fakeProvider();
      const f = fakeFunds(10_000_000);
      await runInstant(ask({ arguments: { query: 'a' } }), { adapter: p.adapter, funds: f.funds });
      await runInstant(ask({ arguments: { query: 'b' } }), { adapter: p.adapter, funds: f.funds });
      expect(await evaluatePause()).toBe(false);
    });

    it('a trusted price that moved up in Composios own listing pauses Instant; one that is the same does not', async () => {
      await setLimits();
      const p = fakeProvider();
      const { instantListedPrices } = await import('@/lib/instant/values');
      const listed = new Map(instantListedPrices().map((row) => [row.tool, row.listed]));
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: null, instantSupported: true, priceWords: listed.get(slug) ?? null })) as never);
      expect(await checkPriceDrift(p.adapter)).toMatchObject({ up: [], changed: [], gone: [], unreachable: [] });
      expect((await getInstantPause()).paused).toBe(false);
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: null, instantSupported: true, priceWords: slug === 'EXA_SEARCH' ? '$0.02 per search' : (listed.get(slug) ?? null) })) as never);
      const report = await checkPriceDrift(p.adapter);
      expect(report.up).toEqual(['EXA_SEARCH']);
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'price_drift' });
    });

    it('words with no readable figure count as higher, and a tool Composio no longer serves is reported, not trusted', async () => {
      const p = fakeProvider();
      p.instant.tool.mockImplementation((async (slug: string) => (slug === 'TAVILY_SEARCH' ? null : { slug, toolkit: 'x', description: null, inputSchema: null, instantSupported: true, priceWords: 'varies' })) as never);
      const paused: string[] = [];
      const report = await checkPriceDrift(p.adapter, async (reason) => paused.push(reason));
      expect(report.gone).toEqual(['TAVILY_SEARCH']);
      expect(report.up).toContain('EXA_SEARCH');
      expect(paused).toEqual(['price_drift']);
    });
  });

  describe('giving back after a charge is bounded by limits a super admin sets', () => {
    async function charged(f: ReturnType<typeof fakeFunds>, p: ReturnType<typeof fakeProvider>, query = 'a') {
      const id = callId();
      await runInstant(ask({ callId: id, arguments: { query } }), { adapter: p.adapter, funds: f.funds });
      return runIdOf(id);
    }

    it('gives back nothing until the limits are set', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_set' });
      expect(f.funds.refund).not.toHaveBeenCalled();
    });

    it('gives back once, at most the limit, passes the limits to the books, and counts it towards the pause check', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'given', amountMicros: 5_000 });
      expect(f.funds.refund.mock.calls[0][0]).toMatchObject({ reason: 'goodwill', amountMicros: 5_000, limits: { giveBackMaxMicros: 5_000, goodwillBudgetMicros: 100_000 } });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'already_given' });
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
      expect(await prisma.instantRefund.count({ where: { runId } })).toBe(1);
    });

    it("refuses someone else's run and a run that was never charged", async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      expect(await giveBack({ personId: omar, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_found' });
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: 'l', chargeMicros: null });
      const failed = await charged(f, p, 'b');
      expect(await giveBack({ personId: sara, runId: failed }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_charged' });
    });

    it('stops at the month budget for everyone and at the limit for one person', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 7_000, goodwillPerPersonPerMonth: 1 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const first = await charged(f, p, 'a');
      const second = await charged(f, p, 'b');
      expect(await giveBack({ personId: sara, runId: first }, { funds: f.funds })).toMatchObject({ status: 'given' });
      expect(await giveBack({ personId: sara, runId: second }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'person_limit' });
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 7_000, goodwillPerPersonPerMonth: 5 });
      expect(await giveBack({ personId: sara, runId: second }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'budget' });
    });

    it('when the books say unavailable, nothing is recorded as given back, and only an unconfirmed intent is kept', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect((await prisma.instantRefund.findMany({ where: { runId } })).map((r) => r.confirmedAt)).toEqual([null]);
      expect(Number((await runOf(runId)).refundedMicros)).toBe(0);
    });

    it('the sweep finishes a give-back the books never confirmed, and lets go of one they could not be reached about for the whole wait', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 6_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const first = await charged(f, p, 'a');
      const second = await charged(f, p, 'b');
      // Both give-backs fail at the books: the intents stay, and the budget (6,000) is used up by the first (5,000) so the second is refused
      f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      expect(await giveBack({ personId: sara, runId: first }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect(await giveBack({ personId: sara, runId: second }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'budget' });
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      // Too soon: nothing is asked again yet
      expect(await sweepGoodwill({ funds: f.funds })).toMatchObject({ looked: 0 });
      // The books answer now: the sweep finishes it and it is confirmed
      const later = new Date(Date.now() + 10 * MIN);
      expect(await sweepGoodwill({ funds: f.funds, now: later })).toEqual({ looked: 1, settled: 1, released: 0 });
      expect((await prisma.instantRefund.findFirstOrThrow({ where: { runId: first } })).confirmedAt).not.toBeNull();
      expect(Number((await runOf(first)).refundedMicros)).toBe(5_000);
      // A give-back the books stay unreachable about: tried again each sweep, and let go after the wait so it stops using the budget
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      f.funds.refund.mockResolvedValue({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      expect(await giveBack({ personId: sara, runId: second }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 20 * MIN) })).toEqual({ looked: 1, settled: 0, released: 0 });
      expect(await prisma.instantRefund.count({ where: { runId: second, confirmedAt: null } })).toBe(1);
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      // Let go of, not deleted: the row stays (marked), and no longer counts against the budget
      const rows = await prisma.instantRefund.findMany({ where: { runId: second } });
      expect(rows).toHaveLength(1);
      expect(rows[0].releasedAt).not.toBeNull();
      expect(rows[0].confirmedAt).toBeNull();
    });

    it('a give-back let go of that the books did make is found again by the sweep and recorded at their amount, even with the budget now at 1', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      // The books give it back and then fail to answer: the intent stays, and the wait runs out
      const real = f.funds.refund.getMockImplementation()!;
      f.funds.refund.mockImplementationOnce((async (input: never) => {
        await real(input);
        throw new Error('connection reset');
      }) as never);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      // It is not in the month's budget while let go of: another person's give-back is not refused for it
      expect(await prisma.instantRefund.count({ where: { runId, releasedAt: null } })).toBe(0);
      // Later the books answer again (they already gave it): confirmed at their first amount, whatever the limits say now
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 1, goodwillPerPersonPerMonth: 1, unreachableWaitMinutes: 600 });
      f.funds.refund.mockImplementation(real as never);
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 7 * 60 * MIN) })).toEqual({ looked: 1, settled: 1, released: 0 });
      const row = await prisma.instantRefund.findFirstOrThrow({ where: { runId } });
      expect(row.confirmedAt).not.toBeNull();
      expect(row.releasedAt).toBeNull();
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
    });

    it('a few intents the books stay unreachable about cannot fill every batch: the sweep takes never-asked and longest-ago-asked ones first', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 6000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const b = await charged(f, p, 'b');
      f.funds.refund.mockResolvedValue({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      await giveBack({ personId: sara, runId: b }, { funds: f.funds });
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      const asked = () => f.funds.refund.mock.calls.map((call) => (call[0] as { key: string }).key);
      f.funds.refund.mockClear();
      // A batch of one: first the older one is asked, then (a later sweep, the older one just asked) the other, never the same one again
      await sweepGoodwill({ funds: f.funds, batch: 1, now: new Date(Date.now() + 10 * MIN) });
      await sweepGoodwill({ funds: f.funds, batch: 1, now: new Date(Date.now() + 11 * MIN) });
      const keys = asked();
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      // And the pause between two asks of the same one counts from when it was last asked
      f.funds.refund.mockClear();
      expect(await sweepGoodwill({ funds: f.funds, batch: 5, now: new Date(Date.now() + 12 * MIN) })).toMatchObject({ looked: 0 });
      expect(await sweepGoodwill({ funds: f.funds, batch: 5, now: new Date(Date.now() + 17 * MIN) })).toMatchObject({ looked: 2 });
    });

    it('a give-back let go of that the books may have made still holds the person’s place: a second give-back for the same person is refused', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 1, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const b = await charged(f, p, 'b');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      // Mid-month, so the month of every call below is the same one whatever day the test runs
      const base = new Date(Date.UTC(2026, 5, 15, 12));
      const real = f.funds.refund.getMockImplementation()!;
      // The books make the give-back for the first run, and the answer is lost
      f.funds.refund.mockImplementationOnce((async (input: never) => {
        await real(input);
        throw new Error('connection reset');
      }) as never);
      expect(await giveBack({ personId: sara, runId: a }, { funds: f.funds, now: base })).toEqual({ status: 'refused', reason: 'unavailable' });
      await prisma.instantRefund.updateMany({ where: { runId: a }, data: { createdAt: base } });
      // The books stay quiet for the whole wait: the intent is let go of
      f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
      f.funds.refundLookup.mockResolvedValue({ status: 'unavailable' });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(base.getTime() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      f.funds.refund.mockClear();
      // The books do not enforce the person's limit, and the first may well have been made: a second one for the same person is not passed
      expect(await giveBack({ personId: sara, runId: b }, { funds: f.funds, now: new Date(base.getTime() + 602 * MIN) })).toEqual({ status: 'refused', reason: 'person_limit' });
      expect(f.funds.refund).not.toHaveBeenCalled();
      expect(await prisma.instantRefund.count({ where: { personId: sara } })).toBe(1);
    });

    it('a confirmed zero from the books is recorded as zero, never as the amount asked for, and a missing amount is not a confirmation', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      f.funds.refund.mockResolvedValueOnce({ ok: true, refundedMicros: 0 });
      // The person is told nothing was given back (never "given 0")
      expect(await giveBack({ personId: sara, runId: a }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_charged' });
      const row = await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } });
      expect(row.confirmedAt).not.toBeNull();
      expect(Number(row.amountMicros)).toBe(0);
      expect(Number((await runOf(a)).refundedMicros)).toBe(0);
      // The amount check allows a confirmed zero and never a negative amount, confirmed or not
      await expect(prisma.instantRefund.updateMany({ where: { runId: a }, data: { amountMicros: BigInt(-1) } })).rejects.toThrow();
      await expect(prisma.instantRefund.updateMany({ where: { runId: a }, data: { confirmedAt: null, amountMicros: BigInt(0) } })).rejects.toThrow();
      // Asked again, the same answer, and the books are not asked again
      f.funds.refund.mockClear();
      expect(await giveBack({ personId: sara, runId: a }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_charged' });
      expect(f.funds.refund).not.toHaveBeenCalled();
      // An answer that says yes without an amount leaves the intent for the next ask
      const b = await charged(f, p, 'b');
      f.funds.refund.mockResolvedValueOnce({ ok: true } as never);
      expect(await giveBack({ personId: sara, runId: b }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect((await prisma.instantRefund.findFirstOrThrow({ where: { runId: b } })).confirmedAt).toBeNull();
      expect(Number((await runOf(b)).refundedMicros)).toBe(0);
    });

    it('a give-back found at zero in the books after it was let go of is recorded as zero too', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      f.funds.refundLookup.mockResolvedValueOnce({ status: 'found', refundedMicros: 0 });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 7 * 60 * MIN) })).toEqual({ looked: 1, settled: 1, released: 0 });
      expect(Number((await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } })).amountMicros)).toBe(0);
      expect(Number((await runOf(a)).refundedMicros)).toBe(0);
    });

    it('a give-back the books confirmed at zero does not use up one of the person\'s monthly give-backs', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 1, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const b = await charged(f, p, 'b');
      f.funds.refund.mockResolvedValueOnce({ ok: true, refundedMicros: 0 });
      expect(await giveBack({ personId: sara, runId: a }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_charged' });
      // The one allowed give-back this month is still there to use
      expect(await giveBack({ personId: sara, runId: b }, { funds: f.funds })).toEqual({ status: 'given', amountMicros: 5_000 });
      expect(await giveBack({ personId: sara, runId: await charged(f, p, 'c') }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'person_limit' });
    });

    it('"key already used" from the books means a give-back stands under the key: it is looked up and recorded at their amount, and kept when that is not known', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const c = await charged(f, p, 'c');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      const real = f.funds.refund.getMockImplementation()!;
      for (const [runId, then] of [[a, 'found'], [c, 'unknown']] as const) {
        // The books make the give-back (5,000) and the answer is lost; the intent is let go of
        f.funds.refund.mockImplementationOnce((async (input: never) => {
          await real(input);
          throw new Error('connection reset');
        }) as never);
        await giveBack({ personId: sara, runId }, { funds: f.funds });
        f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
        await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) });
        f.funds.refund.mockImplementation(real as never);
        // The give-back limit is lowered, so the new ask differs; the first one was still in flight when the books were looked at (none), and has
        // been made by the time the second is asked: the books say the key is used
        await setLimits({ goodwillMaxMicros: 2_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
        f.funds.refundLookup.mockResolvedValueOnce({ status: 'none' });
        f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'key_reused' });
        if (then === 'unknown') f.funds.refundLookup.mockResolvedValueOnce({ status: 'unavailable' });
        await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 7 * 60 * MIN) });
        const row = await prisma.instantRefund.findFirst({ where: { runId } });
        if (then === 'found') {
          expect(row?.confirmedAt).not.toBeNull();
          expect(Number(row?.amountMicros)).toBe(5_000);
          expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
        } else {
          // Not known: the intent is kept, so a later ask can still record what the books gave
          expect(row).not.toBeNull();
          expect(row?.confirmedAt).toBeNull();
        }
        await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      }
    });

    it('a sweep that waited on the books does not let go of a reservation that was made again meanwhile (its age is the new one)', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      const old = new Date(Date.now() - 2 * 60 * MIN);
      await prisma.instantRefund.updateMany({ where: { runId: a }, data: { createdAt: old } });
      // While the sweep waits on the books, the row is let go of and made again (the same row, a new age)
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      f.funds.refund.mockImplementationOnce((async () => {
        // The sweep has selected the old row and is asking the books: this is the signal, not a count of polls
        reached();
        await gate;
        return { ok: false, refundedMicros: 0, reason: 'unavailable' };
      }) as never);
      const sweeping = sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) });
      let swept: PromiseSettledResult<Awaited<typeof sweeping>>[] = [];
      try {
        let timer: NodeJS.Timeout | undefined;
        // Shorter than the test's own timeout, so a sweep that never arrives fails here with its own message and the cleanup still runs
        const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the sweep never reached the books')), 5_000)));
        await Promise.race([arrived, timeout]).finally(() => clearTimeout(timer));
        await prisma.instantRefund.updateMany({ where: { runId: a }, data: { releasedAt: null, createdAt: new Date() } });
      } finally {
        // On every path the gate is let go and the sweep is joined, so no database work outlives the test
        open();
        swept = await Promise.allSettled([sweeping]);
      }
      expect(swept[0]).toEqual({ status: 'fulfilled', value: { looked: 1, settled: 0, released: 0 } });
      expect((await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } })).releasedAt).toBeNull();
    }, 20_000);

    it('a give-back let go of that the books never made, with room under the limits, is made once as a new one and counts again from then', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 1, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      const real = f.funds.refund.getMockImplementation()!;
      f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
      expect(await giveBack({ personId: sara, runId: a }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      f.funds.refund.mockImplementation(real as never);
      const later = new Date(Date.now() + 601 * MIN + 7 * 60 * MIN);
      expect(await sweepGoodwill({ funds: f.funds, now: later })).toEqual({ looked: 1, settled: 1, released: 0 });
      const row = await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } });
      expect(row.confirmedAt).not.toBeNull();
      expect(row.releasedAt).toBeNull();
      // It counts in the month it was made in, from then
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(later.getTime() - 1_000);
      expect(Number((await runOf(a)).refundedMicros)).toBe(5_000);
    });

    it('a give-back let go of is asked about again 90 minutes after the last ask, never before, for as long as late evidence is looked for, and no longer', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockResolvedValue({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      const base = Date.now() + 601 * MIN;
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(base) })).toEqual({ looked: 1, settled: 0, released: 1 });
      f.funds.refundLookup.mockResolvedValue({ status: 'unavailable' });
      // It was just asked: not asked before 90 minutes have passed (not at 5, 60 or 89), asked after, and the 90 count from that ask
      for (const minutes of [5, 60, 89]) expect(await sweepGoodwill({ funds: f.funds, now: new Date(base + minutes * MIN) })).toMatchObject({ looked: 0 });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(base + 91 * MIN) })).toMatchObject({ looked: 1 });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(base + 91 * MIN + 89 * MIN) })).toMatchObject({ looked: 0 });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(base + 91 * MIN + 91 * MIN) })).toMatchObject({ looked: 1 });
      // Past the days late evidence is looked for it is no longer asked about
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 36 * 24 * 60 * MIN) })).toMatchObject({ looked: 0 });
      expect(await prisma.instantRefund.count({ where: { runId: a, confirmedAt: null, releasedAt: { not: null } } })).toBe(1);
    });

    it('a give-back let go of that the books say they never made, when the limits now refuse a new one, keeps its intent so a refund they make afterwards is still recorded', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockImplementation((async () => ({ ok: false, refundedMicros: 0, reason: 'unavailable' })) as never);
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) })).toEqual({ looked: 1, settled: 0, released: 1 });
      // The books' first request was still in flight: their look finds nothing yet, and the limits no longer allow a new give-back
      await setLimits({ goodwillMaxMicros: null, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      f.funds.refundLookup.mockResolvedValueOnce({ status: 'none' });
      f.funds.refund.mockClear();
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 7 * 60 * MIN) })).toEqual({ looked: 1, settled: 0, released: 0 });
      expect(f.funds.refund).not.toHaveBeenCalled();
      const kept = await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } });
      expect(kept.confirmedAt).toBeNull();
      expect(kept.releasedAt).not.toBeNull();
      // That request then commits: the next look finds it, and it is recorded at their amount
      f.funds.refundLookup.mockResolvedValueOnce({ status: 'found', refundedMicros: 5_000 });
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 14 * 60 * MIN) })).toEqual({ looked: 1, settled: 1, released: 0 });
      expect((await prisma.instantRefund.findFirstOrThrow({ where: { runId: a } })).confirmedAt).not.toBeNull();
      expect(Number((await runOf(a)).refundedMicros)).toBe(5_000);
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
    });

    it('a give-back let go of that cannot be asked about is left as it is', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const a = await charged(f, p, 'a');
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockResolvedValue({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      await giveBack({ personId: sara, runId: a }, { funds: f.funds });
      await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) });
      f.funds.refundLookup.mockResolvedValueOnce({ status: 'unavailable' });
      f.funds.refund.mockClear();
      expect(await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN + 7 * 60 * MIN) })).toEqual({ looked: 1, settled: 0, released: 0 });
      expect(f.funds.refund).not.toHaveBeenCalled();
      expect(await prisma.instantRefund.count({ where: { runId: a, confirmedAt: null, releasedAt: { not: null } } })).toBe(1);
    });

    it('a row dropped and made again under the same key while the sweep waits on the books is not let go of by the sweep', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 5, unreachableWaitMinutes: 600 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      const { sweepGoodwill } = await import('@/lib/instant/executor');
      f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'unavailable' });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      const first = await prisma.instantRefund.findFirstOrThrow({ where: { runId } });
      // While the sweep asks the books, the row is dropped and a new one is made under the same key (a plain no, then a new ask)
      f.funds.refund.mockImplementationOnce((async () => {
        await prisma.instantRefund.delete({ where: { id: first.id } });
        await prisma.instantRefund.create({ data: { refundKey: first.refundKey, runId, personId: sara, kind: 'goodwill', amountMicros: BigInt(5_000) } });
        return { ok: false, refundedMicros: 0, reason: 'unavailable' };
      }) as never);
      const result = await sweepGoodwill({ funds: f.funds, now: new Date(Date.now() + 601 * MIN) });
      expect(result.released).toBe(0);
      const rows = await prisma.instantRefund.findMany({ where: { runId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].releasedAt).toBeNull();
    });

    it('when the books fail after they gave it back, the intent stays and a later ask finishes it at the books amount, even if the limits moved', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      // The books gave it back, then failed to answer
      const real = f.funds.refund.getMockImplementation()!;
      f.funds.refund.mockImplementationOnce((async (input: never) => {
        await real(input);
        throw new Error('connection reset');
      }) as never);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      const intent = await prisma.instantRefund.findFirstOrThrow({ where: { runId } });
      expect(intent.confirmedAt).toBeNull();
      expect(Number(intent.amountMicros)).toBe(5_000);
      // The limits moved down in between: the retry does not refuse it, the books already gave it
      await setLimits({ goodwillMaxMicros: 2_000, goodwillBudgetMicros: 3_000, goodwillPerPersonPerMonth: 1 });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'given', amountMicros: 5_000 });
      expect(await prisma.instantRefund.count({ where: { runId } })).toBe(1);
      expect((await prisma.instantRefund.findFirstOrThrow({ where: { runId } })).confirmedAt).not.toBeNull();
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
      // And only once
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'already_given' });
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
    });

    it('a plain no from the books is a decision: nothing was given, so no intent is left counting against the limits', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const runId = await charged(f, p);
      f.funds.refund.mockResolvedValueOnce({ ok: false, refundedMicros: 0, reason: 'budget' });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      expect(await prisma.instantRefund.count({ where: { runId } })).toBe(0);
    });
  });

  describe('existing sessions are read back before Instant can be switched on (test 9)', () => {
    // Only the connections these tests make count
    beforeEach(async () => {
      await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    });
    const connection = (name: string, url: string) =>
      prisma.appConnection.create({ data: { ownerId: sara, name, serverUrl: url, authType: 'none', source: 'ready_made', providerToolkit: name } as never });

    it('switches Instant off on a session that allows it, records it, and never touches one that is already off', async () => {
      const p = fakeProvider();
      const a = await connection(`a-${tag}`, 'https://backend.composio.dev/tool_router/trs_a/mcp');
      const b = await connection(`b-${tag}`, 'https://backend.composio.dev/tool_router/trs_b/mcp');
      p.instant.sessionInstant.mockImplementation((async (id: string) => (id === 'trs_a' ? 'allowed' : 'denied')) as never);
      const sweep = await denyInstantOnSessions(50, p.adapter);
      expect(sweep).toMatchObject({ checked: 2, denied: 1, alreadyDenied: 1, failed: 0, remaining: 0 });
      expect(p.instant.denySessionInstant).toHaveBeenCalledTimes(1);
      expect(p.instant.denySessionInstant).toHaveBeenCalledWith('trs_a');
      expect((await prisma.instantSessionCheck.findMany({ where: { connectionId: { in: [a.id, b.id] } } })).map((row) => row.state)).toEqual(['denied', 'denied']);
      // Checked sessions are not asked about again
      p.instant.sessionInstant.mockClear();
      expect((await denyInstantOnSessions(50, p.adapter)).checked).toBe(0);
      expect(p.instant.sessionInstant).not.toHaveBeenCalled();
    });

    it('a session that will not switch off stays unchecked and is looked at again, and a link that is not a session is counted as failed', async () => {
      const p = fakeProvider();
      await connection(`c-${tag}`, 'https://backend.composio.dev/tool_router/trs_c/mcp');
      await connection(`d-${tag}`, 'https://mcp.example/nothing/mcp');
      p.instant.sessionInstant.mockResolvedValue('allowed');
      p.instant.denySessionInstant.mockRejectedValueOnce(new Error('still allows'));
      const first = await denyInstantOnSessions(50, p.adapter);
      expect(first).toMatchObject({ checked: 0, denied: 0, failed: 2, remaining: 2 });
      const second = await denyInstantOnSessions(50, p.adapter);
      expect(second).toMatchObject({ checked: 1, denied: 1, failed: 1 });
    });

    it('rows that keep failing do not crowd out the rest: a failed row goes to the back of the line', async () => {
      const p = fakeProvider();
      await connection(`f1-${tag}`, 'https://backend.composio.dev/tool_router/trs_f1/mcp');
      await connection(`f2-${tag}`, 'https://backend.composio.dev/tool_router/trs_f2/mcp');
      await connection(`f3-${tag}`, 'https://backend.composio.dev/tool_router/trs_f3/mcp');
      const asked: string[] = [];
      p.instant.sessionInstant.mockImplementation((async (id: string) => {
        asked.push(id);
        if (id === 'trs_f1') throw new Error('provider down for this one');
        return 'denied';
      }) as never);
      // Whatever order the rows come in, the failing row is tried once, then the other two are reached before it is tried again
      for (let pass = 0; pass < 4; pass += 1) await denyInstantOnSessions(1, p.adapter);
      expect(asked.slice(0, 3).sort()).toEqual(['trs_f1', 'trs_f2', 'trs_f3']);
      expect(asked.filter((id) => id === 'trs_f1').length).toBeLessThanOrEqual(2);
      const rows = await prisma.instantSessionCheck.findMany({ where: { sessionId: { in: ['trs_f1', 'trs_f2', 'trs_f3'] } }, orderBy: { sessionId: 'asc' } });
      expect(rows.map((row) => row.state)).toEqual(['failed', 'denied', 'denied']);
    });

    it('a session whose check could not be saved is not counted as checked, denied or remaining-free', async () => {
      const p = fakeProvider();
      await connection(`g-${tag}`, 'https://backend.composio.dev/tool_router/trs_g/mcp');
      p.instant.sessionInstant.mockResolvedValue('allowed');
      p.instant.denySessionInstant.mockResolvedValue('denied' as never);
      const spy = jest.spyOn(prisma.instantSessionCheck, 'upsert').mockRejectedValueOnce(new Error('could not save'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await denyInstantOnSessions(50, p.adapter)).toMatchObject({ checked: 0, denied: 0, failed: 1, remaining: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('a session the provider no longer has is recorded as gone', async () => {
      const p = fakeProvider();
      await connection(`e-${tag}`, 'https://backend.composio.dev/tool_router/trs_e/mcp');
      p.instant.sessionInstant.mockResolvedValue('gone' as never);
      expect(await denyInstantOnSessions(50, p.adapter)).toMatchObject({ checked: 1, gone: 1 });
    });

    it('does nothing with an adapter that has no Instant side', async () => {
      await connection(`f-${tag}`, 'https://backend.composio.dev/tool_router/trs_f/mcp');
      expect(await denyInstantOnSessions(50, {} as ReadyMadeAdapter)).toMatchObject({ checked: 0 });
    });
  });

  describe('rules and receipts attach without touching the executor', () => {
    afterEach(() => setInstantHooks(undefined));

    it('a rule that says no refuses in its own words before anything is held or sent', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      setInstantHooks({ beforeRun: async () => ({ refuse: true, words: 'No more than $1 for this task.' }) });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: f.funds })).toEqual({ status: 'refused', reason: 'rule', words: 'No more than $1 for this task.' });
      expect(f.funds.reserve).not.toHaveBeenCalled();
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('a rule check that breaks stops the run: nothing runs on a rule nobody could read', async () => {
      await setLimits();
      const p = fakeProvider();
      setInstantHooks({ beforeRun: async () => { throw new Error('boom'); } });
      expect(await runInstant(ask(), { adapter: p.adapter, funds: fakeFunds(1_000_000).funds })).toMatchObject({ status: 'refused', reason: 'credit_unavailable' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('is told how every run ended, and a receipt hook that breaks changes nothing', async () => {
      await setLimits();
      const p = fakeProvider();
      const seen: string[] = [];
      setInstantHooks({ afterRun: async (_input, outcome) => { seen.push(outcome.status); throw new Error('receipt down'); } });
      expect((await runInstant(ask(), { adapter: p.adapter, funds: fakeFunds(1_000_000).funds })).status).toBe('done');
      expect(seen).toEqual(['done']);
    });
  });

  describe('findings from the code review: the edges of admission, settlement and clean-up', () => {
    const stuckRow = (over: Record<string, unknown> = {}) =>
      prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'held', customerState: 'held', providerUserId: `u-${randomUUID().slice(0, 6)}`, ...over } as never });
    /** Holds the books' answer to a reservation back until `open()`, as a slow books would. */
    function gatedReserve(f: ReturnType<typeof fakeFunds>) {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const real = f.funds.reserve.getMockImplementation()!;
      f.funds.reserve.mockImplementation((async (input: { key: string; amountMicros: number }) => {
        await gate;
        return real(input);
      }) as never);
      return open;
    }
    const waitForRuns = async (n: number) => {
      for (let i = 0; i < 200; i += 1) {
        if ((await prisma.instantRun.count({ where: { personId: sara } })) >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the run was never made');
    };

    it('two asks that arrive together under different call ids make one run, even while the first is only reserving', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const open = gatedReserve(f);
      setTimeout(open, 300);
      const both = await Promise.all([runInstant(ask(), { adapter: p.adapter, funds: f.funds }), runInstant(ask(), { adapter: p.adapter, funds: f.funds })]);
      expect(both.filter((r) => r.status === 'done')).toHaveLength(1);
      expect(both.filter((r) => r.status === 'refused' && r.reason === 'already_checking')).toHaveLength(1);
      expect(p.instant.run).toHaveBeenCalledTimes(1);
      expect(await prisma.instantRun.count({ where: { personId: sara } })).toBe(1);
    });

    it('looking an old run up at Composio never holds the admission lock: another ask goes through while that look-up waits', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      let letGo!: () => void;
      const hang = new Promise<InstantLog[]>((resolve) => (letGo = () => resolve([])));
      p.instant.findLogs.mockImplementation((() => hang) as never);
      await prisma.instantRun.updateMany({ where: { personId: sara }, data: { state: 'ambiguous', sentAt: new Date(Date.now() - 600 * MIN) } });
      // The race the lock-held look-up needs: the early lookup (no lock) misses, and only the locked lookup finds the run
      // (and the unlocked same-ask checks miss too), so the run is first seen under the lock
      const early = jest.spyOn(prisma.instantRun, 'findUnique').mockResolvedValueOnce(null as never);
      const twins = jest.spyOn(prisma.instantRun, 'findFirst').mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
      p.instant.findLogs.mockClear();
      const asking = runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      try {
        // Wait for the look-up itself to start (not a guessed delay): only then is the overlap the test is about really there
        for (let i = 0; i < 200 && p.instant.findLogs.mock.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(p.instant.findLogs).toHaveBeenCalled();
        const other = await Promise.race([runInstant(ask({ arguments: { query: 'something else' } }), { adapter: p.adapter, funds: f.funds }), new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 5_000))]);
        expect(early).toHaveBeenCalled();
        expect(other).not.toBe('stuck');
        expect(other).toMatchObject({ status: 'done' });
      } finally {
        letGo();
        try {
          await asking;
        } finally {
          early.mockRestore();
          twins.mockRestore();
        }
      }
    });

    it('a reservation that comes back after the clean-up closed the run is never sent, and its hold is given back', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const open = gatedReserve(f);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      // The clean-up got there first: closed the run as one that never went out
      await prisma.instantRun.update({ where: { id: row.id }, data: { state: 'refused', reason: 'unclear', finishedAt: new Date(), customerState: 'none', providerState: 'none' } });
      open();
      const outcome = await pending;
      expect(outcome).toMatchObject({ status: 'refused' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.funds.release).toHaveBeenCalledWith({ key: `instant:${row.id}` });
      expect(await runOf(row.id)).toMatchObject({ state: 'refused', customerState: 'none' });
      expect(f.left()).toBe(1_000_000);
    });

    it('a reservation that comes back while the clean-up is still working waits for it, and finds the run closed: never sent', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const open = gatedReserve(f);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      await prisma.instantRun.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 100 * MIN) } });
      // The clean-up reads the run and asks the books to release, which takes a while
      let openRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => (openRelease = resolve));
      f.funds.release.mockImplementation((async () => {
        await releaseGate;
        return { ok: true, none: true };
      }) as never);
      const cleaning = reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      for (let i = 0; i < 200 && f.funds.release.mock.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.funds.release).toHaveBeenCalled();
      // The reservation answer arrives in the middle of the clean-up
      open();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(p.instant.run).not.toHaveBeenCalled();
      openRelease();
      await cleaning;
      const outcome = await pending;
      expect(outcome).toMatchObject({ status: 'refused' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(await runOf(row.id)).toMatchObject({ state: 'refused' });
    });

    it('even when the clean-up fails right after the books released the hold, a delayed reservation finds the run closed and Composio is never called', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      // The books take the reservation (the hold exists) but its answer is slow to come back
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const real = f.funds.reserve.getMockImplementation()!;
      f.funds.reserve.mockImplementation((async (input: { key: string; amountMicros: number }) => {
        const answer = await real(input);
        await gate;
        return answer;
      }) as never);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      for (let i = 0; i < 200 && !f.holds.has(`instant:${row.id}`); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('held');
      await prisma.instantRun.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 100 * MIN) } });
      // The clean-up closes the run and the books really give the hold back; then writing that down here fails
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION instant_test_refuse_release() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'database went away'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER instant_test_refuse_release BEFORE UPDATE ON instant_runs FOR EACH ROW WHEN (NEW.customer_state = 'released') EXECUTE FUNCTION instant_test_refuse_release()`);
      try {
        await expect(reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() })).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS instant_test_refuse_release ON instant_runs');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS instant_test_refuse_release()');
      }
      // The hold is given back in the books, and the run was closed before they were asked, so the failure did not reopen it
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('released');
      expect(await runOf(row.id)).toMatchObject({ state: 'refused' });
      // The delayed reservation answer now arrives: the run is closed, so nothing goes out
      open();
      expect(await pending).toMatchObject({ status: 'refused' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('released');
      expect(f.left()).toBe(1_000_000);
    });

    it('a hold that reached the books after the run was closed, and cannot be released at once, is kept marked and given back by the sweep', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const open = gatedReserve(f);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      await prisma.instantRun.update({ where: { id: row.id }, data: { state: 'refused', reason: 'unclear', finishedAt: new Date(), customerState: 'none', providerState: 'none' } });
      f.state.releaseOk = false;
      open();
      expect(await pending).toMatchObject({ status: 'refused' });
      expect(p.instant.run).not.toHaveBeenCalled();
      // The hold is in the books and the release was not taken: the run says it still holds
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('held');
      expect(await runOf(row.id)).toMatchObject({ state: 'refused', customerState: 'held' });
      f.state.releaseOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('released');
      expect(await runOf(row.id)).toMatchObject({ state: 'refused', customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
    });

    it('a reservation that commits in the books and then fails, with the release failing too, still leaves the closed run marked as holding for the sweep', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const real = f.funds.reserve.getMockImplementation()!;
      f.funds.reserve.mockImplementation((async (input: { key: string; amountMicros: number }) => {
        await gate;
        await real(input);
        throw new Error('connection reset');
      }) as never);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      await prisma.instantRun.update({ where: { id: row.id }, data: { state: 'refused', reason: 'unclear', finishedAt: new Date(), customerState: 'none', providerState: 'none' } });
      f.state.releaseOk = false;
      open();
      expect(await pending).toMatchObject({ status: 'refused' });
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('held');
      expect(await runOf(row.id)).toMatchObject({ state: 'refused', customerState: 'held' });
      f.state.releaseOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(f.holds.get(`instant:${row.id}`)?.state).toBe('released');
      expect(f.left()).toBe(1_000_000);
    });

    it('books that close a key on "nothing held" refuse the late reservation, so no hold is ever created after the clean-up closed the run', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const closed = new Set<string>();
      const realReserve = f.funds.reserve.getMockImplementation()!;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      f.funds.reserve.mockImplementation((async (input: { key: string; amountMicros: number }) => {
        await gate;
        if (closed.has(input.key)) return { ok: false, reason: 'unavailable' };
        return realReserve(input);
      }) as never);
      f.funds.release.mockImplementation((async (input: { key: string }) => {
        closed.add(input.key);
        return { ok: true, none: true };
      }) as never);
      const pending = runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      await waitForRuns(1);
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      await prisma.instantRun.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 100 * MIN) } });
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await runOf(row.id)).toMatchObject({ state: 'refused' });
      open();
      expect(await pending).toMatchObject({ status: 'refused' });
      expect(p.instant.run).not.toHaveBeenCalled();
      expect(f.holds.has(`instant:${row.id}`)).toBe(false);
      expect(f.left()).toBe(1_000_000);
    });

    it('the clean-up closes the run for good BEFORE it asks the books to release: nothing can send it while, or after, a release goes through', async () => {
      await setLimits({ sentWaitMinutes: 5 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const stuck = await stuckRow({ state: 'held', customerState: 'held', createdAt: new Date(Date.now() - 100 * MIN) });
      f.holds.set(`instant:${stuck.id}`, { amount: TOP, state: 'held', charged: 0 });
      let openRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => (openRelease = resolve));
      const real = f.funds.release.getMockImplementation()!;
      f.funds.release.mockImplementation((async (input: { key: string }) => {
        // In the middle of the release the run is already closed, and committed as such: a rollback later cannot reopen it
        expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'held' });
        await releaseGate;
        return real(input);
      }) as never);
      const cleaning = reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      for (let i = 0; i < 200 && f.funds.release.mock.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.funds.release).toHaveBeenCalled();
      // Nothing can move it on any more, even though the hold is still in the books
      expect(await prisma.instantRun.updateMany({ where: { id: stuck.id, state: 'held' }, data: { state: 'sent' } })).toMatchObject({ count: 0 });
      openRelease();
      await cleaning;
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'released' });
      expect(f.holds.get(`instant:${stuck.id}`)?.state).toBe('released');
    });

    it('a settlement the books took, whose confirmation was then lost, is recorded on the retry at the books amount, and the person is charged once', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      await prisma.instantRun.update({ where: { id: row.id }, data: { sentAt: new Date(Date.now() - 600 * MIN) } });
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', 7_000, 'log-roll')]);
      p.script.logs.set('log-roll', p.line(row.providerUserId, 'success', 7_000, 'log-roll'));
      // The books take the charge, and writing it down here fails once (the step that records it, in the database, is refused)
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION instant_test_lost_write() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'database went away'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER instant_test_lost_write BEFORE UPDATE ON instant_runs FOR EACH ROW WHEN (NEW.customer_state = 'charged') EXECUTE FUNCTION instant_test_lost_write()`);
      try {
        await expect(reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() })).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS instant_test_lost_write ON instant_runs');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS instant_test_lost_write()');
      }
      expect(f.holds.get(`instant:${row.id}`)).toMatchObject({ state: 'charged', charged: 7_000 });
      expect(await runOf(row.id)).toMatchObject({ state: 'succeeded', providerState: 'settled', customerState: 'held' });
      // The retry asks again, the books answer with the first amount, and that is what is recorded
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const after = await runOf(row.id);
      expect(after).toMatchObject({ customerState: 'charged' });
      expect(Number(after.customerMicros)).toBe(7_000);
      expect(f.holds.get(`instant:${row.id}`)).toMatchObject({ state: 'charged', charged: 7_000 });
    });

    it('the credit books are never asked from inside a database transaction', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      // A transaction that is open holds a connection; the books (which use their own) must never be waited on while one is
      let open = 0;
      const realTx = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => {
        if (typeof fn !== 'function') return realTx(fn, ...rest);
        return realTx(async (...inner: unknown[]) => {
          open += 1;
          try {
            return await (fn as (...a: unknown[]) => Promise<unknown>)(...inner);
          } finally {
            open -= 1;
          }
        }, ...rest);
      }) as never);
      const seen: number[] = [];
      for (const name of ['reserve', 'settle', 'release'] as const) {
        const impl = f.funds[name].getMockImplementation()!;
        f.funds[name].mockImplementation((async (input: never) => {
          seen.push(open);
          return impl(input);
        }) as never);
      }
      try {
        await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
        p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'x', logId: 'l', chargeMicros: null });
        await runInstant(ask({ arguments: { query: 'second' } }), { adapter: p.adapter, funds: f.funds });
      } finally {
        spy.mockRestore();
      }
      expect(seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.every((n) => n === 0)).toBe(true);
    });

    it('a yes from the books without the amount charged is not taken as done: the run stays held and is asked again', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.settle.mockResolvedValueOnce({ ok: true } as never);
      await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row.customerState).toBe('held');
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await runOf(row.id)).toMatchObject({ customerState: 'charged' });
      expect(Number((await runOf(row.id)).customerMicros)).toBe(7_000);
    });

    it('a give-back the books already made is finished even when the goodwill limits were cleared afterwards', async () => {
      await setLimits({ goodwillMaxMicros: 5_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const runId = await runIdOf(id);
      const real = f.funds.refund.getMockImplementation()!;
      f.funds.refund.mockImplementationOnce((async (input: never) => {
        await real(input);
        throw new Error('connection reset');
      }) as never);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'unavailable' });
      await setLimits({ goodwillMaxMicros: 0, goodwillBudgetMicros: 0, goodwillPerPersonPerMonth: 0 });
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'given', amountMicros: 5_000 });
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
      // A NEW give-back is still stopped by the cleared limits
      const other = callId();
      p.script.runs.push({ kind: 'done', successful: true, data: { hits: 1 }, error: null, logId: 'log-x', chargeMicros: 7_000 });
      await runInstant(ask({ callId: other, arguments: { query: 'another' } }), { adapter: p.adapter, funds: f.funds });
      expect(await giveBack({ personId: sara, runId: await runIdOf(other) }, { funds: f.funds })).toEqual({ status: 'refused', reason: 'not_set' });
    });

    it('a settlement the books took before, and this side never recorded, is recorded at the books first amount, not at today\'s figure', async () => {
      await setLimits({ markupBps: 1_000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.settleOk = false;
      await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row.customerState).toBe('held');
      // The books did take it earlier, at 6,000, and the answer never got back
      const hold = f.holds.get(`instant:${row.id}`)!;
      hold.state = 'charged';
      hold.charged = 6_000;
      f.state.settleOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await runOf(row.id)).toMatchObject({ customerState: 'charged' });
      expect(Number((await runOf(row.id)).customerMicros)).toBe(6_000);
    });

    it('our exposure counts each run once: open ones at the top price, settled ones at their charge', async () => {
      const open = await stuckRow({ state: 'sent', providerState: 'pending', topMicros: BigInt(10_000) });
      await stuckRow({ state: 'succeeded', customerState: 'charged', providerState: 'settled', providerMicros: BigInt(3_000), finishedAt: new Date(), topMicros: BigInt(10_000) });
      await stuckRow({ state: 'refused', customerState: 'none', providerState: 'none', topMicros: BigInt(10_000) });
      expect(await exposureIn(prisma, new Date())).toBe(13_000);
      await prisma.instantRun.update({ where: { id: open.id }, data: { state: 'failed', providerState: 'settled', providerMicros: BigInt(2_000), finishedAt: new Date() } });
      expect(await exposureIn(prisma, new Date())).toBe(5_000);
    });

    it('a tool that failed but reported a charge records that charge at once, and the person is still not charged', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-c', chargeMicros: 38_000 });
      expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'failed', reason: 'provider_failed' });
      const row = await runOf(await runIdOf(id));
      expect(row).toMatchObject({ state: 'failed', customerState: 'released', providerState: 'settled', providerBasis: 'measured' });
      expect(Number(row.providerMicros)).toBe(38_000);
      expect(f.funds.settle).not.toHaveBeenCalled();
      expect(f.left()).toBe(1_000_000);
      // Above the top price: the table is too low, so Instant stops
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'price_over_top' });
    });

    it('a tool that failed with a charge only in its log is settled from that log at once', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      p.script.logs.set('log-d', p.line('u', 'failed', 3_000, 'log-d'));
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-d', chargeMicros: null });
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const row = await runOf(await runIdOf(id));
      expect(row).toMatchObject({ state: 'failed', providerState: 'settled', providerBasis: 'measured' });
      expect(Number(row.providerMicros)).toBe(3_000);
    });

    it('a settlement said again after the markup changed asks the books for the same amount as the first time', async () => {
      await setLimits({ markupBps: 1_000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.settleOk = false;
      await runInstant(ask(), { adapter: p.adapter, funds: f.funds });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row.markupBps).toBe(1_000);
      await setLimits({ markupBps: 5_000 });
      f.state.settleOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const asked = f.funds.settle.mock.calls.map((call) => call[0].chargeMicros);
      expect(asked.length).toBeGreaterThanOrEqual(2);
      expect(new Set(asked)).toEqual(new Set([7_700]));
      expect(Number((await runOf(row.id)).customerMicros)).toBe(7_700);
    });

    it('a run whose reservation was never answered is closed but kept marked as holding on a plain "no", and cleared only when the books confirm nothing is held', async () => {
      await setLimits({ sentWaitMinutes: 5, unclearWaitMinutes: 10 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const stuck = await stuckRow({ state: 'reserving', customerState: 'none', createdAt: new Date(Date.now() - 1_000 * MIN) });
      f.funds.release.mockImplementation((async () => ({ ok: false })) as never);
      await reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'held' });
      f.funds.release.mockImplementation((async () => ({ ok: false, none: true })) as never);
      await reconcileRun(stuck.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await runOf(stuck.id)).toMatchObject({ state: 'refused', customerState: 'released' });
    });

    it('a give-back the books made before and say again is recorded at the amount they say, not at today\'s limit', async () => {
      await setLimits({ goodwillMaxMicros: 2_000, goodwillBudgetMicros: 100_000, goodwillPerPersonPerMonth: 3 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      const runId = await runIdOf(id);
      f.state.refunds.set(`goodwill:${runId}`, 5_000);
      expect(await giveBack({ personId: sara, runId }, { funds: f.funds })).toEqual({ status: 'given', amountMicros: 5_000 });
      expect(Number((await runOf(runId)).refundedMicros)).toBe(5_000);
      expect(Number((await prisma.instantRefund.findFirstOrThrow({ where: { runId } })).amountMicros)).toBe(5_000);
    });

    it('the sweep goes oldest attempt first, so runs that cannot be settled never keep the later ones from being tried', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const recent = new Date(Date.now() - 2 * MIN);
      const base = Date.now() - 600 * MIN;
      await prisma.instantRun.createMany({
        data: Array.from({ length: 51 }, (_, i) => ({ runKey: `sw-${tag}-${i}`, botId: brick, personId: sara, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: `sw-${i}`, priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'sent', customerState: 'held', providerState: 'pending', sentAt: new Date(), providerUserId: `sw-${i}`, createdAt: new Date(base + i * 1_000), checkedAt: i < 50 ? recent : null })) as never,
      });
      const started = Date.now();
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const last = await prisma.instantRun.findUniqueOrThrow({ where: { runKey: `sw-${tag}-50` } });
      expect(last.checkedAt && last.checkedAt.getTime() >= started).toBe(true);
    });

    it('a price check that could not finish is tried again by the next sweep, and one that finished is not repeated for hours', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.instant.tool.mockImplementation((async () => {
        throw new Error('down');
      }) as never);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const afterFirst = p.instant.tool.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(p.instant.tool.mock.calls.length).toBe(afterFirst * 2);
      const { instantListedPrices } = await import('@/lib/instant/values');
      const listed = new Map(instantListedPrices().map((row) => [row.tool, row.listed]));
      p.instant.tool.mockImplementation((async (slug: string) => ({ slug, toolkit: 'x', description: null, inputSchema: null, instantSupported: true, priceWords: listed.get(slug) ?? null })) as never);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      const afterGood = p.instant.tool.mock.calls.length;
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(p.instant.tool.mock.calls.length).toBe(afterGood);
    });
  });

  describe('the route', () => {
    const post = (body: unknown, token: string | null = SERVICE_TOKEN) =>
      runRoute(new NextRequest('http://localhost/api/instant/run', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));

    it('needs the service token', async () => {
      expect((await post({}, null)).status).toBe(401);
      expect((await post({}, 'wrong')).status).toBe(401);
    });

    it('answers 404 to anyone but the Brick owner, and a fixed word for a refusal', async () => {
      await setLimits();
      const p = fakeProvider();
      setAdapterForTests(p.adapter);
      expect((await post({ botId: brick, forOwner: false, requesterKey: `omar-${tag}`, tool: 'EXA_SEARCH', arguments: { query: 'x' }, callId: callId() })).status).toBe(404);
      expect((await post({ botId: brick, tool: 'EXA_SEARCH', arguments: { query: 'x' }, callId: callId() })).status).toBe(404);
      const refused = await post({ botId: brick, forOwner: true, tool: 'EXA_SEARCH', arguments: { query: 'x' }, callId: callId() });
      expect(refused.status).toBe(200);
      // No credit source is wired in this test: the shut door
      expect(await refused.json()).toMatchObject({ status: 'refused', reason: 'credit_unavailable', message: 'I cannot read your credit right now, so nothing ran.' });
      expect(p.instant.run).not.toHaveBeenCalled();
    });

    it('rejects a body with anything extra', async () => {
      expect((await post({ botId: brick, forOwner: true, tool: 'EXA_SEARCH', callId: callId(), price: 0 })).status).toBe(400);
    });
  });

  describe('rules and receipts wired in (O4)', () => {
    beforeEach(() => setInstantHooks(instantRulesAndReceipts));
    afterEach(async () => {
      setInstantHooks(undefined);
      await prisma.spendRule.deleteMany({ where: { ownerPersonId: sara } });
      await prisma.taskReceipt.deleteMany({ where: { personId: sara } });
    });
    const post = (body: unknown) =>
      runRoute(new NextRequest('http://localhost/api/instant/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` }, body: JSON.stringify(body) }));

    it('a credit door that says a rule forbids the hold refuses in the rule’s words, final, with the task kept on the run', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.funds.reserve.mockResolvedValueOnce({ ok: false, reason: 'rule', ruleId: 'r0', why: 'cap', words: 'No more than $1 a month for this Brick.', leftMicros: 0 } as never);
      const outcome = await runInstant(ask({ taskKey: 'task-a' }), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'rule', words: 'No more than $1 a month for this Brick.' });
      expect(f.funds.reserve).toHaveBeenCalledWith(expect.objectContaining({ taskKey: 'task-a' }));
      expect(p.instant.run).not.toHaveBeenCalled();
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      expect(row).toMatchObject({ state: 'refused', reason: 'rule', taskKey: 'task-a', customerState: 'none' });
    });

    it('a rule the owner said refuses before a run is made, only for the task it is about, and says it plainly through the route with a stop', async () => {
      await setLimits();
      const p = fakeProvider();
      setAdapterForTests(p.adapter);
      const f = fakeFunds(1_000_000);
      setInstantFunds(f.funds);
      const made = await proposeRule({ botId: brick, speakerId: sara, scope: 'task', taskKey: 'task-x', period: 'task', capMicros: 1 });
      expect(made.ok).toBe(true);
      const refused = await post({ botId: brick, forOwner: true, tool: 'EXA_SEARCH', arguments: { query: 'x' }, callId: callId(), taskKey: 'task-x' });
      const body = await refused.json();
      expect(body).toMatchObject({ status: 'refused', reason: 'rule', stop: true, runId: null });
      expect(body.message).toContain('No more than');
      expect(f.funds.reserve).not.toHaveBeenCalled();
      expect(await prisma.instantRun.count({ where: { personId: sara } })).toBe(0);
      // Another task, and a call that belongs to no task, are not that rule's
      const other = await post({ botId: brick, forOwner: true, tool: 'EXA_SEARCH', arguments: { query: 'y' }, callId: callId(), taskKey: 'task-y' });
      expect(await other.json()).toMatchObject({ status: 'done' });
      const none = await post({ botId: brick, forOwner: true, tool: 'EXA_SEARCH', arguments: { query: 'z' }, callId: callId() });
      expect(await none.json()).toMatchObject({ status: 'done' });
    });

    it('a run for a task puts its charge on that task: the task’s receipt shows what the person was charged, not what Composio charged us', async () => {
      await setLimits({ markupBps: 5_000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-r', title: 'Find the weather', category: 'apps' });
      const outcome = await runInstant(ask({ taskKey: 'task-r' }), { adapter: p.adapter, funds: f.funds });
      expect(outcome.status).toBe('done');
      await closeReceipt({ botId: brick, taskKey: 'task-r', personId: sara, state: 'done' });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      const charged = Number(row.customerMicros);
      expect(charged).toBeGreaterThan(7_000);
      const [item] = await activityFor(sara);
      expect(item).toMatchObject({ title: 'Find the weather', state: 'done', category: 'apps', spentMicros: charged, lines: [{ label: 'Instant Apps, 1 use', amountMicros: charged }] });
    });

    it('a run that failed puts a zero on the meter event as what the person was charged (not "not known"), so the receipt does not wait for a price', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-f', title: 'Find the weather', category: 'apps' });
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-g', chargeMicros: 4_000 });
      const outcome = await runInstant(ask({ callId: id, taskKey: 'task-f' }), { adapter: p.adapter, funds: f.funds });
      expect(outcome).toMatchObject({ status: 'failed', reason: 'provider_failed' });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      const event = await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `instant:${row.id}` } });
      expect(event.detail).toMatchObject({ instant: true, taskKey: 'task-f', customerMicros: 0 });
      expect(Number(event.costMicros)).toBe(4_000);
    });

    it('a run Composio refused before anything ran also records a zero charge on its meter event', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      p.script.runs.push({ kind: 'rejected', status: 403, code: 'ManagedCredential_NotEnabled' });
      expect(await runInstant(ask({ taskKey: 'task-j' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'failed' });
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      const event = await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `instant:${row.id}` } });
      expect(event.detail).toMatchObject({ instant: true, taskKey: 'task-j', customerMicros: 0 });
    });

    it('asking again with the same call id after a rule refused it says the rule’s own words, not a general sentence', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const id = callId();
      f.funds.reserve.mockResolvedValueOnce({ ok: false, reason: 'rule', ruleId: 'r1', why: 'cap', words: 'No more than $1 a month for this Brick.', leftMicros: 250 } as never);
      expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'rule', words: 'No more than $1 a month for this Brick.' });
      const again = await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds });
      expect(again).toMatchObject({ status: 'refused', reason: 'rule', words: 'No more than $1 a month for this Brick.', leftMicros: 250 });
      expect(f.funds.reserve).toHaveBeenCalledTimes(1);
    });

    it('a run whose answer did not come back reopens the receipt of the task SAVED on the run when the bot server had already ended it: a call with no task, and a retry naming another task, touch nothing', async () => {
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-c', title: 'Find the weather', category: 'apps' });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-other', title: 'Another task', category: 'apps' });
      const mk = (taskKey: string | null) =>
        prisma.instantRun.create({ data: { runKey: `k-${randomUUID()}`, botId: brick, personId: sara, taskKey, toolSlug: 'EXA_SEARCH', toolkit: 'exa', argsHash: 'h', priceVersion: 'v', topMicros: BigInt(TOP), holdMicros: BigInt(TOP), state: 'ambiguous', customerState: 'held', providerUserId: `u-${randomUUID().slice(0, 6)}` } as never });
      const withTask = await mk('task-c');
      const noTask = await mk(null);
      const state = async (taskKey: string) => (await prisma.taskReceipt.findFirstOrThrow({ where: { personId: sara, taskKey } })).state;
      const input = { botId: brick, personId: sara, tool: 'EXA_SEARCH', arguments: {}, callId: 'c1', taskKey: 'task-c' };
      // The bot server has ended both tasks (done)
      await prisma.taskReceipt.updateMany({ where: { personId: sara, taskKey: { in: ['task-c', 'task-other'] } }, data: { state: 'done', endedAt: new Date() } });
      await instantRulesAndReceipts.afterRun?.({ ...input, taskKey: null }, { status: 'checking', runId: noTask.id });
      expect(await state('task-c')).toBe('done');
      await instantRulesAndReceipts.afterRun?.(input, { status: 'done', runId: withTask.id, ok: true, data: {}, chargedMicros: 1, pending: false });
      expect(await state('task-c')).toBe('done');
      // A retry of the same call that names another task: the run's own task is the one that moves
      await instantRulesAndReceipts.afterRun?.({ ...input, taskKey: 'task-other' }, { status: 'checking', runId: withTask.id });
      expect(await state('task-c')).toBe('checking');
      expect(await state('task-other')).toBe('done');
      // A task the bot server has not ended is never ended by a run: it keeps running
      await prisma.taskReceipt.updateMany({ where: { personId: sara, taskKey: 'task-c' }, data: { state: 'running', endedAt: null } });
      await instantRulesAndReceipts.afterRun?.(input, { status: 'checking', runId: withTask.id });
      expect(await state('task-c')).toBe('running');
      await prisma.instantRun.deleteMany({ where: { id: { in: [withTask.id, noTask.id] } } });
    });

    it('an Instant run that names its task is that task’s only: a receipt that merely carries the run id does not show its charge too', async () => {
      await setLimits({ markupBps: 5_000 });
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      expect((await runInstant(ask({ taskKey: 'task-b' }), { adapter: p.adapter, funds: f.funds })).status).toBe('done');
      const row = await prisma.instantRun.findFirstOrThrow({ where: { personId: sara } });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-a', title: 'Not its task', category: 'apps', runId: row.id });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'task-b', title: 'Its task', category: 'apps' });
      await closeReceipt({ botId: brick, taskKey: 'task-a', personId: sara, state: 'done' });
      await closeReceipt({ botId: brick, taskKey: 'task-b', personId: sara, state: 'done' });
      const items = await activityFor(sara);
      expect(items.find((item) => item.title === 'Its task')).toMatchObject({ spentMicros: Number(row.customerMicros) });
      expect(items.find((item) => item.title === 'Not its task')).toMatchObject({ spentMicros: null, lines: [] });
    });
  });

  describe('a task’s receipt follows its runs: a task being looked up is not listed, and it ends by itself', () => {
    beforeEach(() => setInstantHooks(instantRulesAndReceipts));
    afterEach(() => setInstantHooks(undefined));

    const unclearRun = async (p: ReturnType<typeof fakeProvider>, f: ReturnType<typeof fakeFunds>, taskKey: string, query: string) => {
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'timeout', status: null });
      expect(await runInstant(ask({ callId: id, taskKey, arguments: { query } }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'checking' });
      return runOf(await runIdOf(id));
    };
    const receiptState = async (taskKey: string) => (await prisma.taskReceipt.findFirstOrThrow({ where: { personId: sara, taskKey } })).state;

    it('while a run is unclear the task is not listed; a log that says it failed ends the receipt as refunded, nothing taken', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-1', title: 'Find the flight', category: 'apps' });
      const row = await unclearRun(p, f, 'look-1', 'flight');
      // The task is still running: its receipt is not listed and Orbit does not end it
      expect(await receiptState('look-1')).toBe('running');
      expect(await closeReceipt({ botId: brick, taskKey: 'look-1', personId: sara, state: 'done' })).toMatchObject({ ok: true, state: 'checking' });
      expect(await receiptState('look-1')).toBe('checking');
      expect((await activityFor(sara)).map((item) => item.title)).not.toContain('Find the flight');
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'failed', null)]);
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await receiptState('look-1')).toBe('refunded');
      const [item] = await activityFor(sara);
      expect(item).toMatchObject({ title: 'Find the flight', state: 'refunded', spentMicros: null });
      // Said again, by the sweep or by anyone, it changes nothing
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await receiptState('look-1')).toBe('refunded');
      expect(f.left()).toBe(1_000_000);
    });

    it('a log that says it worked ends the receipt as done, with what the person was charged', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-2', title: 'Find the weather', category: 'apps' });
      const row = await unclearRun(p, f, 'look-2', 'weather');
      // The task is still running: its receipt is not listed and Orbit does not end it
      expect(await receiptState('look-2')).toBe('running');
      expect(await closeReceipt({ botId: brick, taskKey: 'look-2', personId: sara, state: 'done' })).toMatchObject({ ok: true, state: 'checking' });
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', 7_000)]);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await receiptState('look-2')).toBe('done');
      const charged = Number((await runOf(row.id)).customerMicros);
      expect(charged).toBeGreaterThan(0);
      expect((await activityFor(sara))[0]).toMatchObject({ state: 'done', spentMicros: charged });
    });

    it('when nobody can vouch for it by the deadline, the receipt ends in the person’s favour: refunded, nothing taken', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-3', title: 'Find the hotel', category: 'apps' });
      const row = await unclearRun(p, f, 'look-3', 'hotel');
      // The task is still running: its receipt is not listed and Orbit does not end it
      expect(await receiptState('look-3')).toBe('running');
      expect(await closeReceipt({ botId: brick, taskKey: 'look-3', personId: sara, state: 'done' })).toMatchObject({ ok: true, state: 'checking' });
      await sweepInstant({ funds: f.funds, adapter: p.adapter });
      expect(await receiptState('look-3')).toBe('checking');
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: new Date(Date.now() + 24 * 60 * MIN) });
      expect(await runOf(row.id)).toMatchObject({ state: 'failed', reason: 'unclear', customerState: 'released' });
      expect(await receiptState('look-3')).toBe('refunded');
      expect((await activityFor(sara))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('one finished run does not end a task that has another still unclear; the last one to end does', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-4', title: 'Two lookups', category: 'apps' });
      const first = await unclearRun(p, f, 'look-4', 'one');
      const second = await unclearRun(p, f, 'look-4', 'two');
      await closeReceipt({ botId: brick, taskKey: 'look-4', personId: sara, state: 'done' });
      p.script.byUser.set(first.providerUserId, [p.line(first.providerUserId, 'failed', null)]);
      await reconcileRun(first.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect((await runOf(first.id)).state).toBe('failed');
      expect(await receiptState('look-4')).toBe('checking');
      expect((await activityFor(sara)).map((item) => item.title)).not.toContain('Two lookups');
      p.script.byUser.set(second.providerUserId, [p.line(second.providerUserId, 'success', 7_000)]);
      await reconcileRun(second.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      // One worked, so the task is done (what it took is read from the books)
      expect(await receiptState('look-4')).toBe('done');
    });

    it('a task still running is never ended by a run: an unclear run that fails leaves it running, and a later run and the bot server’s close still count', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-8', title: 'Two tries', category: 'apps' });
      const first = await unclearRun(p, f, 'look-8', 'try1');
      p.script.byUser.set(first.providerUserId, [p.line(first.providerUserId, 'failed', null)]);
      await reconcileRun(first.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect((await runOf(first.id)).state).toBe('failed');
      expect(await receiptState('look-8')).toBe('running');
      // The task goes on and a second run works; the bot server then ends the task
      expect((await runInstant(ask({ taskKey: 'look-8', arguments: { query: 'try2' } }), { adapter: p.adapter, funds: f.funds })).status).toBe('done');
      expect(await closeReceipt({ botId: brick, taskKey: 'look-8', personId: sara, state: 'done' })).toMatchObject({ ok: true, state: 'done' });
      const item = (await activityFor(sara)).find((one) => one.title === 'Two tries');
      expect(item).toMatchObject({ state: 'done' });
      expect(item?.spentMicros).toBeGreaterThan(0);
    });

    it('a done word from the bot server that comes before the lookup ends does not freeze the receipt: the settling still moves it', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-5', title: 'Find the weather', category: 'apps' });
      const row = await unclearRun(p, f, 'look-5', 'weather5');
      expect(await closeReceipt({ botId: brick, taskKey: 'look-5', personId: sara, state: 'done', chargedMicros: 10 })).toMatchObject({ ok: true, state: 'checking' });
      expect(await receiptState('look-5')).toBe('checking');
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'failed', null)]);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await receiptState('look-5')).toBe('refunded');
      // And the other order: the receipt was closed first, then a run turned out unclear: it is reopened until that run settles
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-6', title: 'Another', category: 'apps' });
      await closeReceipt({ botId: brick, taskKey: 'look-6', personId: sara, state: 'done' });
      const late = await unclearRun(p, f, 'look-6', 'weather6');
      expect(await receiptState('look-6')).toBe('checking');
      p.script.byUser.set(late.providerUserId, [p.line(late.providerUserId, 'success', 7_000)]);
      await reconcileRun(late.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await receiptState('look-6')).toBe('done');
    });

    it('a receipt the bot server left in checking with no Instant run (its request never arrived) is refunded after the grace, not listed (nothing happened); one with books for its key is done and listed; a young one is left alone', async () => {
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-9', title: 'Never arrived', category: 'apps' });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-10', title: 'Has books', category: 'apps' });
      for (const key of ['look-9', 'look-10']) expect(await closeReceipt({ botId: brick, taskKey: key, personId: sara, state: 'checking' })).toMatchObject({ ok: true, state: 'checking' });
      await prisma.meterEvent.create({
        data: { eventId: `look-10-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(1000), basis: 'measured', detail: { instant: true, taskKey: 'look-10' } },
      });
      // Not yet: the request may still arrive
      await settleCheckingReceipts(50, new Date(Date.now() + 60 * 1000));
      expect(await receiptState('look-9')).toBe('checking');
      expect((await activityFor(sara)).map((item) => item.title)).not.toContain('Never arrived');
      await settleCheckingReceipts(50, new Date(Date.now() + 20 * MIN));
      expect(await receiptState('look-9')).toBe('refunded');
      expect(await receiptState('look-10')).toBe('done');
      const titles = (await activityFor(sara)).map((item) => item.title);
      expect(titles).not.toContain('Never arrived');
      expect(titles).toContain('Has books');
    });

    it('an Apps task every request of which was refused before it ran is not listed, however it ended; one that ran and failed, or that has books for its key, still is', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      // Refused by the credit door: a run row that went nowhere, nothing in the books
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-1', title: 'Refused by a rule', category: 'apps' });
      f.funds.reserve.mockResolvedValueOnce({ ok: false, reason: 'rule', ruleId: 'r0', why: 'cap', words: 'No more than $1 a month for this Brick.', leftMicros: 0 } as never);
      expect(await runInstant(ask({ taskKey: 'hide-1' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'refused', reason: 'rule' });
      await closeReceipt({ botId: brick, taskKey: 'hide-1', personId: sara, state: 'refunded' });
      // Refused before any run was made: no run row at all
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-2', title: 'No run made', category: 'apps' });
      await closeReceipt({ botId: brick, taskKey: 'hide-2', personId: sara, state: 'refunded' });
      // A task that ran and failed: a run and a (zero) charge in the books; the person sees it was refunded
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-3', title: 'Ran and failed', category: 'apps' });
      p.script.runs.push({ kind: 'done', successful: false, data: null, error: 'boom', logId: 'log-h3', chargeMicros: 4_000 });
      expect(await runInstant(ask({ taskKey: 'hide-3' }), { adapter: p.adapter, funds: f.funds })).toMatchObject({ status: 'failed' });
      await closeReceipt({ botId: brick, taskKey: 'hide-3', personId: sara, state: 'refunded' });
      // Refunded with something in the books for its key and no run: not empty
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-4', title: 'Has books, refunded', category: 'apps' });
      await prisma.meterEvent.create({
        data: { eventId: `hide-4-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(1000), basis: 'measured', detail: { instant: true, taskKey: 'hide-4' } },
      });
      await closeReceipt({ botId: brick, taskKey: 'hide-4', personId: sara, state: 'refunded' });
      // A charge made under the task's run that names no task is shown on the run's receipt: never hidden. The Brick's own thinking is not money taken: hidden.
      const underRun = (eventId: string, kind: string, route: string, micros: number) =>
        prisma.meterEvent.create({
          data: { eventId: `${eventId}-${tag}`, kind, pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route, jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(micros), basis: 'measured', detail: { runId: eventId } },
        });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-7', runId: 'run-hide-7', title: 'Run-wide charge', category: 'apps' });
      await underRun('run-hide-7', 'app_use', 'instant', 1000);
      await closeReceipt({ botId: brick, taskKey: 'hide-7', personId: sara, state: 'refunded' });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-8', runId: 'run-hide-8', title: 'Only thinking', category: 'apps' });
      await underRun('run-hide-8', 'model_call', 'chat', 0);
      await closeReceipt({ botId: brick, taskKey: 'hide-8', personId: sara, state: 'refunded' });
      // Two receipts of one run and one unkeyed charge: the charge is the first receipt's only, so the second is empty and hidden
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-10a', runId: 'run-hide-10', title: 'Owns the run charge', category: 'apps' }, new Date(Date.now() - 2000));
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-10b', runId: 'run-hide-10', title: 'Shares the run, no charge', category: 'apps' }, new Date(Date.now() - 1000));
      await underRun('run-hide-10', 'app_use', 'instant', 1000);
      await closeReceipt({ botId: brick, taskKey: 'hide-10a', personId: sara, state: 'refunded' });
      await closeReceipt({ botId: brick, taskKey: 'hide-10b', personId: sara, state: 'refunded' });
      // A charge in the run that names another task's key is that task's, not this one's: hidden
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-9', runId: 'run-hide-9', title: 'Another task’s charge', category: 'apps' });
      await prisma.meterEvent.create({
        data: { eventId: `run-hide-9-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'universe', route: 'instant', jobId: null, quantity: BigInt(1), unit: 'use', costMicros: BigInt(1000), basis: 'measured', detail: { runId: 'run-hide-9', taskKey: 'some-other-task' } },
      });
      await closeReceipt({ botId: brick, taskKey: 'hide-9', personId: sara, state: 'refunded' });
      // The only event under its key is the Brick's own thinking at no cost: nothing was taken, so it is hidden
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-11', title: 'Only free thinking', category: 'apps' });
      await prisma.meterEvent.create({
        data: { eventId: `hide-11-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'person', route: 'chat', jobId: 'hide-11', quantity: BigInt(1), unit: 'use', costMicros: BigInt(0), basis: 'measured', detail: { taskKey: 'hide-11' } },
      });
      await closeReceipt({ botId: brick, taskKey: 'hide-11', personId: sara, state: 'refunded' });
      // A thinking line whose cost is not known yet is not "nothing taken" (the Costs report counts it unpriced): the receipt stays
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-12', title: 'Thinking not priced yet', category: 'apps' });
      await prisma.meterEvent.create({
        data: { eventId: `hide-12-${tag}`, kind: 'model_call', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara}`, personId: sara, botId: brick, brick: true, payerKind: 'person', route: 'chat', jobId: 'hide-12', quantity: BigInt(1), unit: 'use', costMicros: null, basis: 'measured', detail: { taskKey: 'hide-12' } },
      });
      await closeReceipt({ botId: brick, taskKey: 'hide-12', personId: sara, state: 'refunded' });
      // A task with no category is not an Apps task here: left as it was
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-5', title: 'No category', category: null });
      await closeReceipt({ botId: brick, taskKey: 'hide-5', personId: sara, state: 'refunded' });
      // An Apps task that finished is never hidden
      await openReceipt({ botId: brick, personId: sara, taskKey: 'hide-6', title: 'Finished', category: 'apps' });
      await closeReceipt({ botId: brick, taskKey: 'hide-6', personId: sara, state: 'done' });
      const titles = (await activityFor(sara)).map((item) => item.title);
      expect(titles).not.toContain('Refused by a rule');
      expect(titles).not.toContain('No run made');
      expect(titles).not.toContain('Only thinking');
      expect(titles).not.toContain('Only free thinking');
      expect(titles).not.toContain('Shares the run, no charge');
      expect(titles).toContain('Owns the run charge');
      expect(titles).not.toContain('Another task’s charge');
      expect(titles).toEqual(expect.arrayContaining(['Ran and failed', 'Has books, refunded', 'Run-wide charge', 'Thinking not priced yet', 'No category', 'Finished']));
      // The limit counts what is listed: hidden receipts do not take a place
      expect((await activityFor(sara, 6)).length).toBe(6);
    });

    it('a receipt the run’s own pass could not move (no hook then) is moved by the sweep’s pass over receipts still in checking', async () => {
      await setLimits();
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await openReceipt({ botId: brick, personId: sara, taskKey: 'look-7', title: 'Find the weather', category: 'apps' });
      const row = await unclearRun(p, f, 'look-7', 'weather7');
      await closeReceipt({ botId: brick, taskKey: 'look-7', personId: sara, state: 'done' });
      setInstantHooks(undefined);
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'failed', null)]);
      await reconcileRun(row.id, { funds: f.funds, adapter: p.adapter, now: new Date() });
      expect(await receiptState('look-7')).toBe('checking');
      setInstantHooks(instantRulesAndReceipts);
      expect(await settleCheckingReceipts(50)).toBeGreaterThanOrEqual(1);
      // And the sweep itself says it too (here nothing is left for it to move)
      expect((await sweepInstant({ funds: f.funds, adapter: p.adapter })).receipts).toBeGreaterThanOrEqual(0);
      expect(await receiptState('look-7')).toBe('refunded');
    });
  });

  describe('a run let go unconfirmed after the long wait (A1): what the person and we each see, and what late evidence does', () => {
    beforeEach(() => setInstantHooks(instantRulesAndReceipts));
    afterEach(() => setInstantHooks(undefined));

    const WAIT = 600;
    /** A run whose answer never came back and whose log cannot be reached, asked about once the long wait is over. */
    async function released(p: ReturnType<typeof fakeProvider>, f: ReturnType<typeof fakeFunds>, over: Record<string, unknown> = {}) {
      await setLimits({ unclearWaitMinutes: 30, unreachableWaitMinutes: WAIT });
      const id = callId();
      p.script.runs.push({ kind: 'unclear', why: 'server', status: 500 });
      await runInstant(ask({ callId: id, ...over }), { adapter: p.adapter, funds: f.funds });
      const rowId = await runIdOf(id);
      p.setLogsDown(true);
      const at = new Date(Date.now() + (WAIT + 1) * MIN);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: at });
      return { id, rowId, at, row: await runOf(rowId) };
    }
    const eventOf = (runId: string) => prisma.meterEvent.findUnique({ where: { eventId: `instant:${runId}` } });

    it('a release the books did not acknowledge is tried again by the next sweep, and the credit comes back once', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      f.state.releaseOk = false;
      const { rowId, at } = await released(p, f);
      // The run is let go, but the books did not say the hold is gone: it is not called released, and the credit is still held
      expect(await runOf(rowId)).toMatchObject({ state: 'failed', reason: 'unclear' });
      expect((await runOf(rowId)).customerState).not.toBe('released');
      expect(f.left()).toBeLessThan(1_000_000);
      f.state.releaseOk = true;
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: at });
      expect(await runOf(rowId)).toMatchObject({ customerState: 'released' });
      expect(f.left()).toBe(1_000_000);
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: at });
      expect(f.left()).toBe(1_000_000);
    });

    it('asked again with the same call id, it says it could not be confirmed and never runs the App again', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { id, at } = await released(p, f);
      expect(p.sent).toHaveLength(1);
      for (let again = 0; again < 2; again++) {
        expect(await runInstant(ask({ callId: id }), { adapter: p.adapter, funds: f.funds, now: at })).toMatchObject({ status: 'failed', reason: 'unclear', message: 'We couldn’t confirm this one, so you weren’t charged.' });
      }
      expect(p.sent).toHaveLength(1);
      expect(f.left()).toBe(1_000_000);
    });

    it('a late success is the person’s free: nothing is charged, the run keeps its own outcome, and a late charge replaces the estimate once', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { rowId, at, row } = await released(p, f);
      expect(Number(row.providerMicros)).toBe(TOP);
      expect(await eventOf(rowId)).toMatchObject({ basis: 'estimated' });
      p.setLogsDown(false);
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', TOP - 1_000)]);
      // Said twice (a second delivery of the same evidence): it is applied once
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 60 * MIN) });
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 120 * MIN) });
      const after = await runOf(rowId);
      expect(after).toMatchObject({ state: 'failed', reason: 'unclear', customerState: 'released', providerBasis: 'measured' });
      expect(Number(after.providerMicros)).toBe(TOP - 1_000);
      expect(after.detail).toMatchObject({ releasedUnconfirmed: true, lateEvidence: { status: 'success', chargeMicros: TOP - 1_000 }, adjustment: { estimatedMicros: TOP, verifiedMicros: TOP - 1_000 } });
      expect(await eventOf(rowId)).toMatchObject({ basis: 'measured', costMicros: BigInt(TOP - 1_000) });
      expect(await prisma.meterEvent.count({ where: { eventId: `instant:${rowId}` } })).toBe(1);
      expect(f.left()).toBe(1_000_000);
      expect(p.sent).toHaveLength(1);
      // A late figure below the top price stops nothing
      expect((await getInstantPause()).paused).toBe(false);
    });

    it('a vendor charge above the estimate is the real one: our cost follows it, the person still pays nothing', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { rowId, at, row } = await released(p, f);
      p.setLogsDown(false);
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', TOP + 2_000)]);
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 60 * MIN) });
      const after = await runOf(rowId);
      expect(Number(after.providerMicros)).toBe(TOP + 2_000);
      expect(after.detail).toMatchObject({ adjustment: { estimatedMicros: TOP, verifiedMicros: TOP + 2_000 } });
      expect(await eventOf(rowId)).toMatchObject({ costMicros: BigInt(TOP + 2_000), basis: 'measured' });
      expect(after.customerState).toBe('released');
      expect(f.left()).toBe(1_000_000);
      // A late figure above the top price says the table is too low, as one found on time does: Instant stops
      expect(await getInstantPause()).toMatchObject({ paused: true, reason: 'price_over_top' });
    });

    it('a late success line that has no charge yet is not the evidence: it is looked for again, and the charge found later replaces the estimate', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { rowId, at, row } = await released(p, f);
      p.setLogsDown(false);
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', null)]);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 60 * MIN) });
      expect((await runOf(rowId)).detail).not.toHaveProperty('lateEvidence');
      expect(Number((await runOf(rowId)).providerMicros)).toBe(TOP);
      // The charge is posted
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'success', TOP - 1_000)]);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 120 * MIN) });
      const after = await runOf(rowId);
      expect(Number(after.providerMicros)).toBe(TOP - 1_000);
      expect(after.providerBasis).toBe('measured');
    });

    it('a late failure changes nothing for the person and keeps the estimate when the line has no charge; it is written down once', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { rowId, at, row } = await released(p, f);
      p.setLogsDown(false);
      p.script.byUser.set(row.providerUserId, [p.line(row.providerUserId, 'failed', null)]);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 60 * MIN) });
      const after = await runOf(rowId);
      expect(after).toMatchObject({ state: 'failed', reason: 'unclear', customerState: 'released', providerBasis: 'estimated' });
      expect(Number(after.providerMicros)).toBe(TOP);
      expect(after.detail).toMatchObject({ releasedUnconfirmed: true, lateEvidence: { status: 'failed', chargeMicros: null } });
      expect(f.left()).toBe(1_000_000);
    });

    it('when the log is still unreachable the estimate stands and nothing else moves, and a run released long ago is no longer looked for', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      const { rowId, at } = await released(p, f);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 60 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ providerBasis: 'estimated', customerState: 'released' });
      expect((await runOf(rowId)).detail).not.toHaveProperty('lateEvidence');
      p.setLogsDown(false);
      p.script.byUser.set((await runOf(rowId)).providerUserId, [p.line((await runOf(rowId)).providerUserId, 'success', 1_000)]);
      await reconcileRun(rowId, { funds: f.funds, adapter: p.adapter, now: new Date(at.getTime() + 40 * 24 * 60 * MIN) });
      expect(await runOf(rowId)).toMatchObject({ providerBasis: 'estimated' });
    });

    it('a task with one run that worked and one let go unconfirmed ends done, charged only for the one that worked', async () => {
      const p = fakeProvider();
      const f = fakeFunds(1_000_000);
      await setLimits({ unclearWaitMinutes: 30, unreachableWaitMinutes: WAIT });
      await openReceipt({ botId: brick, personId: sara, taskKey: 'mixed-1', title: 'Two lookups', category: 'apps' });
      const worked = await runInstant(ask({ callId: callId(), taskKey: 'mixed-1', arguments: { query: 'one' } }), { adapter: p.adapter, funds: f.funds });
      expect(worked).toMatchObject({ status: 'done' });
      const { rowId, at } = await released(p, f, { taskKey: 'mixed-1', arguments: { query: 'two' } });
      await closeReceipt({ botId: brick, taskKey: 'mixed-1', personId: sara, state: 'done' });
      await sweepInstant({ funds: f.funds, adapter: p.adapter, now: at });
      const receipt = await prisma.taskReceipt.findFirstOrThrow({ where: { personId: sara, taskKey: 'mixed-1' } });
      expect(receipt.state).toBe('done');
      const charged = Number((await prisma.instantRun.findFirstOrThrow({ where: { taskKey: 'mixed-1', state: 'succeeded' } })).customerMicros);
      expect(charged).toBeGreaterThan(0);
      expect((await activityFor(sara)).find((item) => item.title === 'Two lookups')).toMatchObject({ state: 'done', spentMicros: charged });
      expect((await runOf(rowId)).customerState).toBe('released');
    });
  });
});
