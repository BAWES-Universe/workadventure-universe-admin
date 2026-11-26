import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import type { InstantAdapter, InstantCall, InstantLog, ReadyMadeAdapter } from '@/lib/app-adapter/types';
import { reportInstantRunIn } from '@/lib/instant/report';
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
  failedWords,
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

/** The task a run belongs to, or null when it belongs to none. */
const taskKeyOf = (input: Pick<RunInput, 'taskKey'>): string | null => (input.taskKey ? input.taskKey : null);

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
  /**
   * The task this run belongs to (the same key its receipt is opened under): a rule about one task counts all of its runs, "for each task"
   * counts the task's own, and the task's receipt reads what its runs used. A call that belongs to no task has none.
   */
  taskKey?: string | null;
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
  /** Told when a run was looked up (reconcile, from a retry or the sweep), whatever it came to, so a receipt can follow the run. */
  afterSettle?(runId: string): Promise<void>;
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
  // ...but only to the one it belongs to: a saved run's answer never goes to someone else who sends the same Brick and call id
  if (known) return known.personId === input.personId ? describeKnown(known, { funds, adapter, now }) : refuse('not_owner');

  // Instant is always the Brick's owner's own, on their own Brick: no room, owner is who asked, Brick not deleted
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true, deletedAt: true, enabled: true } });
  if (!bot || bot.roomId !== null || bot.deletedAt !== null || !bot.enabled || bot.ownerId !== input.personId) return refuse('not_owner');

  if (!instant) return refuse('not_set');
  const limits = await getInstantLimits();
  if (missingInstantLimits(limits).length > 0) return refuse('not_set');
  if ((await getInstantPause()).paused) return refuse('paused');

  const admitted = admitInstantTool(input.tool, input.arguments);
  if (!admitted.ok) return refuse(admitted.reason);
  // Research Apps are on for every Brick's owner by default; one whose own App of the same service is on for this Brick uses that instead
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
      // The pause is read again here, under a lock a pause also takes: a pause made while this ask waited for the person's rules or
      // grants stops it, and a pause that comes after this commits finds a run that is going (runs going finish and settle). Taken
      // after the exposure lock; a pause never waits on that lock, so the two cannot make a cycle.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('instant:state'))`;
      // The existing run is looked for BEFORE the pause: a duplicate of a call whose run was saved while this ask waited (and which is going on
      // to be charged) is answered with that run, never with "paused", which says nothing happened. A NEW call is still refused under a pause.
      // It is only handed back from here: looking it up at Composio waits on the network, never under this lock
      const again = await tx.instantRun.findUnique({ where: { runKey } });
      if (again) return { kind: 'known', run: again };
      if ((await getInstantPause(tx)).paused) return { kind: 'refused', outcome: refuse('paused') };
      // Two asks that arrive together with different call ids both passed the check above: only one gets past this one
      const sameAsk = await openTwin(tx, input.personId, fingerprint);
      if (sameAsk) return { kind: 'refused', outcome: refuse('already_checking', { runId: sameAsk }) };
      // One question (one task) has at most so many runs, counted under this lock so two runs of one question at once cannot both slip past it.
      // A run that was refused never went out, so it does not count. While a bound is set, a run that names no question is refused: it could
      // not be counted, so leaving the key out would be a way round the bound (the bot server always sends one)
      const taskKey = taskKeyOf(input);
      if (!taskKey && limits.maxRunsPerQuestion !== null) return { kind: 'refused', outcome: refuse('no_question') };
      if (taskKey && limits.maxRunsPerQuestion !== null) {
        const runs = await tx.instantRun.count({ where: { personId: input.personId, taskKey, state: { not: 'refused' } } });
        if (runs >= limits.maxRunsPerQuestion) return { kind: 'refused', outcome: refuse('question_limit') };
      }
      const exposure = await exposureIn(tx, now);
      if (exposure + admitted.topMicros > (limits.exposureCeilingMicros ?? 0)) return { kind: 'refused', outcome: refuse('exposure_full') };
      const id = crypto.randomUUID();
      const run = await tx.instantRun.create({
        data: {
          id,
          runKey,
          botId: input.botId,
          personId: input.personId,
          taskKey: taskKeyOf(input),
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
  if (created.kind === 'known') return created.run.personId === input.personId ? describeKnown(created.run, { funds, adapter, now }) : refuse('not_owner');
  let run = created.run;

  // Step 2: the person's credit
  const held = await holdCustomer(run, funds, taskKeyOf(input));
  if (!held.ok && held.unsure === true) {
    // The books failed in a way that may have left a hold behind: it is given back now, and when that cannot be said either the run
    // stays open for the sweep, which says it again until the books answer (never closed over a hold that may exist)
    let gone = false;
    try {
      gone = holdIsGone(await funds.release({ key: fundsKey(run.id) }));
    } catch {
      gone = false;
    }
    if (!gone) {
      // A run the clean-up closed meanwhile is marked as still holding, so the sweep keeps saying the release
      await keepHolding(run.id);
      return refuse('credit_unavailable', { runId: run.id });
    }
  }
  if (!held.ok) {
    // "Unavailable" is the books being unreachable: said as that, never as the person's credit being used up
    const reason: InstantReason = held.reason === 'unavailable' ? 'credit_unavailable' : held.reason;
    // A rule's own words are kept on the run, so asking again with the same call id says the same words (not a general sentence)
    const ruleDetail = held.reason === 'rule' ? { detail: { ruleWords: held.words, leftMicros: held.leftMicros } } : {};
    await moveRun(run.id, 'reserving', { state: 'refused', reason, finishedAt: now, customerState: 'none', providerState: 'none', ...ruleDetail });
    // A rule the person said in chat that stopped the hold says so in its own words (nothing is held, and there is nothing to ask more credit for)
    return refuse(reason, held.reason === 'rule' ? { runId: run.id, words: held.words, leftMicros: held.leftMicros } : { runId: run.id });
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

/**
 * One run's own move from one state to the next, only if it is still in the state it was left in; null when something else (the
 * clean-up) got there first. Done under the run's own lock, the one the clean-up holds while it works, so a move and a clean-up never
 * interleave: the move waits for a clean-up that has begun, and then finds the run closed.
 */
async function moveRun(runId: string, from: string, data: Prisma.InstantRunUncheckedUpdateInput): Promise<Row | null> {
  try {
    return await withRun(runId, async (row, tx) => (row.state === from ? tx.instantRun.update({ where: { id: runId }, data }) : null));
  } catch (error) {
    // Not moved is the safe answer: the run is not sent, and the clean-up closes it
    console.error('[Instant] Could not move a run on:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** A closed run whose hold may still be in the books: marked as holding, which the sweep keeps releasing until the books answer. */
async function keepHolding(runId: string): Promise<void> {
  try {
    await prisma.instantRun.updateMany({ where: { id: runId, state: 'refused', customerState: 'none' }, data: { customerState: 'held' } });
  } catch (error) {
    console.error('[Instant] Could not mark the run as holding:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * A run that was taken over while its request was still on its way: the hold goes back (said again, it is idempotent) and the run is
 * answered as it now stands. When the books do not confirm the release, the closed run is marked as still holding, which the sweep
 * keeps saying again until the books answer: a hold that reached the books after the run was closed is never left behind.
 */
async function standDown(runId: string, ctx: Ctx): Promise<InstantOutcome> {
  let gone = false;
  try {
    gone = holdIsGone(await ctx.funds.release({ key: fundsKey(runId) }));
  } catch (error) {
    console.error('[Instant] The credit books could not release:', error instanceof Error ? error.message : 'unknown');
  }
  if (!gone) await keepHolding(runId);
  const row = await prisma.instantRun.findUnique({ where: { id: runId } });
  return row ? outcomeOf(row) : refuse('unclear', { runId });
}

/** Whether the books say nothing is held under a key any more: given back just now, or never held at all. A plain "no" proves neither. */
const holdIsGone = (answer: { ok: boolean; none?: boolean }): boolean => answer.ok || answer.none === true;

/** The credit hold for a run, with an error from the books read as "unavailable": a hold nobody could make is no hold. */
async function holdCustomer(run: Row, funds: InstantFunds, taskKey: string | null): Promise<Awaited<ReturnType<InstantFunds['reserve']>> & { unsure?: boolean }> {
  try {
    return await funds.reserve({
      key: fundsKey(run.id),
      personId: run.personId,
      amountMicros: asNumber(run.holdMicros),
      botId: run.botId,
      runId: run.id,
      taskKey,
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
        // The run says it failed first: the event is written from the run as it now stands
        await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason, finishedAt: ctx.now, detail: { status: call.status, code: call.code } } });
        await settleProvider({ ...run, state: 'failed' }, tx, 0, 'measured', ctx.now);
        // Composio's balance is empty: every run would fail the same way, so Instant stops until a super admin has looked
        if (reason === 'provider_empty') await pauseInstant('provider_empty', null, tx);
        return { status: 'failed', runId: run.id, reason, message: REASON_WORDS[reason] };
      }
      case 'invalid': {
        // It did not run, but Composio logs a refusal like this, so its charge is decided from the log, never assumed
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
          // It ran and did not work: the person is never charged for that (the hold goes back right after this). Our own charge, if any, is read from the log.
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
          const charged = await settleSuccess(saved, tx, charge, 'measured', limits, ctx);
          return { status: 'done', runId: run.id, ok: true, data: call.data, chargedMicros: charged, pending: true };
        }
        return { status: 'done', runId: run.id, ok: true, data: call.data, chargedMicros: 0, pending: true };
      }
    }
  });
  // The person's side, said to the books now that the transaction is over
  const settled = outcome ? await finishCustomer(runId, ctx) : null;
  await evaluatePause(ctx.now).catch((error) => console.error('[Instant] The pause check failed:', error instanceof Error ? error.message : 'unknown'));
  if (outcome && outcome.status === 'done' && outcome.ok && settled) {
    // What the books confirmed is what is answered; until they do, the answer says the charge is still pending
    return settled.customerState === 'charged' ? { ...outcome, chargedMicros: asNumber(settled.customerMicros), pending: false } : { ...outcome, pending: true };
  }
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

/**
 * The person's side of a run that is over, said to the credit books OUTSIDE any database transaction and lock (the books use their own
 * connection, so a transaction waiting on them could starve the pool): a run that worked and whose charge is known is charged, a run
 * that failed or was closed gets its hold back. Both are idempotent in the books (a second ask answers as the first did), so it never
 * matters if two of these run at once. Only a confirmed answer is recorded; anything else leaves the run held and the sweep says it again.
 * Returns the run as it now stands.
 */
async function finishCustomer(runId: string, ctx: Pick<Ctx, 'funds'> & { now?: Date }): Promise<Row | null> {
  const run = await prisma.instantRun.findUnique({ where: { id: runId } });
  if (!run || run.customerState !== 'held') return run;
  if (run.state === 'succeeded') {
    if (run.providerState !== 'settled' || run.providerMicros === null) return run;
    const limits = await getInstantLimits();
    const providerMicros = asNumber(run.providerMicros);
    // The markup the hold was made with, never today's: a settlement said again after a markup change asks the books for the same amount
    const charge = customerChargeFor(providerMicros, asNumber(run.holdMicros), run.markupBps ?? limits.markupBps);
    let confirmed: number | null = null;
    try {
      // Read as what a books adapter may actually send: the amount is checked at run time, whatever the type promises
      const answer: { ok: boolean; chargedMicros?: unknown } = await ctx.funds.settle({ key: fundsKey(run.id), chargeMicros: charge, providerCostMicros: providerMicros });
      // A settlement the books took before (and this side never recorded) answers with its FIRST amount: that is what the person was
      // charged, so that is what is recorded, whatever today's figures work out to. A yes without a readable amount is not taken as done.
      const amount = answer.chargedMicros;
      if (answer.ok && typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) confirmed = amount;
    } catch (error) {
      console.error('[Instant] The credit books could not settle:', error instanceof Error ? error.message : 'unknown');
    }
    if (confirmed === null) return run;
    // The run is marked charged and the meter event says so in one step: when the event cannot be updated, the run stays held, and the next
    // sweep asks the books again (they answer with the same first amount) and writes both. Marked charged first, a failure here would leave the
    // event saying "not known" for good, as nothing looks at a charged run again (the sweep's repair would still find it, but the person's side
    // and the books' copy of it are one step).
    await prisma.$transaction(async (tx) => {
      // Under the run's own lock, like every other writer of the run (late evidence, a lookup, the repair of an event): a repair that read the run
      // before this step cannot write the event with "not known" after this step has looked for it and found nothing to update
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`instant:run:${run.id}`}, 0))`;
      await tx.instantRun.updateMany({ where: { id: runId, customerState: 'held' }, data: { customerState: 'charged', customerMicros: BigInt(confirmed) } });
      // The meter event of the run says what the person was charged only from here, at the amount the books confirmed: the one writer of the event
      await reportInstantRunIn(tx, runId, ctx.now ?? new Date(), { insertIsBestEffort: true });
    });
  } else if (run.state === 'failed' || run.state === 'refused') {
    let gone = false;
    try {
      gone = holdIsGone(await ctx.funds.release({ key: fundsKey(run.id) }));
    } catch (error) {
      console.error('[Instant] The credit books could not release:', error instanceof Error ? error.message : 'unknown');
    }
    if (!gone) return run;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`instant:run:${run.id}`}, 0))`;
      await tx.instantRun.updateMany({ where: { id: runId, customerState: 'held' }, data: { customerState: 'released', customerMicros: BigInt(0) } });
      await reportInstantRunIn(tx, runId, ctx.now ?? new Date(), { insertIsBestEffort: true });
    });
  } else {
    // Still going: nothing is decided on the person's side yet
    return run;
  }
  return prisma.instantRun.findUnique({ where: { id: runId } });
}

/**
 * Composio's charge is known: written on the run (provider side) and once to the meter's books. A charge above the top price
 * means the table is too low: the run still settles, the excess is ours, and Instant stops.
 */
async function settleProvider(run: Row, tx: Prisma.TransactionClient, micros: number, basis: 'measured' | 'estimated', now: Date): Promise<void> {
  if (run.providerState === 'settled') return;
  const finishedAt = run.finishedAt ?? now;
  await tx.instantRun.update({ where: { id: run.id }, data: { providerState: 'settled', providerMicros: BigInt(micros), providerBasis: basis, finishedAt } });
  // The meter event is a copy for the books: if it cannot be written, the settlement still stands (the sweep mends it from the run's own rows, see
  // `repairInstantReporting`). It is written by the same writer as every later correction (`reportInstantRunIn`: one place decides what the event says, from the run
  // as it now stands in this transaction, never from a copy made here), inside a savepoint, because a failed statement otherwise leaves the whole transaction
  // aborted, and the settlement above would fail with it. What the person was charged is whatever the credit books have confirmed by now (pending until they
  // have, and pending for a run whose hold is still being given back): the amount the hold would be settled at is a calculation, never written as a charge
  await tx.$executeRaw`SAVEPOINT instant_meter_event`;
  try {
    await reportInstantRunIn(tx, run.id, now, { insertIsBestEffort: true });
    await tx.$executeRaw`RELEASE SAVEPOINT instant_meter_event`;
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT instant_meter_event`;
    console.error('[Instant] Could not write the meter event:', error instanceof Error ? error.message : 'unknown');
  }
  if (micros > asNumber(run.topMicros)) await pauseInstant('price_over_top', null, tx);
}

/**
 * A run that worked and whose charge is known: the provider side is settled (inside the caller's transaction). What the person is
 * charged is said to the credit books afterwards, outside it (`finishCustomer`); the amount returned is what that will ask for.
 */
async function settleSuccess(run: Row, tx: Prisma.TransactionClient, providerMicros: number, basis: 'measured' | 'estimated', limits: InstantLimits, ctx: Ctx): Promise<number> {
  const charged = customerChargeFor(providerMicros, asNumber(run.holdMicros), run.markupBps ?? limits.markupBps);
  await settleProvider(run, tx, providerMicros, basis, ctx.now);
  return charged;
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
    case 'refused': {
      const detail = isObject(run.detail) ? run.detail : null;
      if (run.reason === 'rule' && detail && typeof detail.ruleWords === 'string') {
        return refuse('rule', { runId: run.id, words: detail.ruleWords, leftMicros: typeof detail.leftMicros === 'number' ? detail.leftMicros : null });
      }
      return refuse((run.reason as InstantReason) ?? 'unclear', { runId: run.id });
    }
    case 'failed': {
      const reason = (run.reason as InstantReason) ?? 'provider_failed';
      return { status: 'failed', runId: run.id, reason, message: failedWords(reason) };
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

/** How long after it was released a run let go unconfirmed is still looked for in Composio's log (late evidence), in days. */
const LATE_EVIDENCE_DAYS = 35;

/**
 * How far apart two looks at the same run's log are, by how long ago the run was let go: often while a log line is likely to turn up, then less and less.
 * Counted from the run's last look (`checkedAt`, which every look stamps), so a run whose log has no line yet (or a line nobody can read) is asked again
 * only when its spacing has passed, never on every sweep. Every run is due again after its spacing, so none is skipped for ever, and the 35 days are the limit.
 */
const LATE_LOOK_BANDS: ReadonlyArray<{ fromHours: number; everyMinutes: number }> = [
  { fromHours: 0, everyMinutes: 15 },
  { fromHours: 24, everyMinutes: 2 * 60 },
  { fromHours: 7 * 24, everyMinutes: 12 * 60 },
];

/** The spacing, in minutes, between two looks at a run let go `ageMs` ago. */
export function lateLookSpacingMinutes(ageMs: number): number {
  const hours = ageMs / (60 * MINUTE);
  let every = LATE_LOOK_BANDS[0].everyMinutes;
  for (const band of LATE_LOOK_BANDS) if (hours >= band.fromHours) every = band.everyMinutes;
  return every;
}

/**
 * The runs that are due a look at their log now: let go unconfirmed, vendor cost still the estimate, late evidence not all in (none written yet, or a success whose
 * charge is not posted yet: the same question `awaitsLateEvidence` asks of one run), let go within the 35 days, and not looked at since their spacing began.
 */
export function lateRunsDueWhere(now: Date): Prisma.InstantRunWhereInput {
  const ago = (hours: number) => new Date(now.getTime() - hours * 60 * MINUTE);
  const bands = LATE_LOOK_BANDS.map((band, index) => {
    const older = LATE_LOOK_BANDS[index + 1];
    return {
      finishedAt: { ...(older ? { gt: ago(older.fromHours) } : { gte: ago(LATE_EVIDENCE_DAYS * 24) }), lte: ago(band.fromHours) },
      OR: [{ checkedAt: null }, { checkedAt: { lte: new Date(now.getTime() - band.everyMinutes * MINUTE) } }],
    };
  });
  return {
    state: 'failed',
    providerBasis: 'estimated',
    AND: [
      { OR: [{ detail: { path: ['releasedUnconfirmed'], equals: true } }, { detail: { path: ['noLog'], equals: true } }, { detail: { path: ['unreadableLog'], equals: true } }] },
      { OR: [{ detail: { path: ['lateEvidence'], equals: Prisma.DbNull } }, { AND: [{ detail: { path: ['lateEvidence', 'status'], equals: 'success' } }, { detail: { path: ['lateEvidence', 'chargeMicros'], equals: Prisma.JsonNull } }] }] },
      { OR: bands },
    ],
  };
}

/**
 * A run nobody could vouch for: let go after Composio could not be asked (`releasedUnconfirmed`), or let go after the wait with no log line of it
 * (`noLog`) or a line nobody could read (`unreadableLog`). All three end the same way for the person (nothing taken, hold given back) and all three
 * are looked for in Composio's log a while longer.
 */
function isLetGoUnconfirmed(detail: unknown): boolean {
  return isObject(detail) && (detail.releasedUnconfirmed === true || detail.noLog === true || detail.unreadableLog === true);
}

/**
 * A run let go unconfirmed whose vendor cost is still the estimate and whose late evidence is not all in: not read yet, or a success was read whose charge
 * is not posted yet. Only its own log is asked, for a bounded time: what it finds changes the vendor side and what the receipt says, never what the person pays
 * (see `applyLateEvidence`).
 */
function awaitsLateEvidence(run: Row, now: Date): boolean {
  if (run.state !== 'failed' || run.providerBasis !== 'estimated' || !isLetGoUnconfirmed(run.detail)) return false;
  const seen = isObject(run.detail) ? run.detail.lateEvidence : undefined;
  // A success that is written down but has no charge yet is looked for again until the charge turns up (or the days run out); any other answer is final
  if (seen !== undefined && !(isObject(seen) && seen.status === 'success' && (seen.chargeMicros === null || seen.chargeMicros === undefined))) return false;
  return !run.finishedAt || now.getTime() - run.finishedAt.getTime() <= LATE_EVIDENCE_DAYS * 24 * 60 * MINUTE;
}

/**
 * What a log found after a run was let go unconfirmed does. The person's side never moves: their hold went back, they are not charged
 * later whatever the log says (a late success is theirs free, a late failure changes nothing for them), and the App is never run again. The
 * run keeps its own outcome (released unconfirmed, not "worked" and not "did not work"); what the log said is written down on it. The vendor
 * side: a charge on the line replaces the estimate (the books and the meter event say measured, with the estimate and the verified figure kept
 * on the run), so a vendor charge above or below the estimate is the real one, once.
 */
export async function applyLateEvidence(run: Row, line: InstantLog, tx: Prisma.TransactionClient, now: Date): Promise<void> {
  // What the run says about itself is read again here with the row locked, and that is what is written back: another writer of the run's detail (the follow-up to the person writes the batch number it
  // offered and when it was told, into the same detail) is never undone by a copy read earlier. Their marks are UPDATEs, which take the same lock, so the two serialise
  const [locked] = await tx.$queryRaw<Array<{ detail: unknown }>>`SELECT "detail" FROM "instant_runs" WHERE "id" = ${run.id} FOR UPDATE`;
  const detail = isObject(locked?.detail) ? locked.detail : isObject(run.detail) ? run.detail : {};
  const estimated = asNumber(run.providerMicros);
  const verified = line.chargeMicros;
  // A line that says the tool worked but carries no charge yet (it may be posted later): that it worked is written down at once (so the receipt can say so, and it never
  // waits on a charge that may not come), and the run is looked for again until the charge turns up or the days run out. A failed or unknown line is the answer as it is,
  // and is written down once.
  // A line Composio has no word on yet (still running, or a word we cannot read) says nothing new: it is not written down, and the run is looked for again
  if (line.status === 'unknown') return;
  if (verified === null && line.status === 'success') {
    if (isObject(detail.lateEvidence)) return;
    await tx.instantRun.update({ where: { id: run.id }, data: { detail: { ...detail, lateEvidence: { status: line.status, chargeMicros: null, at: now.toISOString() } } as Prisma.InputJsonValue } });
    return;
  }
  const next = { ...detail, lateEvidence: { status: line.status, chargeMicros: verified, at: now.toISOString() }, ...(verified !== null ? { adjustment: { estimatedMicros: estimated, verifiedMicros: verified } } : {}) };
  await tx.instantRun.update({
    where: { id: run.id },
    data: { detail: next as Prisma.InputJsonValue, ...(verified !== null ? { providerMicros: BigInt(verified), providerBasis: 'measured', providerLogId: run.providerLogId ?? line.id } : {}) },
  });
  // The event says the figure that was found: the one writer of the event corrects it (once; a second look finds nothing to change), and keeps what it said before
  if (verified !== null) await reportInstantRunIn(tx, run.id, now, { insertIsBestEffort: true });
  // A figure found late that is above the top price means the table is too low, as for one found on time: Instant stops (the person's side is not touched)
  if (verified !== null && verified > asNumber(run.topMicros)) await pauseInstant('price_over_top', null, tx);
}

/**
 * The follow-up to the person about an App that went out after all keeps two small marks on the run's own detail (never money): the batch number it was offered under, and when
 * the person was told. They are written here, so the run's record has ONE writer; `lib/computer-report.ts` decides which runs and when. Each is a single-key UPDATE of the detail, which takes
 * the row lock `applyLateEvidence` also takes, so neither undoes the other.
 */
export async function tagLateBatch(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, runIds: string[], batch: number): Promise<void> {
  if (runIds.length === 0) return;
  // The number the follow-up was offered under, and the place of each run in it (the order the runs were named, which is the order the report names their Apps in, the same on every retry)
  await tx.$executeRaw(Prisma.sql`
    UPDATE "instant_runs" i SET "detail" = jsonb_set(jsonb_set(i."detail", '{lateBatch}', to_jsonb(${batch}::int)), '{lateOrder}', to_jsonb(t."ord"::int))
    FROM unnest(${runIds}::text[]) WITH ORDINALITY AS t("id", "ord")
    WHERE i."id" = t."id" AND i."detail"->'lateBatch' IS NULL`);
}

/** The person was told (or it can never be told): the runs of that follow-up (this person's, this Brick's, this job's, carrying that number) are marked, once. */
export async function markLateTold(jobId: string, personId: string, botId: string, batch: number, toldAt: Date): Promise<void> {
  const told = JSON.stringify(toldAt.toISOString());
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "instant_runs" i SET "detail" = jsonb_set(i."detail", '{lateToldAt}', ${told}::jsonb)
    WHERE i."task_key" = ${jobId} AND i."person_id" = ${personId} AND i."bot_id" = ${botId} AND i."detail"->>'lateBatch' = ${String(batch)}
      AND i."detail"->'lateEvidence'->>'status' = 'success' AND i."detail"->'lateToldAt' IS NULL`);
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
  await prisma.instantRun.updateMany({ where: { id: runId }, data: { checkedAt: ctx.now } });
  const late = awaitsLateEvidence(seen, ctx.now);
  const looked = instant && (late || needsLookup(seen, ctx.now, limits)) ? await lookUp(seen, instant, ctx.now) : null;
  await withRun(runId, async (run, tx) => {
    const now = ctx.now;
    const waitedPast = (from: Date | null, minutes: number) => !from || now.getTime() - from.getTime() >= minutes * MINUTE;

    // Crashed between its steps: it never went out, so it never cost anything
    if ((run.state === 'reserving' || run.state === 'held') && waitedPast(run.createdAt, limits.sentWaitMinutes)) {
      // The run is CLOSED first (committed before the books are asked), marked as possibly still holding: from then on nothing can send
      // it, whatever happens to the release or to this transaction. The hold is then given back, and the mark cleared only when the
      // books say it is gone (given back just now, or confirmed not to exist); a plain "no" leaves the mark, and the sweep asks again.
      await tx.instantRun.update({ where: { id: run.id }, data: { state: 'refused', reason: 'unclear', customerState: 'held', providerState: 'none', finishedAt: now } });
      return;
    }

    // A run let go unconfirmed: a log found later only corrects the vendor side and says what it said; nothing else about the run moves
    if (awaitsLateEvidence(run, now)) {
      if (looked?.line) await applyLateEvidence(run, looked.line, tx, now);
      return;
    }
    // A run that just went out is still in flight: it is not looked up (and never called unclear) until its wait is over
    if (!needsLookup(run, now, limits)) return;
    if (!looked) {
      // Composio's log could not be asked. Nothing is decided on that guess, but not for ever: a run still unknown a long while after it
      // went out must not keep the person's credit held and our exposure counted. It is written off as failed with the hold given back,
      // marked so the Costs report says it was let go unconfirmed (if it did go through, the person got the work free).
      if ((run.state === 'sent' || run.state === 'ambiguous') && waitedPast(run.sentAt ?? run.createdAt, limits.unreachableWaitMinutes)) {
        await tx.instantRun.update({ where: { id: run.id }, data: { state: 'failed', reason: 'unclear', finishedAt: now, detail: { releasedUnconfirmed: true, unreachableWaitMinutes: limits.unreachableWaitMinutes } } });
        await settleProvider({ ...run, state: 'failed' }, tx, asNumber(run.topMicros), 'estimated', now);
        console.error('[Instant] Released a run unconfirmed: the log could not be reached for', limits.unreachableWaitMinutes, 'minutes. Run', run.id);
      }
      return;
    }
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
  // The person's side of whatever is over, said to the books now that the transaction is done (never inside it)
  await finishCustomer(runId, ctx);
  await evaluatePause(ctx.now).catch((error) => console.error('[Instant] The pause check failed:', error instanceof Error ? error.message : 'unknown'));
  // The task's receipt follows what the run came to. Never throws into the sweep: a receipt that could not be moved now is moved by the
  // sweep's own pass over receipts still in checking.
  await hooks.afterSettle?.(runId).catch((error) => console.error('[Instant] A receipt hook failed:', error instanceof Error ? error.message : 'unknown'));
}

// ---------- Stopping by itself ----------

/**
 * Pauses Instant when too many of the recent runs ended as failures (a share a super admin sets, over a set time, once a set number
 * of runs has happened). Give-backs after a charge count as failures too. New runs stop; runs going finish and settle.
 */
export async function evaluatePause(now: Date = new Date()): Promise<boolean> {
  const limits = await getInstantLimits();
  if (limits.pauseFailureRateBps === null || limits.pauseMinRuns === null) return false;
  // Runs that finished before a super admin last turned Instant back on are the ones they already looked at: they never pause it again
  const resumedAt = (await getInstantPause()).resumedAt ?? null;
  const windowStart = now.getTime() - limits.pauseWindowMinutes * MINUTE;
  const since = new Date(Math.max(windowStart, resumedAt ? Date.parse(resumedAt) || 0 : 0));
  // Details Composio would not take are the caller's, not the provider's: they are not runs the failure rate is about
  const notInvalid = { OR: [{ reason: null }, { reason: { not: 'invalid_request' } }] };
  // All the counts are read from one snapshot: a run that finishes, or a give-back the books confirm, while they are being read is in all of them or in none,
  // so a rate is never made of a count from before it and another from after
  const { done, failed, givenBack } = await prisma.$transaction(
    async (tx) => {
      const done = await tx.instantRun.count({ where: { state: { in: ['succeeded', 'failed'] }, finishedAt: { gte: since }, ...notInvalid } });
      const failed = await tx.instantRun.count({ where: { state: 'failed', finishedAt: { gte: since }, ...notInvalid } });
      // Only a give-back the books confirmed with credit actually given (a confirmed zero gave nothing), and only for a run that is itself in this
      // window: a give-back for an older run, or one the books never made, is not a failure of the runs being counted
      const refunded = await tx.instantRefund.findMany({ where: { kind: 'goodwill', amountMicros: { gt: 0 }, confirmedAt: { not: null, gte: since } }, select: { runId: true } });
      const givenBack = refunded.length === 0 ? 0 : await tx.instantRun.count({ where: { id: { in: refunded.map((one) => one.runId) }, state: 'succeeded', finishedAt: { gte: since }, ...notInvalid } });
      return { done, failed, givenBack };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (done < limits.pauseMinRuns) return false;
  const rate = Math.floor(((failed + givenBack) * 10_000) / done);
  if (rate < limits.pauseFailureRateBps) return false;
  // A super admin who turned Instant back on while the counts were being read has looked at these runs: the pause is dropped
  // unless the resume time is still the one they were counted after (compared under the state lock)
  return (await pauseInstant('failure_rate', null, undefined, resumedAt)).paused;
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
  // Not set stops a NEW give-back only: one the books may already have made is finished first, whatever the limits are now
  const limitsSet = !(limits.goodwillMaxMicros === null || limits.goodwillMaxMicros < 1 || limits.goodwillBudgetMicros === null || limits.goodwillPerPersonPerMonth === null || limits.goodwillPerPersonPerMonth < 1);
  const month = monthOf(now);
  const refundKey = `goodwill:${input.runId}`;
  // Step 1, under the give-back lock: the checks, and the INTENT saved (committed) before the books are asked. A give-back the books made
  // and this side never recorded is then found again by the retry, which finishes it at the amount the books confirm, never refusing it
  // on a limit that moved in between.
  /** The checks for a NEW give-back (never for one the books may already have made), under the give-back lock. */
  const checkNew = async (tx: Prisma.TransactionClient, run: Row, ownRowId?: string): Promise<{ amount: number } | { done: GiveBackOutcome }> => {
    if (!limitsSet) return { done: { status: 'refused', reason: 'not_set' } };
    const [person, everyone] = await Promise.all([
      // The person's limit counts every give-back that stands or MAY stand: one let go of (the books never confirmed it) may still have been made,
      // and the books do not enforce this limit, so it keeps its place for as long as late evidence about it is looked for. The row being
      // checked again is never counted against itself.
      tx.instantRefund.count({
        where: {
          personId: input.personId,
          kind: 'goodwill',
          createdAt: { gte: month.start, lt: month.end },
          // A give-back the books confirmed at zero gave nothing, so it does not use up one of the person's give-backs
          amountMicros: { gt: 0 },
          OR: [{ releasedAt: null }, { confirmedAt: null, createdAt: { gte: new Date(now.getTime() - LATE_EVIDENCE_DAYS * 24 * 60 * MINUTE) } }],
          ...(ownRowId ? { id: { not: ownRowId } } : {}),
        },
      }),
      // The month's budget is enforced by the books themselves, so a give-back let go of no longer counts here
      tx.instantRefund.aggregate({ where: { kind: 'goodwill', releasedAt: null, createdAt: { gte: month.start, lt: month.end } }, _sum: { amountMicros: true } }),
    ]);
    if (person >= limits.goodwillPerPersonPerMonth!) return { done: { status: 'refused', reason: 'person_limit' } };
    const amount = Math.min(asNumber(run.customerMicros) - asNumber(run.refundedMicros), limits.goodwillMaxMicros!);
    if (amount < 1) return { done: { status: 'refused', reason: 'not_charged' } };
    if (asNumber(everyone._sum.amountMicros) + amount > limits.goodwillBudgetMicros!) return { done: { status: 'refused', reason: 'budget' } };
    return { amount };
  };
  const planned = await prisma.$transaction(
    async (tx): Promise<{ go: { amount: number; runId: string; personId: string } } | { released: { amount: number; runId: string; personId: string } } | { done: GiveBackOutcome }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:goodwill'))`;
      const run = await tx.instantRun.findUnique({ where: { id: input.runId } });
      if (!run || run.personId !== input.personId) return { done: { status: 'refused', reason: 'not_found' } };
      if (run.state !== 'succeeded' || run.customerState !== 'charged' || asNumber(run.customerMicros) <= 0) return { done: { status: 'refused', reason: 'not_charged' } };
      const earlier = await tx.instantRefund.findUnique({ where: { refundKey } });
      // A give-back the books confirmed at zero gave the person nothing: it says so (never "given 0"), and it never used up a give-back of theirs
      if (earlier?.confirmedAt) return { done: { status: 'refused', reason: asNumber(earlier.amountMicros) > 0 ? 'already_given' : 'not_charged' } };
      // An intent the books may already have acted on: finished at its own amount, before any limit is applied to a new give-back
      if (earlier && !earlier.releasedAt) return { go: { amount: asNumber(earlier.amountMicros), runId: run.id, personId: run.personId } };
      // An intent let go of: the books are asked first (read only), because letting go says only that they did not answer, not that they did nothing
      if (earlier) return { released: { amount: asNumber(earlier.amountMicros), runId: run.id, personId: run.personId } };
      const checked = await checkNew(tx, run);
      if ('done' in checked) return checked;
      await tx.instantRefund.create({ data: { refundKey, runId: run.id, personId: run.personId, kind: 'goodwill', amountMicros: BigInt(checked.amount) } });
      return { go: { amount: checked.amount, runId: run.id, personId: run.personId } };
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
  if ('done' in planned) return planned.done;

  /** What the books say they gave under the key, read only; a failed look is "not known". */
  const lookUp = async (runId: string): Promise<Awaited<ReturnType<InstantFunds['refundLookup']>>> => {
    try {
      return await funds.refundLookup({ key: fundsKey(runId), refundKey });
    } catch (error) {
      console.error('[Instant] The credit books could not be asked about a give-back:', error instanceof Error ? error.message : 'unknown');
      return { status: 'unavailable' };
    }
  };
  let go = 'go' in planned ? planned.go : planned.released;
  let answer: { ok: boolean; refundedMicros?: number; reason?: string } | null = null;
  if ('released' in planned) {
    // Step 1b: a give-back let go of is never made as if it were new until the books say they never made it
    const seen = await lookUp(go.runId);
    // Not known: the row stays as it is, and it is asked about again later
    if (seen.status === 'unavailable') return { status: 'refused', reason: 'unavailable' };
    if (seen.status === 'found') {
      // They made it: recorded at their amount, whatever the limits are by now
      answer = { ok: true, refundedMicros: seen.refundedMicros };
    } else {
      // They never did: it is a new give-back after all, so it meets the limits as they stand now (and the slot it had may be taken). Refused:
      // the intent goes. Allowed: it counts again from now, then it is made.
      const again = await prisma.$transaction(
        async (tx): Promise<{ go: typeof go } | { done: GiveBackOutcome }> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:goodwill'))`;
          const run = await tx.instantRun.findUnique({ where: { id: input.runId } });
          const row = await tx.instantRefund.findUnique({ where: { refundKey } });
          if (!run || !row || row.confirmedAt) return { done: { status: 'refused', reason: 'unavailable' } };
          if (!row.releasedAt) return { go: { amount: asNumber(row.amountMicros), runId: run.id, personId: run.personId } };
          if (run.state !== 'succeeded' || run.customerState !== 'charged' || asNumber(run.customerMicros) <= 0) {
            await tx.instantRefund.deleteMany({ where: { id: row.id, confirmedAt: null } });
            return { done: { status: 'refused', reason: 'not_charged' } };
          }
          const checked = await checkNew(tx, run, row.id);
          // The limits as they stand refuse a NEW give-back, but the books' first request may still be in flight and commit afterwards: the intent is KEPT
          // (let go of, asked about again later) so that a refund they did make is still found and recorded; it authorizes nothing new
          if ('done' in checked) return checked;
          await tx.instantRefund.update({ where: { id: row.id }, data: { releasedAt: null, createdAt: now, amountMicros: BigInt(checked.amount) } });
          return { go: { amount: checked.amount, runId: run.id, personId: run.personId } };
        },
        { maxWait: 15_000, timeout: 30_000 },
      );
      if ('done' in again) return again.done;
      go = again.go;
    }
  }

  // Step 2: the books, outside any transaction
  if (!answer) {
    try {
      answer = await funds.refund({ key: fundsKey(go.runId), refundKey, amountMicros: go.amount, reason: 'goodwill', limits: { giveBackMaxMicros: limits.goodwillMaxMicros, goodwillBudgetMicros: limits.goodwillBudgetMicros } });
    } catch (error) {
      console.error('[Instant] The credit books could not give back:', error instanceof Error ? error.message : 'unknown');
      // Not known whether they gave it: the intent stays, and asking again finishes it
      return { status: 'refused', reason: 'unavailable' };
    }
    if (!answer.ok && answer.reason === 'key_reused') {
      // The books answer this only when a give-back already stands under the key (with another amount or reason: the first one, still in flight
      // when this one was asked, has since been made): it is the one recorded, at what the books say they gave. Not known: the intent stays.
      const seen = await lookUp(go.runId);
      if (seen.status !== 'found') return { status: 'refused', reason: 'unavailable' };
      answer = { ok: true, refundedMicros: seen.refundedMicros };
    }
    if (!answer.ok) {
      // "Unavailable" may be the books failing after they acted: the intent stays and a later ask finishes it. Any other no is a decision that
      // proves nothing was given (over the budget, not set, too much, not settled), so the intent goes
      if (answer.reason !== 'unavailable') await prisma.instantRefund.deleteMany({ where: { refundKey, confirmedAt: null } });
      return { status: 'refused', reason: 'unavailable' };
    }
  }

  // Step 3: recorded at what the books confirm (a give-back made before and said again answers with its first amount)
  // A confirmed zero is a zero (the books can give nothing back: an ended lot with no replacement allowed): it is recorded as that, never as the
  // amount asked for. An answer without a readable amount is not a confirmation: the intent stays and the books are asked again.
  const confirmed = answer.refundedMicros;
  if (typeof confirmed !== 'number' || !Number.isSafeInteger(confirmed) || confirmed < 0) return { status: 'refused', reason: 'unavailable' };
  const given = confirmed;
  const outcome = await prisma.$transaction(async (tx): Promise<GiveBackOutcome> => {
    const { count } = await tx.instantRefund.updateMany({ where: { refundKey, confirmedAt: null }, data: { confirmedAt: now, releasedAt: null, amountMicros: BigInt(given) } });
    if (count === 1 && given > 0) await tx.instantRun.update({ where: { id: go.runId }, data: { refundedMicros: { increment: BigInt(given) } } });
    // Nothing was given back (the books had nothing to give): the person is told so, not "gave back 0"
    if (given === 0) return { status: 'refused', reason: 'not_charged' };
    return { status: 'given', amountMicros: given };
  });
  if (outcome.status === 'given') await evaluatePause(now).catch(() => undefined);
  return outcome;
}

/** How long a give-back the books have not confirmed is left before the sweep asks again, in minutes. Pacing only: nothing is decided by it. */
const GOODWILL_RETRY_AFTER_MINUTES = 5;
/** A give-back let go of (the books stayed unreachable for the whole wait) is asked about again this long after the last ask, and for as long as late evidence about a run is looked for. */
const GOODWILL_RELEASED_RETRY_MINUTES = 90;

export interface GoodwillSweep {
  looked: number;
  /** Finished: the books confirmed them, or said no (so the intent was dropped). */
  settled: number;
  /** Let go: the books stayed unreachable for the whole wait, so the intent no longer uses up the month's budget. */
  released: number;
}

/**
 * Gives goodwill give-backs that the books never confirmed another try, and lets go of the ones the books could not be reached about for
 * the whole wait. An intent is saved before the books are asked, so one that failed in between stays "unconfirmed" and keeps counting
 * against the month's give-back budget. The books answer a key they have seen with its first amount, so asking again is safe: a retry
 * finishes it (confirmed, or dropped when the books say no). One still unconfirmed after `unreachableWaitMinutes` is released: marked
 * (the row stays), so it no longer counts against the month's budget or the person's limit. It is still asked about, slowly, for as long
 * as late evidence about a run is looked for: if the books did make the give-back, the answer carries their first amount and it is
 * confirmed and recorded then, at that amount, whatever the limits are by now.
 */
export async function sweepGoodwill(deps: Deps & { batch?: number } = {}): Promise<GoodwillSweep> {
  const now = deps.now ?? new Date();
  const limits = await getInstantLimits();
  const askedBefore = new Date(now.getTime() - GOODWILL_RETRY_AFTER_MINUTES * MINUTE);
  const releasedAskedBefore = new Date(now.getTime() - GOODWILL_RELEASED_RETRY_MINUTES * MINUTE);
  // Never-asked first, then the longest ago asked: a few intents the books stay unreachable about must not fill every batch and leave the rest
  // never asked. The pause between two asks of the same intent counts from the last time it was asked, not from when it was made: 5 minutes for one
  // still held, 90 for one let go of (kept, and asked about only inside the days late evidence is looked for).
  const open = await prisma.instantRefund.findMany({
    where: {
      kind: 'goodwill',
      confirmedAt: null,
      OR: [
        { releasedAt: null, createdAt: { lte: askedBefore }, AND: [{ OR: [{ lastTriedAt: null }, { lastTriedAt: { lte: askedBefore } }] }] },
        {
          releasedAt: { lte: releasedAskedBefore },
          createdAt: { gte: new Date(now.getTime() - LATE_EVIDENCE_DAYS * 24 * 60 * MINUTE) },
          AND: [{ OR: [{ lastTriedAt: null }, { lastTriedAt: { lte: releasedAskedBefore } }] }],
        },
      ],
    },
    orderBy: [{ lastTriedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: deps.batch ?? 50,
    select: { id: true, refundKey: true, runId: true, personId: true, createdAt: true, releasedAt: true },
  });
  const result: GoodwillSweep = { looked: open.length, settled: 0, released: 0 };
  for (const intent of open) {
    await prisma.instantRefund.updateMany({ where: { id: intent.id, confirmedAt: null }, data: { lastTriedAt: now } });
    const outcome = await giveBack({ personId: intent.personId, runId: intent.runId }, { ...deps, now }).catch((error): GiveBackOutcome => {
      console.error('[Instant] Could not finish a give-back:', error instanceof Error ? error.message : 'unknown');
      return { status: 'refused', reason: 'unavailable' };
    });
    // The row looked at, not whichever row has its key by now: a row that was dropped and made again under the same key is not this one
    const stillThere = await prisma.instantRefund.findUnique({ where: { id: intent.id }, select: { confirmedAt: true } });
    if (!stillThere || stillThere.confirmedAt) {
      result.settled += 1;
      continue;
    }
    if (outcome.status !== 'refused') continue;
    if (intent.releasedAt) {
      // Let go before and still not confirmed: asked again after another stretch
      await prisma.instantRefund.updateMany({ where: { id: intent.id, confirmedAt: null, releasedAt: { not: null } }, data: { releasedAt: now } });
    } else if (now.getTime() - intent.createdAt.getTime() >= limits.unreachableWaitMinutes * MINUTE) {
      // The row as it was looked at (its age as well): a row let go of and made again meanwhile (same id, a new age) is a new reservation, never released by the
      // age of the old one
      const { count } = await prisma.instantRefund.updateMany({ where: { id: intent.id, confirmedAt: null, releasedAt: null, createdAt: intent.createdAt }, data: { releasedAt: now } });
      if (count > 0) {
        result.released += 1;
        console.error('[Instant] Let go of a give-back the books never confirmed (kept to finish it when they answer):', intent.refundKey);
      }
    }
  }
  return result;
}
