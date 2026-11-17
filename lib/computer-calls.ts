import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { COMPUTER_LIMITS_DEFAULT, givenBackJob, readComputerLimits, type ComputerLimits, type StepRefusal } from '@/lib/computer-values';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { closeRoomsAndBook, currentEnvelope, poolOnlyKey, releaseRoom, reserveRoom, type Room } from '@/lib/meter-allowance';
import { captureExtraCredit, creditCheck, giveBackJobCredit, holdForJob, prepareComputerCredit, releaseCreditHold, resolveFunding, settleCallCredit } from '@/lib/computer-credit';
import { recordProviderCost, refundHold } from '@/lib/credit-spend';
import { computerCanRun, formatOf } from '@/lib/computer-capability';
import { twoAmounts } from '@/lib/computer-estimate';
import { verifyJobToken } from '@/lib/computer-token';

/**
 * A model call a Brick's computer makes (build handoff v2, section 5): room is taken BEFORE the call, and what it really cost is
 * written and settled after, whether it finished, was cut off or failed.
 *
 * Orbit decides and keeps the books; the call itself runs where the AI providers already are (the bot server, which has every
 * provider's way of talking, its price list and its key). That side asks here first:
 *  1. `authorizeModelCall`: the computer's key is checked against Orbit's records (the job still holds the machine, the key is
 *     for models, it is from the current control generation), and the room for this one call is reserved inside the pool and held from
 *     the person's computer credit (the same lots Usage shows). No room: the call is refused with the reason, and nothing was sent anywhere.
 *  2. The call runs.
 *  3. `settleModelCall`: the figures go to the books once (a retry adds nothing) and the room is settled to what it cost. A call
 *     whose price is unknown settles at the room that was held, never at 0.
 *  or `releaseModelCall` when nothing was sent.
 *
 * Whoever pays comes from Orbit's records, never from the computer: a call on the owner's own key costs the platform nothing and
 * takes no room from the pool, but is checked, counted and recorded the same way.
 */

const CALL_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_MICROS = 2_000_000_000;

export const callRoomKey = (jobId: string, callId: string) => `computer:call:${jobId}:${callId}`;

export type Authorized =
  | { ok: true; jobId: string; botId: string; personId: string; /** Null when the call is on the owner's own key: no room was taken. */ reservedMicros: number | null }
  /** The key is not good (any reason), or the call id is not one. The same answer, so nothing is learned from it. */
  | { ok: false; reason: 'refused' }
  /** The person's own computer allowance is used up: "Ask for more". */
  | { ok: false; reason: 'allowance' }
  /** Our pool, or the controls, have no room: nothing the person can ask for. */
  | { ok: false; reason: 'pool' }
  /** A rule the person said in chat does not let this call take that much: the rule's own words, and nothing to ask more credit for. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

export async function authorizeModelCall(
  input: { token: string; callId: string; estimateMicros: number; payer: 'universe' | 'own-key' },
  now: Date = new Date(),
): Promise<Authorized> {
  if (!CALL_ID.test(input.callId)) return { ok: false, reason: 'refused' };
  const verified = await verifyJobToken(input.token, 'model', now);
  if (!verified.ok) return { ok: false, reason: 'refused' };
  const base = { jobId: verified.jobId, botId: verified.botId, personId: verified.personId };
  if (input.payer === 'own-key') {
    // No room is taken, but a call after the fence is refused all the same
    const still = await verifyJobToken(input.token, 'model', now);
    return still.ok && still.generation === verified.generation ? { ok: true, ...base, reservedMicros: null } : { ok: false, reason: 'refused' };
  }
  if (!Number.isSafeInteger(input.estimateMicros) || input.estimateMicros <= 0 || input.estimateMicros > MAX_MICROS) return { ok: false, reason: 'refused' };
  const key = callRoomKey(base.jobId, input.callId);
  const prepared = await prepareComputerCredit(base.personId, now);
  const reserved = await reserveRoom({ key, personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, newJob: false, personal: creditCheck(base.personId, now, prepared) }, now);
  let room = reserved;
  if (reserved.ok && reserved.created) {
    // A model call inside a job is charged once, to the job's computer credit, as a computer_model charge under the job's own hold
    const job = await prisma.computerJob.findUnique({ where: { id: base.jobId }, select: { reservationKey: true } });
    const held = await holdForJob({ key, personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, chargeClass: 'computer_model', parentKey: job?.reservationKey ?? null }, now, prepared);
    if (!held.ok) {
      await releaseRoom({ key }, now);
      room = held.reason === 'allowance' ? { ok: false, reason: 'allowance', leftMicros: 0 } : held.reason === 'not_set' ? { ok: false, reason: 'not_set', missing: ['rolloutBudgetMicros'] } : { ok: false, reason: 'closed' };
    }
  }
  if (room.ok) {
    // The room may have waited for the pool's lock while the person took the machine: the key must still be good after it, or the room goes back
    const still = await verifyJobToken(input.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) {
      await releaseRoom({ key }, now);
      await releaseCreditHold(key, now);
      return { ok: false, reason: 'refused' };
    }
    return { ok: true, ...base, reservedMicros: room.reservation.amountMicros };
  }
  if (room.reason === 'allowance') return { ok: false, reason: 'allowance' };
  if (room.reason === 'rule') return { ok: false, reason: 'rule', ruleId: room.ruleId, why: room.why, leftMicros: room.leftMicros, words: room.words };
  // Asked again for a call whose room was settled or lapsed: the first try is the call, and a second one is not another
  if (room.reason === 'closed' || room.reason === 'key_reused') return { ok: false, reason: 'refused' };
  return { ok: false, reason: 'pool' };
}

export interface CallFacts {
  /** Millionths of a dollar the call cost; null when no price is known. */
  costMicros: number | null;
  /** How the figure was worked out: the bot server's own price list says. */
  basis: 'measured' | 'estimated' | 'unknown';
  /** Who paid: the platform, or the owner of the key the call ran on. */
  payer: { kind: 'universe' } | { kind: 'person'; personId: string };
  route: 'universe-ai' | 'own-key' | 'provider';
  tokens?: { input?: number | null; output?: number | null; cached?: number | null; reasoning?: number | null; cacheWrite?: number | null; cacheWrite1h?: number | null };
  /** The call ended before it finished (the person took over, the job stopped, the provider failed). Its cost is still counted. */
  cutShort?: boolean;
}

/**
 * A job that failed on our side (see `givenBackJob`) takes nothing from the person's month, and that includes the model calls it made:
 * they ran and the provider bills them, so each stays in the books as our own cost (the pool and the envelope still count it), but is
 * written against nobody, like the job's minutes. Calls on the owner's own key cost the platform nothing and are not touched.
 * Safe to say twice (a call already given back no longer matches), and for a job that ran fine or that the person stopped it is never called.
 */
export async function giveBackModelCalls(jobId: string, personId: string, now: Date = new Date()): Promise<void> {
  // The person's credit goes back with it: what the job and its calls were charged in the lots returns to the lot it came from, once per hold
  // (what the provider billed us stays in the hold's provider cost). A hold still held is not touched here: it settles, and is given back, when it ends
  await giveBackJobCredit(jobId, now);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE meter_events
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE("detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${personId}::text)
    WHERE "job_id" = ${jobId} AND "kind" = 'model_call' AND "pool" = 'computer' AND "payer_kind" = 'universe' AND "person_key" = ${`person:${personId}`}`);
}

const clampMicros = (value: number): number => Math.max(0, Math.min(MAX_MICROS, Math.round(value)));

/** What a settle says, in the one shape both contract versions are built from. */
interface SettleInput {
  /** What the person is charged: a number (0 stays 0), or null when it is not known. */
  charge: number | null;
  /** What the provider billed Universe: a number, or null when it is not known. */
  provider: number | null;
  basis: 'measured' | 'estimated' | 'unknown';
  payer: CallFacts['payer'];
  route: CallFacts['route'];
  tokens?: CallFacts['tokens'];
  cutShort?: boolean;
  /** Tokens or cost the provider reported that its usage fields do not explain (D3): never charged to the person as measured use. */
  unexplained?: { tokens?: number | null; costMicros?: number | null };
  /** Version 2: a measured zero stays zero and a step that cost more than set aside takes the rest only from eligible funds. Version 1 keeps its one amount and its minimum of 1. */
  exact: boolean;
}

export type Settled = { ok: true; state: 'settled' | 'corrected' | 'replay'; chargedMicros: number; providerCostMicros: number | null } | { ok: false; reason: 'unknown_call' };

/**
 * One settle for both contract versions. The figures go to the books once (a retry adds nothing) and the room is closed in the same step as the
 * cost is booked (R4). A late receipt for a step that settled unknown corrects it once, tied to the lots the first charge came from (R7).
 */
async function settleCore(jobId: string, callId: string, input: SettleInput, now: Date): Promise<Settled> {
  if (!CALL_ID.test(callId)) return { ok: false, reason: 'unknown_call' };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true, personId: true, status: true, endedBy: true } });
  if (!job) return { ok: false, reason: 'unknown_call' };
  const key = callRoomKey(job.id, callId);
  const reservation = await prisma.meterReservation.findUnique({ where: { reservationKey: key } });
  const auth = await prisma.computerCallAuthorisation.findUnique({ where: { callKey: key } });
  // A call on the owner's own key took no room, so there is none to find: it is still recorded. Anything else with no room was never authorized
  if (!reservation && !auth && input.payer.kind === 'universe') return { ok: false, reason: 'unknown_call' };
  const paidByOther = input.payer.kind === 'person';
  const eventId = `computer:${job.id}:call:${callId}`;
  const provider = input.provider === null ? null : clampMicros(input.provider);
  const charge = input.charge === null ? null : clampMicros(input.charge);
  const basis = paidByOther ? 'paid_by_other' : provider === null ? 'unknown' : input.basis;

  // A step that settled once stays as it settled, except that a first entry with no price known is replaced, once, by a late receipt with one
  if (auth && auth.state === 'settled') {
    const lateReceipt = auth.providerCostMicros === null && !auth.corrected && provider !== null;
    if (!lateReceipt) return { ok: true, state: 'replay', chargedMicros: Number(auth.chargedMicros ?? 0), providerCostMicros: auth.providerCostMicros === null ? null : Number(auth.providerCostMicros) };
    return correctLate({ job, key, auth, provider, charge, basis: input.basis, tokens: input.tokens, eventId }, now);
  }

  const memberHeld = reservation ? Number(reservation.amountMicros) : 0;
  const providerMax = auth ? Number(auth.providerMaxMicros) : memberHeld;
  // A call can cost more than the room held for it (the room is an upper reading made before the call; the price is known after). It cannot be
  // taken back, so it is written as it was, said as an overrun beside the figure, and counted from then on (audit F9)
  const overrun = reservation && !paidByOther && provider !== null && provider > providerMax ? provider - providerMax : 0;
  if (overrun > 0) console.warn(`[Computer] A model call cost ${overrun} millionths of a dollar more than the room held for it`);
  // A call that reports after its job failed on our side is written against nobody from the start (a call on the owner's own key is not the person's to give back)
  const givenBack = !paidByOther && givenBackJob(job.status, job.endedBy);
  const givenBackDetail = givenBack ? { givenBack: true, forPersonId: job.personId } : {};
  // R4: a step whose price is not known keeps counting in the pool at what was held for it, through its event, until a receipt settles it
  const unknownDetail = provider === null ? { heldMicros: providerMax } : {};
  const reportedDetail = { ...(input.tokens ? { tokens: input.tokens } : {}), ...(input.cutShort ? { cutShort: true } : {}), ...(overrun > 0 ? { overrunMicros: overrun } : {}), ...unknownDetail, ...givenBackDetail };
  const settledRoom = charge !== null ? (input.exact ? charge : Math.max(1, charge)) : memberHeld;
  // D3: a Gemini compatible step whose usage fields do not explain all it was billed keeps a defensible remaining liability in place of the gross
  // reservation it held (which is closed in this same step): one or the other, never both
  const unexplainedMicros = !paidByOther && auth && auth.modelFormat === 'gemini-compatible' && input.unexplained ? unexplainedLiability(input.unexplained, Number(auth.outputMicrosPerMillion)) : null;

  await closeRoomsAndBook(
    {
      settle: reservation ? [{ key, settledMicros: settledRoom }] : [],
      release: reservation ? [poolOnlyKey(key)] : [],
      book: async (tx) => {
        const written = await recordMeterEvent(
          {
            eventId,
            kind: 'model_call',
            pool: 'computer',
            occurredAt: now,
            personKey: givenBack ? 'unknown' : `person:${job.personId}`,
            personId: givenBack ? null : job.personId,
            botId: job.botId,
            brick: true,
            payerKind: paidByOther ? 'person' : 'universe',
            payerPersonId: input.payer.kind === 'person' ? input.payer.personId : null,
            route: input.route,
            jobId: job.id,
            quantity: 1,
            unit: 'call',
            costMicros: provider,
            basis,
            sourceRef: `computer_jobs:${job.id}`,
            detail: reportedDetail,
          },
          tx,
        );
        // The sweep writes a call that never reported as unknown. A report that comes after it carries the real figure, which replaces the
        // unknown one (only an unknown figure is ever replaced: a figure that was written stays as it was). The detail is merged into what is
        // stored, never replaced: a give-back that happened in the meantime is kept
        if (!written.recorded && provider !== null) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE meter_events
            SET "cost_micros" = ${BigInt(provider)}, "basis" = ${basis}, "route" = ${input.route},
                "detail" = (COALESCE("detail", '{}'::jsonb) - 'tokens' - 'cutShort' - 'overrunMicros' - 'heldMicros') || ${JSON.stringify(reportedDetail)}::jsonb
            WHERE "event_id" = ${eventId} AND "cost_micros" IS NULL`);
        }
        if (unexplainedMicros !== null && unexplainedMicros > 0) {
          await recordMeterEvent(
            {
              eventId: `${eventId}:unexplained`,
              kind: 'model_call',
              pool: 'computer',
              occurredAt: now,
              personKey: 'unknown',
              personId: null,
              botId: job.botId,
              brick: true,
              payerKind: 'universe',
              payerPersonId: null,
              route: input.route,
              jobId: job.id,
              quantity: 0,
              unit: 'call',
              costMicros: unexplainedMicros,
              basis: 'estimated',
              sourceRef: `computer_jobs:${job.id}`,
              detail: { unexplained: true, ...(input.unexplained?.tokens != null ? { tokens: input.unexplained.tokens } : {}) },
            },
            tx,
          );
        }
      },
    },
    now,
  );

  // The step may have been written by a job that failed while it was being written: look again (it is only ever "failed on our side" once)
  if (!givenBack && !paidByOther) {
    const again = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true, endedBy: true } });
    if (again && givenBackJob(again.status, again.endedBy)) await giveBackModelCalls(job.id, job.personId);
  }

  let chargedMicros = 0;
  if (reservation) {
    // The person's credit settles to the same figure, once; what the provider really billed stays in the hold's provider cost
    const prepared = await prepareComputerCredit(job.personId, now, false);
    await settleCallCredit(key, charge, input.basis === 'measured', now, input.exact ? { exact: true, providerCostMicros: provider } : {});
    if (input.exact && !paidByOther && charge !== null && charge > memberHeld) {
      // R7: what is more than was set aside is taken only from funds that are eligible, free and inside what was authorised; the extra reservation is explicit first
      await captureExtraCredit({ callKey: key, personId: job.personId, botId: job.botId, jobId: job.id }, charge - memberHeld, now, prepared);
    }
    if (!paidByOther) {
      const ended = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true, endedBy: true } });
      if (ended && givenBackJob(ended.status, ended.endedBy)) await giveBackJobCredit(job.id, now);
    }
    chargedMicros = paidByOther ? 0 : await chargedFor(key, charge ?? memberHeld);
  }
  if (auth) {
    await prisma.computerCallAuthorisation.updateMany({
      where: { callKey: key, state: 'held' },
      data: { state: 'settled', settledAt: now, outputTokens: input.tokens?.output ?? null, chargedMicros: BigInt(chargedMicros), providerCostMicros: provider === null ? null : BigInt(provider) },
    });
  }
  return { ok: true, state: 'settled', chargedMicros, providerCostMicros: provider };
}

/** What the person was charged for a step: its hold and its extra hold, as they settled; with no hold (extra usage with no limit) the figure it was told. */
async function chargedFor(key: string, fallback: number): Promise<number> {
  const holds = await prisma.creditHold.findMany({ where: { holdKey: { in: [key, `${key}:x`] }, state: 'settled' }, select: { customerMicros: true, refundedMicros: true } });
  if (holds.length === 0) return fallback;
  return holds.reduce((sum, hold) => sum + Number(hold.customerMicros ?? 0) - Number(hold.refundedMicros), 0);
}

/** D3: the remaining liability of the part of a bill the usage fields do not explain: the cost the provider reported, or its tokens at the dearest price the step had (the output price). */
function unexplainedLiability(unexplained: { tokens?: number | null; costMicros?: number | null }, outputMicrosPerMillion: number): number | null {
  if (typeof unexplained.costMicros === 'number') return clampMicros(unexplained.costMicros);
  if (typeof unexplained.tokens === 'number' && unexplained.tokens > 0) return clampMicros(Math.ceil((unexplained.tokens * outputMicrosPerMillion) / 1_000_000));
  return null;
}

/**
 * A late receipt for a step that settled with no price known (R4, R7): the entry is replaced exactly once. The cost replaces the unknown one in the
 * books in one step with the pool's lock (the pool stops counting the held amount and counts the cost, never both), the person's charge is
 * corrected on the lots the first charge came from (a lower one goes back, a higher one is taken only from eligible free funds), and the
 * step is marked corrected so a second late receipt changes nothing.
 */
async function correctLate(
  step: { job: { id: string; botId: string; personId: string }; key: string; auth: NonNullable<Awaited<ReturnType<typeof prisma.computerCallAuthorisation.findUnique>>>; provider: number | null; charge: number | null; basis: 'measured' | 'estimated' | 'unknown'; tokens?: CallFacts['tokens']; eventId: string },
  now: Date,
): Promise<Settled> {
  const { job, key, auth, provider, charge } = step;
  if (provider === null) return { ok: true, state: 'replay', chargedMicros: Number(auth.chargedMicros ?? 0), providerCostMicros: null };
  const memberHeld = Number(auth.memberMicros);
  const claimed = await closeRoomsAndBook(
    {
      book: async (tx) => {
        // Once: the first receipt to find the step unknown claims the correction
        const claim = await tx.computerCallAuthorisation.updateMany({ where: { callKey: key, state: 'settled', corrected: false, providerCostMicros: null }, data: { corrected: true } });
        if (claim.count === 0) return false;
        await tx.$executeRaw(Prisma.sql`
          UPDATE meter_events
          SET "cost_micros" = ${BigInt(provider)}, "basis" = ${step.basis},
              "detail" = (COALESCE("detail", '{}'::jsonb) - 'heldMicros' - 'tokens') || ${JSON.stringify(step.tokens ? { tokens: step.tokens } : {})}::jsonb
          WHERE "event_id" = ${step.eventId} AND "cost_micros" IS NULL`);
        return true;
      },
    },
    now,
  );
  if (!claimed) {
    const again = await prisma.computerCallAuthorisation.findUnique({ where: { callKey: key } });
    return { ok: true, state: 'replay', chargedMicros: Number(again?.chargedMicros ?? 0), providerCostMicros: again?.providerCostMicros == null ? null : Number(again.providerCostMicros) };
  }
  const firstCharged = Number(auth.chargedMicros ?? 0);
  let chargedMicros = firstCharged;
  const paidByPerson = (await prisma.creditHold.findUnique({ where: { holdKey: key }, select: { state: true } }))?.state === 'settled';
  if (paidByPerson && charge !== null) {
    const wanted = Math.min(charge, memberHeld);
    if (wanted < firstCharged) {
      // The first charge was the whole of what was set aside; the real one is lower: the difference goes back into the lots it came from, once
      const refunded = await refundHold({ holdKey: key, refundKey: `correct:${key}`, amountMicros: firstCharged - wanted, reason: 'correction' }, now);
      if (refunded.ok) chargedMicros = firstCharged - refunded.refundedMicros;
    }
    if (charge > memberHeld) {
      const prepared = await prepareComputerCredit(job.personId, now, false);
      chargedMicros += await captureExtraCredit({ callKey: key, personId: job.personId, botId: job.botId, jobId: job.id }, charge - memberHeld, now, prepared);
    }
    await recordProviderCost(key, { costMicros: provider, basis: step.basis });
  }
  await prisma.computerCallAuthorisation.updateMany({ where: { callKey: key }, data: { providerCostMicros: BigInt(provider), chargedMicros: BigInt(chargedMicros), outputTokens: step.tokens?.output ?? auth.outputTokens } });
  return { ok: true, state: 'corrected', chargedMicros, providerCostMicros: provider };
}

/** The figures of a finished call go to the books once, and its room is settled. Safe to say twice. Not for a call nobody authorized. (Contract version 1.) */
export async function settleModelCall(jobId: string, callId: string, facts: CallFacts, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'unknown_call' }> {
  const cost = facts.costMicros === null ? null : facts.costMicros;
  const done = await settleCore(jobId, callId, { charge: cost, provider: cost, basis: facts.basis, payer: facts.payer, route: facts.route, tokens: facts.tokens, cutShort: facts.cutShort, exact: false }, now);
  return done.ok ? { ok: true } : { ok: false, reason: 'unknown_call' };
}

/** The call was never sent: its room is given back. Safe to say twice. */
export async function releaseModelCall(jobId: string, callId: string, now: Date = new Date()): Promise<void> {
  if (!CALL_ID.test(callId)) return;
  const key = callRoomKey(jobId, callId);
  await closeRoomsAndBook({ release: [key, poolOnlyKey(key)], book: async (tx) => { await tx.computerCallAuthorisation.updateMany({ where: { callKey: key, state: 'held' }, data: { state: 'released', settledAt: now } }); } }, now);
  await releaseCreditHold(key, now);
}

// ---------- Contract version 2 (docs/computer-llm-contract-v2.md) ----------

const LIMITS_KEY = 'computer-limits';

/** The computer Limits as a super admin saved them (read on every call, so a change is in effect at once); the served default for what is not saved. */
export async function getComputerLimits(): Promise<ComputerLimits> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    return readComputerLimits(row?.value);
  } catch (error) {
    console.error('[Computer] Could not read the Limits:', error instanceof Error ? error.message : 'unknown');
    return { ...COMPUTER_LIMITS_DEFAULT };
  }
}

/** Saves a change to the computer Limits on top of what is saved, and returns all of them. */
export async function saveComputerLimits(change: Partial<ComputerLimits>, userId: string): Promise<ComputerLimits> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('computer:limits'))`;
    const row = await tx.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    const saved = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
    const next = { ...saved, ...change } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: LIMITS_KEY }, create: { key: LIMITS_KEY, value: next, updatedById: userId }, update: { value: next, updatedById: userId } });
    return readComputerLimits(next);
  });
}

export interface StepAsk {
  token: string;
  operationId: string;
  payer: 'universe' | 'own-key';
  route: 'universe-ai' | 'own-key' | 'provider';
  model?: string | null;
  modelFormat?: 'openai' | 'gemini-compatible' | 'other' | null;
  stepKind?: 'reply' | 'edit' | 'tool' | 'vision' | 'other' | null;
  inputTokens: number;
  /** Null when the relay has no price for the model: nothing is held and nothing is sent (`unpriced`). */
  inputMicros: number | null;
  outputMicrosPerMillion: number | null;
  maxOutputTokens: number;
  providerMaxMicros?: number | null;
}

export interface AuthorisationView {
  id: string;
  payer: 'owner' | 'visitor' | 'schedule' | 'teammate';
  fundingAccountId: string | null;
  tariffVersion: string | null;
  limits: { taskMicros: number | null; botMicros: number | null; grantId: string | null; periodEnds: string | null; fixedPriceMicros: number | null };
}

export type StepAnswer =
  | { ok: true; contract: 2; operationId: string; jobId: string; botId: string; personId: string; memberMicros: number; providerMaxMicros: number; authorisation: AuthorisationView | null; limits: ComputerLimits }
  | { ok: false; contract: 2; operationId: string; reason: StepRefusal; retryAfterSeconds?: number; paused: boolean; words: string | null; canAskForMore: boolean };

/** How long a game waits before asking again for a step that waiting can help (`busy`, `holds`). */
const RETRY_AFTER_SECONDS = 20;

const digestOf = (token: string) => createHash('sha256').update(token).digest('hex');
const tariffOf = (route: string, model: string, outputMicrosPerMillion: number) => `t-${createHash('sha256').update(`${route}|${model}|${outputMicrosPerMillion}`).digest('hex').slice(0, 16)}`;

/** The key of a job that was paused is no longer good (it ended with the pause): a step asked with it is told `paused`, not `refused`. */
async function keyOfPausedJob(token: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length > 200) return false;
  const row = await prisma.computerJobToken.findUnique({ where: { digest: digestOf(token) }, select: { scope: true, job: { select: { status: true, pausedAt: true } } } });
  return !!row && row.scope === 'model' && row.job.status === 'queued' && row.job.pausedAt !== null;
}

async function authorisationAnswer(ask: StepAsk, row: NonNullable<Awaited<ReturnType<typeof prisma.computerCallAuthorisation.findUnique>>>, limits: ComputerLimits): Promise<StepAnswer> {
  return {
    ok: true,
    contract: 2,
    operationId: ask.operationId,
    jobId: row.jobId,
    botId: row.botId,
    personId: row.personId,
    memberMicros: Number(row.memberMicros),
    providerMaxMicros: Number(row.providerMaxMicros),
    authorisation: { id: row.id, payer: row.payerKind as AuthorisationView['payer'], fundingAccountId: row.fundingAccountId, tariffVersion: row.tariffVersion, limits: row.limits as AuthorisationView['limits'] },
    limits,
  };
}

/** Why the pool had no room: waiting helps when what is held (steps in flight, steps not yet settled, unknown ones) is what fills it; the budget is used up when what is spent and kept already does. */
async function poolRefusal(providerMaxMicros: number): Promise<'holds' | 'budget'> {
  const settings = await getMeterSettings();
  const envelope = await currentEnvelope();
  const holding = envelope.reservedMicros + envelope.unsettledMicros + envelope.unknownHeldMicros;
  const firm = envelope.totalMicros - holding;
  return holding > 0 && firm + providerMaxMicros <= (settings.poolCeilingMicros ?? 0) ? 'holds' : 'budget';
}

/**
 * Contract version 2, authorize (R1, R2, D1, D2, D3, R10, N1). Before a step is sent: the key is checked, what it runs on is checked, the
 * funding authorisation (who pays, the account, the tariff and the limits that bound it) is resolved and recorded, and TWO amounts are set aside:
 * the member's (an estimate from realistic answer lengths, held from their credit) and the provider's most (held in the pool). A refusal is
 * typed, with a wait time where waiting helps. A running job that is truly out is saved and paused. Asked again with the same operation
 * id it is the same answer and nothing more is held. Nothing here changes the model, the reasoning, the tools or the answer the call is allowed.
 */
export async function authorizeStep(ask: StepAsk, now: Date = new Date()): Promise<StepAnswer> {
  const refuse = (reason: StepRefusal, extra: { retryAfterSeconds?: number; paused?: boolean; words?: string | null; canAskForMore?: boolean } = {}): StepAnswer => ({
    ok: false,
    contract: 2,
    operationId: ask.operationId,
    reason,
    ...(extra.retryAfterSeconds !== undefined ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
    paused: extra.paused ?? false,
    words: extra.words ?? null,
    canAskForMore: extra.canAskForMore ?? false,
  });
  if (!CALL_ID.test(ask.operationId)) return refuse('refused');
  const verified = await verifyJobToken(ask.token, 'model', now);
  if (!verified.ok) return (await keyOfPausedJob(ask.token)) ? refuse('paused', { paused: true }) : refuse('refused');
  const limits = await getComputerLimits();
  const base = { jobId: verified.jobId, botId: verified.botId, personId: verified.personId };
  const format = formatOf(ask.modelFormat);
  // N1: a route a computer cannot run on is refused before anything is held or sent
  if (!computerCanRun(format)) return refuse('unsupported');
  if (ask.payer === 'own-key') {
    // Nothing of ours is spent: no room, no credit, no authorisation to record. A call after the fence is refused all the same
    const still = await verifyJobToken(ask.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) return refuse('refused');
    return { ok: true, contract: 2, operationId: ask.operationId, ...base, memberMicros: 0, providerMaxMicros: 0, authorisation: null, limits };
  }
  // R10: a model Universe pays for with no price is named (readiness) and nothing is sent for it
  const model = (ask.model ?? '').slice(0, 120);
  const priced = ask.inputMicros !== null && ask.outputMicrosPerMillion !== null;
  await prisma.computerModelSeen
    .upsert({ where: { route_model: { route: ask.route, model } }, create: { route: ask.route, model, priced, seenAt: now }, update: { priced, seenAt: now } })
    .catch((error) => console.error('[Computer] Could not note a model:', error instanceof Error ? error.message : 'unknown'));
  if (!priced) return refuse('unpriced');
  const inputMicros = ask.inputMicros as number;
  const outputPerMillion = ask.outputMicrosPerMillion as number;
  const key = callRoomKey(base.jobId, ask.operationId);

  // The same step asked again (a retry, or the game asking after a wait) is the same answer: what was recorded, nothing more held
  const earlier = await prisma.computerCallAuthorisation.findUnique({ where: { callKey: key } });
  if (earlier) {
    if (earlier.personId !== base.personId) return refuse('refused');
    const room = await prisma.meterReservation.findUnique({ where: { reservationKey: key }, select: { state: true, expiresAt: true } });
    return room && room.state === 'held' && room.expiresAt > now ? authorisationAnswer(ask, earlier, limits) : refuse('refused');
  }

  const job = await prisma.computerJob.findUnique({ where: { id: base.jobId }, select: { reservationKey: true, runId: true, botId: true, personId: true } });
  if (!job) return refuse('refused');
  // Calls at once for one job: a limit served from the Limits, and waiting helps
  const inFlight = await prisma.meterReservation.count({ where: { jobId: base.jobId, state: 'held', expiresAt: { gt: now }, reservationKey: { startsWith: callRoomKey(base.jobId, '') } } });
  if (inFlight >= limits.maxCallsInFlight) return refuse('holds', { retryAfterSeconds: RETRY_AFTER_SECONDS });

  const amounts = await twoAmounts(
    { jobId: base.jobId, route: ask.route, model, stepKind: ask.stepKind ?? 'other' },
    { inputMicros, outputMicrosPerMillion: outputPerMillion, maxOutputTokens: ask.maxOutputTokens, providerMaxMicros: ask.providerMaxMicros },
  );
  const prepared = await prepareComputerCredit(base.personId, now);
  const funding = await resolveFunding({ id: base.jobId, botId: base.botId, personId: base.personId, runId: job.runId }, now);
  const reserved = await reserveRoom(
    { key, personId: base.personId, amountMicros: amounts.memberMicros, poolOnlyMicros: amounts.providerMaxMicros - amounts.memberMicros, botId: base.botId, jobId: base.jobId, newJob: false, personal: creditCheck(base.personId, now, prepared) },
    now,
  );
  let room: Room = reserved;
  if (reserved.ok && reserved.created) {
    const held = await holdForJob({ key, personId: base.personId, amountMicros: amounts.memberMicros, botId: base.botId, jobId: base.jobId, chargeClass: 'computer_model', parentKey: job.reservationKey }, now, prepared);
    if (!held.ok) {
      await closeRoomsAndBook({ release: [key, poolOnlyKey(key)], book: async () => undefined }, now);
      room = held.reason === 'allowance' ? { ok: false, reason: 'allowance', leftMicros: 0 } : held.reason === 'not_set' ? { ok: false, reason: 'not_set', missing: ['rolloutBudgetMicros'] } : { ok: false, reason: 'closed' };
    }
  }
  if (!room.ok) return refusedRoom(ask, base.jobId, room, amounts.providerMaxMicros, refuse);
  // The key must still be good after the room's lock (the person may have taken the machine meanwhile), or everything goes back
  const still = await verifyJobToken(ask.token, 'model', now);
  if (!still.ok || still.generation !== verified.generation) {
    await closeRoomsAndBook({ release: [key, poolOnlyKey(key)], book: async () => undefined }, now);
    await releaseCreditHold(key, now);
    return refuse('refused');
  }
  // The funding authorisation is recorded BEFORE the answer, so a step is never sent without it
  try {
    const created = await prisma.computerCallAuthorisation.create({
      data: {
        callKey: key,
        jobId: base.jobId,
        botId: base.botId,
        personId: base.personId,
        operationId: ask.operationId,
        contract: 2,
        payerKind: funding.payerKind,
        fundingAccountId: funding.fundingAccountId,
        tariffVersion: tariffOf(ask.route, model, outputPerMillion),
        limits: funding.limits,
        route: ask.route,
        model,
        modelFormat: format,
        stepKind: ask.stepKind ?? 'other',
        inputTokens: ask.inputTokens,
        inputMicros: BigInt(inputMicros),
        outputMicrosPerMillion: BigInt(outputPerMillion),
        maxOutputTokens: ask.maxOutputTokens,
        memberMicros: BigInt(amounts.memberMicros),
        providerMaxMicros: BigInt(amounts.providerMaxMicros),
      },
    });
    return authorisationAnswer(ask, created, limits);
  } catch (error) {
    // Two asks for one step at the same moment: the first one's record is the answer
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.computerCallAuthorisation.findUnique({ where: { callKey: key } });
      if (winner) return authorisationAnswer(ask, winner, limits);
    }
    await closeRoomsAndBook({ release: [key, poolOnlyKey(key)], book: async () => undefined }, now);
    await releaseCreditHold(key, now);
    throw error;
  }
}

/** A step the room was not taken for: the typed refusal, and a running job that is truly out saved and paused. */
async function refusedRoom(
  ask: StepAsk,
  jobId: string,
  room: Exclude<Room, { ok: true }>,
  providerMaxMicros: number,
  refuse: (reason: StepRefusal, extra?: { retryAfterSeconds?: number; paused?: boolean; words?: string | null; canAskForMore?: boolean }) => StepAnswer,
): Promise<StepAnswer> {
  switch (room.reason) {
    case 'allowance': {
      const paused = await pauseRunningJob(jobId, 'allowance');
      return refuse('allowance', { paused, canAskForMore: true });
    }
    case 'pool': {
      const why = await poolRefusal(providerMaxMicros);
      if (why === 'holds') return refuse('holds', { retryAfterSeconds: RETRY_AFTER_SECONDS });
      const paused = await pauseRunningJob(jobId, 'budget');
      return refuse('budget', { paused });
    }
    case 'busy':
      return refuse('busy', { retryAfterSeconds: RETRY_AFTER_SECONDS });
    case 'rule':
      return refuse('rule', { words: room.words });
    case 'not_set':
      return refuse('budget');
    default:
      // A room that settled, lapsed or was closed is not a place to start a paid step from
      return refuse('refused');
  }
}

/** Saves and pauses the job a refused step belongs to (R2). Computer.ts imports this file, so it is loaded when needed. */
async function pauseRunningJob(jobId: string, reason: 'allowance' | 'budget'): Promise<boolean> {
  const { pauseJob } = await import('@/lib/computer');
  return pauseJob(jobId, reason).catch((error) => {
    console.error('[Computer] Could not pause a job:', error instanceof Error ? error.message : 'unknown');
    return false;
  });
}

export interface StepSettle {
  jobId: string;
  operationId: string;
  /** What the person is charged: absent means the same as the provider's bill; null means not known. */
  costMicros?: number | null;
  providerCostMicros?: number | null;
  basis?: 'measured' | 'estimated' | 'unknown';
  payerPersonId?: string | null;
  route?: 'universe-ai' | 'own-key' | 'provider';
  tokens?: CallFacts['tokens'];
  unexplained?: { tokens?: number | null; costMicros?: number | null };
  cutShort?: boolean;
}

/**
 * Contract version 2, settle (R6, R7, D3). A measured zero stays zero, a price not known stays unknown (settled at what was held, the person
 * charged no more than the member amount), a late receipt corrects an unknown entry once, and a repeat answers what was first recorded.
 */
export async function settleStep(settle: StepSettle, now: Date = new Date()): Promise<Settled> {
  const provider = settle.providerCostMicros !== undefined ? settle.providerCostMicros : settle.costMicros !== undefined ? settle.costMicros : null;
  const charge = settle.costMicros !== undefined ? settle.costMicros : provider;
  return settleCore(
    settle.jobId,
    settle.operationId,
    {
      charge,
      provider,
      basis: settle.basis ?? 'unknown',
      payer: settle.payerPersonId ? { kind: 'person', personId: settle.payerPersonId } : { kind: 'universe' },
      route: settle.route ?? (settle.payerPersonId ? 'own-key' : 'universe-ai'),
      tokens: settle.tokens,
      cutShort: settle.cutShort,
      unexplained: settle.unexplained,
      exact: true,
    },
    now,
  );
}
