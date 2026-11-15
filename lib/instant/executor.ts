import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import type { InstantAdapter, InstantCall, InstantLog, ReadyMadeAdapter } from '@/lib/app-adapter/types';
import { recordMeterEvent } from '@/lib/meter';
import { monthOf } from '@/lib/meter-values';
import { brickHasApp } from '@/lib/instant/asker';
import { getInstantFunds, type InstantFunds } from '@/lib/instant/funds';
import { getInstantLimits, getInstantPause, pauseInstant } from '@/lib/instant/state';
import {
  INSTANT_PROVIDER,
  admitInstantTool,
  argsFingerprint,
  customerChargeFor,
  holdFor,
  missingInstantLimits,
  providerUserIdFor,
  REASON_WORDS,
  type InstantLimits,
  type InstantOutcome,
  type InstantReason,
} from '@/lib/instant/values';

/**
 * The bounded Instant executor (spec O2). It is the ONLY way an Instant tool runs.
 *
 * Instant tools run on Composio's own accounts and are charged to OUR prepaid balance. Composio's session has no dollar cap, its
 * balance check is asynchronous, a failed or timed-out call may still have cost money, and its price strings are not bounds. So:
 *
 *  1. Admission: only a tool in our trusted table whose arguments can be held to a top price, at or under "the most one run may
 *     cost" (a Limit). Everything else is refused, never guessed.
 *  2. Reserve before any paid effect, in one step, in both books: our own exposure to Composio (under one lock, against a ceiling
 *     a super admin sets) and the person's Instant Apps credit (through the funding books' door, lib/instant/funds.ts). Either
 *     one refusing means nothing runs.
 *  3. The intent is saved BEFORE the request goes out, so a crash can never leave a paid run that nothing remembers.
 *  4. The run goes out on purpose through the Instant account, under an id made from the run (nothing of a person), so Composio's
 *     log of it can be found exactly. Never through a session and never through the MCP link.
 *  5. It ends as charged (Composio's own figure, or the top price after a wait), released (a failure never costs the person; the
 *     provider's charge stays on our books), or unclear (looked up by that id before anything is decided or repeated).
 *  6. A high failure rate, a charge above the top price, an empty provider balance or a price that moved up stop Instant by itself.
 *
 * Customer money and provider cost are separate columns of the same run, never one number.
 */

const MINUTE = 60 * 1000;
const EXPOSURE_LOCK = 'instant:exposure';

type Row = Prisma.InstantRunGetPayload<object>;

const asNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The run key: the Brick and the bot server's own call id. One that would not fit is made from a hash of both, never cut short. */
export function instantRunKey(botId: string, callId: string): string {
  const whole = `instant:${botId}:${callId.length}:${callId}`;
  return whole.length <= 255 ? whole : `instant:${createHash('sha256').update(whole).digest('hex')}`;
}

const fundsKey = (runId: string): string => `instant:${runId}`;

function instantAdapter(adapter?: ReadyMadeAdapter | null): InstantAdapter | null {
  return (adapter === undefined ? getAdapter() : adapter)?.instant ?? null;
}

export interface RunInput {
  botId: string;
  /** The person who asked and pays: the Brick's owner. Checked against the Brick here, whatever the caller did. */
  personId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** The bot server's own id for this call: a retry is the same call and never runs or pays twice. */
  callId: string;
}

export interface Deps {
  funds?: InstantFunds;
  adapter?: ReadyMadeAdapter | null;
  now?: Date;
}

const refuse = (reason: InstantReason, extra: { runId?: string; leftMicros?: number | null; words?: string } = {}): InstantOutcome => ({ status: 'refused', reason, ...extra });

/**
 * Seams for rules people say in chat and for task receipts (O4), so they attach without the executor knowing how they work. A rule
 * that says no is final: it refuses before any credit is held or provider call is made, in the rule's own words. Never throws into a run.
 */
export interface InstantHooks {
  /** Asked after admission and before anything is held. A refusal carries the plain words to say. */
  beforeRun?(input: RunInput, topMicros: number): Promise<{ refuse: true; words: string } | null>;
  /** Told how every run ended, for receipts. */
  afterRun?(input: RunInput, outcome: InstantOutcome): Promise<void>;
}

let hooks: InstantHooks = {};

/** Wires rules and receipts in (or, with undefined, out). */
export function setInstantHooks(next: InstantHooks | undefined): void {
  hooks = next ?? {};
}

/**
 * One Instant run, from admission to its first honest answer. Never throws for a business reason: every way it can end is a value.
 * A caller that asks again with the same call id gets the same run back (looked up again if it was unclear), never a second run.
 */
export async function runInstant(input: RunInput, deps: Deps = {}): Promise<InstantOutcome> {
  const outcome = await runInstantInner(input, deps);
  try {
    await hooks.afterRun?.(input, outcome);
  } catch (error) {
    console.error('[Instant] A receipt hook failed:', error instanceof Error ? error.message : 'unknown');
  }
  return outcome;
}

async function runInstantInner(input: RunInput, deps: Deps): Promise<InstantOutcome> {
  const now = deps.now ?? new Date();
  const funds = deps.funds ?? getInstantFunds();
  const adapter = deps.adapter === undefined ? getAdapter() : deps.adapter;
  const instant = instantAdapter(adapter);
  const runKey = instantRunKey(input.botId, input.callId);

  // The same call asked again: the same run, never a second one
  const known = await prisma.instantRun.findUnique({ where: { runKey } });
  if (known) return describeKnown(known, { funds, adapter, now });

  // Instant is always the Brick's owner's own, on their own Brick: no room, owner is who asked, Brick not deleted
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || bot.roomId !== null || bot.deletedAt !== null || bot.ownerId !== input.personId) return refuse('not_owner');

  if (!instant) return refuse('not_set');
  const limits = await getInstantLimits();
  if (missingInstantLimits(limits).length > 0) return refuse('not_set');
  if ((await getInstantPause()).paused) return refuse('paused');

  const admitted = admitInstantTool(input.tool, input.arguments);
  if (!admitted.ok) return refuse(admitted.reason);
  // Nothing is on for a Brick by default: only an App its owner switched on for this Brick can run
  if (!(await brickHasApp(input.botId, admitted.toolkit))) return refuse('not_offered');
  if (admitted.topMicros > (limits.maxRunMicros ?? 0)) return refuse('too_costly');

  // A rule the owner said in chat that says no is final, and nothing is held or sent
  try {
    const ruled = await hooks.beforeRun?.(input, admitted.topMicros);
    if (ruled) return refuse('rule', { words: ruled.words });
  } catch (error) {
    console.error('[Instant] A rule check failed, so nothing ran:', error instanceof Error ? error.message : 'unknown');
    return refuse('credit_unavailable');
  }

  const fingerprint = argsFingerprint(input.tool, input.arguments);
  // Asked first without any lock, so a plain repeat is answered cheaply; asked again under the admission lock below, where it counts
  const twin = await openTwin(prisma, input.personId, fingerprint);
  if (twin) return refuse('already_checking', { runId: twin });

  const holdMicros = holdFor(admitted.topMicros, limits.markupBps);

  // Step 1: our own exposure, under one lock, and the intent saved with it
  const created = await prisma.$transaction(
    async (tx): Promise<{ kind: 'run'; run: Row } | { kind: 'known'; run: Row } | { kind: 'refused'; outcome: InstantOutcome }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EXPOSURE_LOCK}))`;
      // The existing run is only handed back from here: looking it up at Composio waits on the network, never under this lock
      const again = await tx.instantRun.findUnique({ where: { runKey } });
      if (again) return { kind: 'known', run: again };
      // Two asks that arrive together with different call ids both passed the check above: only one gets past this one
      const sameAsk = await openTwin(tx, input.personId, fingerprint);
      if (sameAsk) return { kind: 'refused', outcome: refuse('already_checking', { runId: sameAsk }) };
      const exposure = await exposureIn(tx, now);
      if (exposure + admitted.topMicros > (limits.exposureCeilingMicros ?? 0)) return { kind: 'refused', outcome: refuse('exposure_full') };
      const id = crypto.randomUUID();
      const run = await tx.instantRun.create({
        data: {
          id,
          runKey,
          botId: input.botId,
          personId: input.personId,
          toolSlug: input.tool,
          toolkit: admitted.toolkit,
          argsHash: fingerprint,
          priceVersion: admitted.priceVersion,
          topMicros: BigInt(admitted.topMicros),
          holdMicros: BigInt(holdMicros),
          markupBps: limits.markupBps ?? 0,
          state: 'reserving',
          providerUserId: providerUserIdFor(id),
          provider: INSTANT_PROVIDER,
          createdAt: now,
        },
      });
      return { kind: 'run', run };
    },
    { maxWait: 15_000, timeout: 30_000 },
  ).catch(async (error) => {
    // A second ask for the same call id at the same moment: the first one's run is the answer
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.instantRun.findUnique({ where: { runKey } });
      if (winner) return { kind: 'known' as const, run: winner };
    }
    throw error;
  });
  if (created.kind === 'refused') return created.outcome;
  if (created.kind === 'known') return describeKnown(created.run, { funds, adapter, now });
  let run = created.run;

  // Step 2: the person's credit
  const held = await holdCustomer(run, funds);
  if (!held.ok && held.unsure === true) {
    // The books failed in a way that may have left a hold behind: it is given back now, and when that cannot be said either the run
    // stays open for the sweep, which says it again until the books answer (never closed over a hold that may exist)
    let gone = false;
    try {
      gone = holdIsGone(await funds.release({ key: fundsKey(run.id) }));
    } catch {
      gone = false;
    }
    if (!gone) return refuse('credit_unavailable', { runId: run.id });
  }
  if (!held.ok) {
    // "Unavailable" is the books being unreachable: said as that, never as the person's credit being used up
    const reason: InstantReason = held.reason === 'unavailable' ? 'credit_unavailable' : held.reason;
    await moveRun(run.id, 'reserving', { state: 'refused', reason, finishedAt: now, customerState: 'none', providerState: 'none' });
    return refuse(reason, { runId: run.id });
  }
  // Each step only moves the run from the step before it. A reservation that came back after the clean-up wait found the run closed
  // and its hold given back: that run never goes out, and a hold that reached the books late is given back again.
  const heldRun = await moveRun(run.id, 'reserving', { state: 'held', customerState: 'held' });
  if (!heldRun) return standDown(run.id, { funds, adapter, now });

  // Step 3: the intent is saved before the request goes out, and from here our exposure counts the top price until Composio's charge is known
  const sentRun = await moveRun(run.id, 'held', { state: 'sent', sentAt: now, providerState: 'pending', checkAfter: new Date(now.getTime() + limits.unclearWaitMinutes * MINUTE) });
  if (!sentRun) return standDown(run.id, { funds, adapter, now });
  run = sentRun;

  // Step 4: out through the Instant account
  let call: InstantCall;
  try {
    call = await instant.run({ runUserId: run.providerUserId, tool: run.toolSlug, arguments: input.arguments });
  } catch (error) {
    console.error('[Instant] The run could not be sent cleanly:', error instanceof Error ? error.message : 'unknown');
    call = { kind: 'unclear', why: 'network', status: null };
  }
  return finishCall(run.id, call, { funds, adapter, now: new Date() });
}

/** One run's own move from one state to the next, only if it is still in the state it was left in; null when something else (the clean-up) got there first. */
async function moveRun(runId: string, from: string, data: Prisma.InstantRunUpdateManyMutationInput): Promise<Row | null> {
  const { count } = await prisma.instantRun.updateMany({ where: { id: runId, state: from }, data });
  if (count !== 1) return null;
  return prisma.instantRun.findUnique({ where: { id: runId } });
}

/** A run that was taken over while its request was still on its way: the hold goes back (said again, it is idempotent) and the run is answered as it now stands. */
async function standDown(runId: string, ctx: Ctx): Promise<InstantOutcome> {
  try {
    await ctx.funds.release({ key: fundsKey(runId) });
  } catch (error) {
    console.error('[Instant] The credit books could not release:', error instanceof Error ? error.message : 'unknown');
  }
  const row = await prisma.instantRun.findUnique({ where: { id: runId } });
  return row ? outcomeOf(row) : refuse('unclear', { runId });
}

/** Whether the books say nothing is held under a key any more: given back just now, or never held at all. A plain "no" proves neither. */
const holdIsGone = (answer: { ok: boolean; none?: boolean }): boolean => answer.ok || answer.none === true;

/** The credit hold for a run, with an error from the books read as "unavailable": a hold nobody could make is no hold. */
async function holdCustomer(run: Row, funds: InstantFunds): Promise<Awaited<ReturnType<InstantFunds['reserve']>> & { unsure?: boolean }> {
  try {
    return await funds.reserve({
      key: fundsKey(run.id),
      personId: run.personId,
      amountMicros: asNumber(run.holdMicros),
      botId: run.botId,
      runId: run.id,
      charge: { class: 'instant', route: 'composio', provider: 'composio', priceVersion: run.priceVersion },
    });
  } catch (error) {
    console.error('[Instant] The credit books could not hold:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'unavailable', unsure: true };
  }
}

/**
 * A run of this person that makes asking again wrong: the very same ask that is still going or still being looked up (reservations
 * that have not gone out yet count), or details Composio did not accept whose charge is not known yet (one at a time per person).
 * Run under the admission lock it is what keeps two simultaneous asks from both going out.
 */
async function openTwin(db: Pick<Prisma.TransactionClient, 'instantRun'>, personId: string, fingerprint: string): Promise<string | null> {
  const same = await db.instantRun.findFirst({ where: { personId, argsHash: fingerprint, state: { in: ['reserving', 'held', 'sent', 'ambiguous'] } }, select: { id: true } });
  if (same) return same.id;
  const unreadInvalid = await db.instantRun.findFirst({ where: { personId, state: 'failed', reason: 'invalid_request', providerState: 'pending' }, select: { id: true } });
  return unreadInvalid?.id ?? null;
}

/**
 * Everything Instant may still owe Composio at a moment: runs not finished and runs whose charge is not known count at their top
 * price; settled charges count as charged, for the month. Both sums are read in ONE statement, so one snapshot: a run that settles
 * while this reads is counted once, never at its top price and again at its charge.
 */
export async function exposureIn(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, now: Date): Promise<number> {
  const month = monthOf(now);
  const rows = await tx.$queryRaw<{ open: bigint; settled: bigint }[]>`
    SELECT
      COALESCE(SUM("top_micros") FILTER (WHERE "state" IN ('reserving', 'held', 'sent', 'ambiguous') OR "provider_state" = 'pending'), 0)::bigint AS "open",
      COALESCE(SUM("provider_micros") FILTER (WHERE "provider_state" = 'settled' AND "finished_at" >= ${month.start} AND "finished_at" < ${month.end}), 0)::bigint AS "settled"
    FROM "instant_runs"`;
  return asNumber(rows[0]?.open) + asNumber(rows[0]?.settled);
}

// ---------- How a run ended ----------

interface Ctx {
  funds: InstantFunds;
  adapter: ReadyMadeAdapter | null;
  now: Date;
}

/** Runs `work` on a fresh read of the run, with the run locked so a sweep and a retry never settle one run twice or in two ways. */
async function withRun<T>(runId: string, work: (row: Row, tx: Prisma.TransactionClient) => Promise<T>): Promise<T | null> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`instant:run:${runId}`}, 0))`;
      const row = await tx.instantRun.findUnique({ where: { id: runId } });
      return row ? work(row, tx) : null;
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}

const reasonOfRejection = (code: string | null, status: number): InstantReason => {
  const text = (code ?? '').toLowerCase();
  if (status === 402 || text.includes('walletbalance') || text.includes('balanceexhausted')) return 'provider_empty';
  if (status === 403 || text.includes('notenabled')) return 'provider_off';
  return 'provider_failed';
};

/** What came back from Composio, settled into the run. */
async function finishCall(runId: string, call: InstantCall, ctx: Ctx): Promise<InstantOutcome> {
  const limits = await getInstantLimits();
  // Composio's log is read before the transaction opens, never inside it: a slow Composio must not hold a connection or a lock
  const loggedCharge = call.kind === 'done' && call.chargeMicros === null && call.logId ? await chargeFromLog(ctx.adapter, call.logId) : null;
  const outcome = await withRun(runId, async (run, tx): Promise<InstantOutcome> => {
    // Settled already (a sweep got there first): that is the answer
    if (run.state !== 'sent' && run.state !== 'ambiguous') return outcomeOf(run);
    switch (call.kind) {
      case 'rejected': {
        // Refused before anything ran: nothing is charged to anyone
        const reason = reasonOfRejection(call.code, call.status);
        await releaseCustomer(run, tx, ctx);
        await settleProvider(run, tx, 0, 'measured', ctx.now);
        await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason, finishedAt: ctx.now, detail: { status: call.status, code: call.code } } });
        // Composio's balance is empty: every run would fail the same way, so Instant stops until a super admin has looked
        if (reason === 'provider_empty') await pauseInstant('provider_empty', null, tx);
        return { status: 'failed', runId: run.id, reason, message: REASON_WORDS[reason] };
      }
      case 'invalid': {
        // It did not run, but Composio logs a refusal like this, so its charge is decided from the log, never assumed
        await releaseCustomer(run, tx, ctx);
        // Its own reason, so details Composio would not take never count toward the failure rate that pauses Instant, and a short wait
        // (the sent wait): one person's bad details can hold the exposure for minutes, not an hour, and only one at a time
        await tx.instantRun.update({
          where: { id: run.id },
          data: { state: 'failed', reason: 'invalid_request', finishedAt: ctx.now, providerState: 'pending', checkAfter: new Date(ctx.now.getTime() + limits.sentWaitMinutes * MINUTE), detail: { status: call.status, code: call.code } },
        });
        return { status: 'failed', runId: run.id, reason: 'invalid_request', message: REASON_WORDS.invalid_request };
      }
      case 'unclear': {
        // It may have run and may have been charged: the hold stays, nothing is repeated, and it is looked up by its own id
        await tx.instantRun.update({ where: { id: run.id }, data: { state: 'ambiguous', reason: 'unclear', detail: { why: call.why, status: call.status } } });
        return { status: 'checking', runId: run.id };
      }
      case 'done': {
        if (!call.successful) {
          // It ran and did not work: the person is never charged for that. Our own charge, if any, is read from the log.
          await releaseCustomer(run, tx, ctx);
          await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason: 'provider_failed', finishedAt: ctx.now, providerLogId: call.logId, providerState: 'pending' } });
          // A charge the answer (or its log) reports is ours and is written now; only a charge nobody has reported waits for the log
          const failedCharge = call.chargeMicros ?? loggedCharge;
          if (failedCharge !== null) await settleProvider({ ...run, state: 'failed' }, tx, failedCharge, 'measured', ctx.now);
          return { status: 'failed', runId: run.id, reason: 'provider_failed', message: REASON_WORDS.provider_failed };
        }
        // It worked: Composio's own charge, from the answer or from its log, else the top price waits (never read as free)
        const charge = call.chargeMicros ?? loggedCharge;
        const saved = await tx.instantRun.update({
          where: { id: run.id },
          data: { state: 'succeeded', reason: null, finishedAt: ctx.now, providerLogId: call.logId, providerState: 'pending', checkAfter: new Date(ctx.now.getTime() + limits.chargeWaitMinutes * MINUTE) },
        });
        if (charge !== null) {
          const { charged, customerDone } = await settleSuccess(saved, tx, charge, 'measured', limits, ctx);
          return { status: 'done', runId: run.id, ok: true, data: call.data, chargedMicros: charged, pending: !customerDone };
        }
        return { status: 'done', runId: run.id, ok: true, data: call.data, chargedMicros: 0, pending: true };
      }
    }
  });
  await evaluatePause(ctx.now).catch((error) => console.error('[Instant] The pause check failed:', error instanceof Error ? error.message : 'unknown'));
  return outcome ?? refuse('unclear', { runId });
}

/** A charge off a log line of Composio's, or null when the line is not there, has no charge or cannot be read. */
async function chargeFromLog(adapter: ReadyMadeAdapter | null, logId: string): Promise<number | null> {
  try {
    const found = await instantAdapter(adapter)?.log(logId);
    return found?.log.chargeMicros ?? null;
  } catch (error) {
    console.error('[Instant] Could not read the log:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** Gives the person's hold back (a failure never costs them). Idempotent. True once the books have it; false leaves the hold as it is, and a later look says it again. */
async function releaseCustomer(run: Row, tx: Prisma.TransactionClient, ctx: Pick<Ctx, 'funds'>): Promise<boolean> {
  if (run.customerState !== 'held') return true;
  let done = false;
  try {
    done = holdIsGone(await ctx.funds.release({ key: fundsKey(run.id) }));
  } catch (error) {
    console.error('[Instant] The credit books could not release:', error instanceof Error ? error.message : 'unknown');
  }
  if (done) await tx.instantRun.update({ where: { id: run.id }, data: { customerState: 'released', customerMicros: 0 } });
  return done;
}

/**
 * Composio's charge is known: written on the run (provider side) and once to the meter's books. A charge above the top price
 * means the table is too low: the run still settles, the excess is ours, and Instant stops.
 */
async function settleProvider(run: Row, tx: Prisma.TransactionClient, micros: number, basis: 'measured' | 'estimated', now: Date): Promise<void> {
  if (run.providerState === 'settled') return;
  await tx.instantRun.update({ where: { id: run.id }, data: { providerState: 'settled', providerMicros: BigInt(micros), providerBasis: basis, finishedAt: run.finishedAt ?? now } });
  await recordMeterEvent(
    {
      eventId: `instant:${run.id}`,
      kind: 'app_use',
      pool: 'chat',
      occurredAt: now,
      personKey: `person:${run.personId}`,
      personId: run.personId,
      botId: run.botId,
      brick: true,
      payerKind: 'universe',
      payerPersonId: null,
      route: 'instant',
      jobId: null,
      quantity: 1,
      unit: 'use',
      costMicros: micros,
      basis,
      sourceRef: `instant_runs:${run.id}`,
      detail: { instant: true, provider: INSTANT_PROVIDER, tool: run.toolSlug, toolkit: run.toolkit, runId: run.id, customerMicros: run.customerMicros === null ? null : Number(run.customerMicros), basis, state: run.state },
    },
    tx,
  ).catch((error) => console.error('[Instant] Could not write the meter event:', error instanceof Error ? error.message : 'unknown'));
  if (micros > asNumber(run.topMicros)) await pauseInstant('price_over_top', null, tx);
}

/**
 * A run that worked and whose charge is known: the provider side is settled and the person is charged, never past the hold.
 * Returns what the person was charged, and whether the books took it (when they did not, the hold stays and is said again later).
 */
async function settleSuccess(run: Row, tx: Prisma.TransactionClient, providerMicros: number, basis: 'measured' | 'estimated', limits: InstantLimits, ctx: Ctx): Promise<{ charged: number; customerDone: boolean }> {
  // The markup the hold was made with, never today's: a settlement said again after a markup change asks the books for the same amount
  const charged = customerChargeFor(providerMicros, asNumber(run.holdMicros), run.markupBps ?? limits.markupBps);
  let customerDone = run.customerState !== 'held';
  if (run.customerState === 'held') {
    try {
      customerDone = (await ctx.funds.settle({ key: fundsKey(run.id), chargeMicros: charged, providerCostMicros: providerMicros })).ok;
    } catch (error) {
      console.error('[Instant] The credit books could not settle:', error instanceof Error ? error.message : 'unknown');
    }
    if (customerDone) await tx.instantRun.update({ where: { id: run.id }, data: { customerState: 'charged', customerMicros: BigInt(charged) } });
  }
  await settleProvider({ ...run, customerMicros: customerDone ? BigInt(charged) : run.customerMicros }, tx, providerMicros, basis, ctx.now);
  return { charged, customerDone };
}

/** What a run already on the books says to a caller who asks again. Unclear runs are looked up first. */
async function describeKnown(run: Row, ctx: Ctx): Promise<InstantOutcome> {
  let current = run;
  if (['ambiguous', 'sent', 'held', 'reserving'].includes(run.state) || (run.providerState === 'pending' && (run.state === 'succeeded' || run.state === 'failed'))) {
    await reconcileRun(run.id, ctx).catch((error) => console.error('[Instant] Could not look the run up:', error instanceof Error ? error.message : 'unknown'));
    current = (await prisma.instantRun.findUnique({ where: { id: run.id } })) ?? run;
  }
  // A worked run whose answer is asked for again is handed back from Composio's own log, never run (and paid) again
  if (current.state === 'succeeded' && current.providerLogId) {
    const recovered = await recoverOutput(ctx.adapter, current.providerLogId);
    if (recovered.found) {
      return { status: 'done', runId: current.id, ok: true, data: recovered.data, chargedMicros: asNumber(current.customerMicros), pending: current.customerState === 'held', recovered: true };
    }
  }
  return outcomeOf(current);
}

function outcomeOf(run: Row): InstantOutcome {
  switch (run.state) {
    case 'refused':
      return refuse((run.reason as InstantReason) ?? 'unclear', { runId: run.id });
    case 'failed': {
      const reason = (run.reason as InstantReason) ?? 'provider_failed';
      return { status: 'failed', runId: run.id, reason, message: REASON_WORDS[reason] };
    }
    case 'succeeded':
      return { status: 'already_done', runId: run.id, chargedMicros: run.customerMicros === null ? null : Number(run.customerMicros), state: run.state };
    default:
      return { status: 'checking', runId: run.id };
  }
}

/** The saved answer of a run from Composio's log of it; found false when the log no longer holds it. */
async function recoverOutput(adapter: ReadyMadeAdapter | null, logId: string): Promise<{ found: true; data: unknown } | { found: false }> {
  try {
    const found = await instantAdapter(adapter)?.log(logId);
    const body = found?.response;
    if (found?.log.status === 'success' && isObject(body) && body.data !== undefined) return { found: true, data: body.data };
  } catch (error) {
    console.error('[Instant] Could not read the saved answer:', error instanceof Error ? error.message : 'unknown');
  }
  return { found: false };
}

// ---------- Looking an unfinished run up ----------

/** Whether a run still has to be looked up at Composio: one still "sent" past its wait, one with no answer, a finished one whose charge is not known. */
function needsLookup(run: Row, now: Date, limits: InstantLimits): boolean {
  const waitedPast = (from: Date | null, minutes: number) => !from || now.getTime() - from.getTime() >= minutes * MINUTE;
  const finishedOpen = (run.state === 'succeeded' || run.state === 'failed') && run.providerState === 'pending';
  return run.state === 'ambiguous' || (run.state === 'sent' && waitedPast(run.sentAt, limits.sentWaitMinutes)) || finishedOpen;
}

/**
 * Composio's log line of a run, found BY THE RUN'S OWN ID (or the line the answer named). Done before any database transaction opens,
 * so a slow or rate-limited Composio never holds a connection or a lock. Null when Composio cannot be asked: nothing is decided on a
 * guess, and the run stays as it is until it can be. `line: null` means Composio answered and has no line of it.
 */
async function lookUp(run: Row, instant: InstantAdapter, now: Date): Promise<{ line: InstantLog | null } | null> {
  try {
    let line: InstantLog | null = null;
    if (run.providerLogId) line = (await instant.log(run.providerLogId))?.log ?? null;
    if (!line) {
      const found = await instant.findLogs({ userId: run.providerUserId, fromMs: (run.sentAt ?? run.createdAt).getTime() - 60 * 1000, toMs: now.getTime() + 60 * 1000 });
      // The search already asked for this run's id. A line that names the id must name this one; a line that names none is taken on
      // that search, and only when it is the same tool, so a log shape without the id never turns a real run into "no log".
      line = found.find((entry) => entry.userId === run.providerUserId) ?? found.find((entry) => entry.userId === null && (entry.tool === null || entry.tool === run.toolSlug)) ?? null;
    }
    return { line };
  } catch (error) {
    console.error('[Instant] Could not look the run up:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/**
 * Settles what can be settled on a run that has not finished honestly: one still "sent" past its wait, one with no answer, a worked
 * run whose charge is not known, a failed one whose charge is not known. Looks Composio's log up BY THE RUN'S OWN ID.
 *  - A log that says it worked: the person is charged (Composio's figure, or the top price once the wait for it is over) and, for a
 *    run nobody got the answer of, the answer is handed back on the next ask from that same log.
 *  - A log that says it failed: the person's hold goes back, our provider charge stays on our books.
 *  - No log at all by the time the wait is over: nothing is known to have run. The person's hold goes back (they have nothing), and
 *    our own exposure to Composio is closed at the top price as an estimate until the monthly check says otherwise.
 * Safe to run twice at once and any number of times.
 */
export async function reconcileRun(runId: string, ctx: Ctx): Promise<void> {
  const limits = await getInstantLimits();
  const instant = instantAdapter(ctx.adapter);
  // Ask Composio first, outside the transaction; the locked read below decides what the answer means for the run as it is by then
  const seen = await prisma.instantRun.findUnique({ where: { id: runId } });
  if (!seen) return;
  // Tried now: the sweep goes oldest attempt first, so runs that cannot be settled never keep the rest from being tried
  await prisma.instantRun.updateMany({ where: { id: runId }, data: { checkedAt: new Date() } });
  const looked = instant && needsLookup(seen, ctx.now, limits) ? await lookUp(seen, instant, ctx.now) : null;
  await withRun(runId, async (run, tx) => {
    const now = ctx.now;
    const waitedPast = (from: Date | null, minutes: number) => !from || now.getTime() - from.getTime() >= minutes * MINUTE;

    // Crashed between its steps: it never went out, so it never cost anything
    if ((run.state === 'reserving' || run.state === 'held') && waitedPast(run.createdAt, limits.sentWaitMinutes)) {
      // The run is closed only when the books say the hold is gone: given back just now, or confirmed not to exist. A plain "no" does
      // not say that (a reservation that was made but never answered may exist), so the run stays open and the sweep asks again.
      let released = false;
      try {
        released = holdIsGone(await ctx.funds.release({ key: fundsKey(run.id) }));
      } catch (error) {
        console.error('[Instant] The credit books could not release:', error instanceof Error ? error.message : 'unknown');
      }
      if (!released) return;
      await tx.instantRun.update({ where: { id: run.id }, data: { state: 'refused', reason: 'unclear', customerState: run.customerState === 'none' ? 'none' : 'released', customerMicros: run.customerState === 'none' ? null : BigInt(0), providerState: 'none', finishedAt: now } });
      return;
    }

    // Finished, but the books did not take the customer's side the first time: said again now
    if (run.state === 'failed' && run.customerState === 'held') {
      if (!(await releaseCustomer(run, tx, ctx))) return;
    }
    if (run.state === 'succeeded' && run.customerState === 'held' && run.providerState === 'settled' && run.providerMicros !== null) {
      await settleSuccess(run, tx, asNumber(run.providerMicros), run.providerBasis === 'measured' ? 'measured' : 'estimated', limits, ctx);
      return;
    }

    // A run that just went out is still in flight: it is not looked up (and never called unclear) until its wait is over
    if (!needsLookup(run, now, limits)) return;
    if (!looked) return;
    const line = looked.line;

    const topMicros = asNumber(run.topMicros);
    const deadline = run.checkAfter ?? new Date((run.sentAt ?? run.createdAt).getTime() + limits.unclearWaitMinutes * MINUTE);

    if (run.state === 'sent' || run.state === 'ambiguous') {
      if (line && line.status === 'success') {
        const saved = await tx.instantRun.update({
          where: { id: run.id },
          data: { state: 'succeeded', reason: null, finishedAt: now, providerLogId: line.id, providerState: 'pending', checkAfter: new Date(now.getTime() + limits.chargeWaitMinutes * MINUTE) },
        });
        if (line.chargeMicros !== null) await settleSuccess(saved, tx, line.chargeMicros, 'measured', limits, ctx);
        return;
      }
      if (line && line.status === 'failed') {
        await releaseCustomer(run, tx, ctx);
        await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason: 'provider_failed', finishedAt: now, providerLogId: line.id, providerState: 'pending', checkAfter: new Date(now.getTime() + limits.chargeWaitMinutes * MINUTE) } });
        if (line.chargeMicros !== null) await settleProvider({ ...run, state: 'failed' }, tx, line.chargeMicros, 'measured', now);
        return;
      }
      // A line with no readable status (or no line at all) is not an answer: it is looked at again until the wait is over, and then it
      // ends like a run nobody can vouch for. It never stays open for good, holding the person's credit and our exposure.
      if (now < deadline) {
        // Not found yet: Composio's log can lag. A run that was only "sent" is now treated as unclear, and looked up again.
        if (run.state === 'sent') await tx.instantRun.update({ where: { id: run.id }, data: { state: 'ambiguous', reason: 'unclear' } });
        return;
      }
      // Nothing readable of it by the end of the wait: nothing is known to have worked. The person is not charged for what nobody can
      // vouch for, so the hold goes back, and our own exposure is closed at the top price as an estimate until the monthly check.
      await releaseCustomer(run, tx, ctx);
      await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason: 'unclear', finishedAt: now, providerLogId: line?.id ?? run.providerLogId, detail: line ? { unreadableLog: true } : { noLog: true } } });
      await settleProvider({ ...run, state: 'failed' }, tx, topMicros, 'estimated', now);
      return;
    }

    // Finished, with Composio's charge not known yet
    if (line && !run.providerLogId) await tx.instantRun.update({ where: { id: run.id }, data: { providerLogId: line.id } });
    if (line && line.chargeMicros !== null) {
      if (run.state === 'succeeded') await settleSuccess({ ...run, providerLogId: line.id }, tx, line.chargeMicros, 'measured', limits, ctx);
      else await settleProvider(run, tx, line.chargeMicros, 'measured', now);
      return;
    }
    if (now >= deadline) {
      // An absent charge is not proof it was free: the top price stands, as an estimate, until the monthly check
      if (run.state === 'succeeded') await settleSuccess(run, tx, topMicros, 'estimated', limits, ctx);
      else await settleProvider(run, tx, topMicros, 'estimated', now);
    }
  });
  await evaluatePause(ctx.now).catch((error) => console.error('[Instant] The pause check failed:', error instanceof Error ? error.message : 'unknown'));
}

// ---------- Stopping by itself ----------

/**
 * Pauses Instant when too many of the recent runs ended as failures (a share a super admin sets, over a set time, once a set number
 * of runs has happened). Give-backs for "Didn't work" count as failures too. New runs stop; runs going finish and settle.
 */
export async function evaluatePause(now: Date = new Date()): Promise<boolean> {
  const limits = await getInstantLimits();
  if (limits.pauseFailureRateBps === null || limits.pauseMinRuns === null) return false;
  // Runs that finished before a super admin last turned Instant back on are the ones they already looked at: they never pause it again
  const resumedAt = (await getInstantPause()).resumedAt;
  const windowStart = now.getTime() - limits.pauseWindowMinutes * MINUTE;
  const since = new Date(Math.max(windowStart, resumedAt ? Date.parse(resumedAt) || 0 : 0));
  // Details Composio would not take are the caller's, not the provider's: they are not runs the failure rate is about
  const notInvalid = { OR: [{ reason: null }, { reason: { not: 'invalid_request' } }] };
  const [done, failed, givenBack] = await Promise.all([
    prisma.instantRun.count({ where: { state: { in: ['succeeded', 'failed'] }, finishedAt: { gte: since }, ...notInvalid } }),
    prisma.instantRun.count({ where: { state: 'failed', finishedAt: { gte: since }, ...notInvalid } }),
    prisma.instantRefund.count({ where: { kind: 'goodwill', createdAt: { gte: since } } }),
  ]);
  if (done < limits.pauseMinRuns) return false;
  const rate = Math.floor(((failed + givenBack) * 10_000) / done);
  if (rate < limits.pauseFailureRateBps) return false;
  await pauseInstant('failure_rate');
  return true;
}

// ---------- Giving back after a charge ----------

export type GiveBackOutcome =
  | { status: 'given'; amountMicros: number }
  | { status: 'refused'; reason: 'not_found' | 'not_charged' | 'already_given' | 'not_set' | 'budget' | 'person_limit' | 'unavailable' };

/**
 * "Didn't work" on a run that was charged: a bounded goodwill give-back (one per run; the most per give-back, per person a month
 * and everyone a month are Limits, and none of them is set until a super admin sets it). A verified platform failure never needs
 * this: it was never charged. The give-back goes to the lots it came from, never to cash.
 */
export async function giveBack(input: { personId: string; runId: string }, deps: Deps = {}): Promise<GiveBackOutcome> {
  const funds = deps.funds ?? getInstantFunds();
  const now = deps.now ?? new Date();
  const limits = await getInstantLimits();
  if (limits.goodwillMaxMicros === null || limits.goodwillMaxMicros < 1 || limits.goodwillBudgetMicros === null || limits.goodwillPerPersonPerMonth === null || limits.goodwillPerPersonPerMonth < 1) {
    return { status: 'refused', reason: 'not_set' };
  }
  const month = monthOf(now);
  const outcome = await prisma.$transaction(
    async (tx): Promise<GiveBackOutcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:goodwill'))`;
      const run = await tx.instantRun.findUnique({ where: { id: input.runId } });
      if (!run || run.personId !== input.personId) return { status: 'refused', reason: 'not_found' };
      if (run.state !== 'succeeded' || run.customerState !== 'charged' || asNumber(run.customerMicros) <= 0) return { status: 'refused', reason: 'not_charged' };
      const refundKey = `goodwill:${run.id}`;
      if (await tx.instantRefund.findUnique({ where: { refundKey } })) return { status: 'refused', reason: 'already_given' };
      const [person, everyone] = await Promise.all([
        tx.instantRefund.count({ where: { personId: input.personId, kind: 'goodwill', createdAt: { gte: month.start, lt: month.end } } }),
        tx.instantRefund.aggregate({ where: { kind: 'goodwill', createdAt: { gte: month.start, lt: month.end } }, _sum: { amountMicros: true } }),
      ]);
      if (person >= limits.goodwillPerPersonPerMonth!) return { status: 'refused', reason: 'person_limit' };
      const amount = Math.min(asNumber(run.customerMicros) - asNumber(run.refundedMicros), limits.goodwillMaxMicros!);
      if (amount < 1) return { status: 'refused', reason: 'not_charged' };
      if (asNumber(everyone._sum.amountMicros) + amount > limits.goodwillBudgetMicros!) return { status: 'refused', reason: 'budget' };
      let done: { ok: boolean; refundedMicros?: number };
      try {
        done = await funds.refund({ key: fundsKey(run.id), refundKey, amountMicros: amount, reason: 'goodwill', limits: { giveBackMaxMicros: limits.goodwillMaxMicros, goodwillBudgetMicros: limits.goodwillBudgetMicros } });
      } catch (error) {
        console.error('[Instant] The credit books could not give back:', error instanceof Error ? error.message : 'unknown');
        return { status: 'refused', reason: 'unavailable' };
      }
      if (!done.ok) return { status: 'refused', reason: 'unavailable' };
      // What the books say they gave back is what is recorded: a give-back that was made before and said again returns its first amount,
      // which may differ from today's figure after a Limits change
      const given = typeof done.refundedMicros === 'number' && Number.isSafeInteger(done.refundedMicros) && done.refundedMicros > 0 ? done.refundedMicros : amount;
      await tx.instantRefund.create({ data: { refundKey, runId: run.id, personId: run.personId, kind: 'goodwill', amountMicros: BigInt(given) } });
      await tx.instantRun.update({ where: { id: run.id }, data: { refundedMicros: { increment: BigInt(given) } } });
      return { status: 'given', amountMicros: given };
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
  if (outcome.status === 'given') await evaluatePause(now).catch(() => undefined);
  return outcome;
}
