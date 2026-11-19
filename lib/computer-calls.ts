import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { releaseRoom, reserveRoom, settleRoom } from '@/lib/meter-allowance';
import { verifyJobToken } from '@/lib/computer-token';
import { givenBackJob } from '@/lib/computer-values';
import { drawComputerCredit, giveBackComputerCredit } from '@/lib/computer-credit';

/**
 * A model call a Brick's computer makes (build handoff v2, section 5): room is taken BEFORE the call, and what it really cost is
 * written and settled after, whether it finished, was cut off or failed.
 *
 * Orbit decides and keeps the books; the call itself runs where the AI providers already are (the bot server, which has every
 * provider's way of talking, its price list and its key). That side asks here first:
 *  1. `authorizeModelCall`: the computer's key is checked against Orbit's records (the job still holds the machine, the key is
 *     for models, it is from the current control generation), and the room for this one call is reserved from the person's
 *     computer allowance, inside the pool. No room: the call is refused with the reason, and nothing was sent anywhere.
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
  const room = await reserveRoom({ key: callRoomKey(base.jobId, input.callId), personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, newJob: false }, now);
  if (room.ok) {
    // The room may have waited for the pool's lock while the person took the machine: the key must still be good after it, or the room goes back
    const still = await verifyJobToken(input.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) {
      await releaseRoom({ key: callRoomKey(base.jobId, input.callId) }, now);
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
  tokens?: { input?: number | null; output?: number | null; cached?: number | null; reasoning?: number | null };
  /** The call ended before it finished (the person took over, the job stopped, the provider failed). Its cost is still counted. */
  cutShort?: boolean;
}

/**
 * A job that failed on our side (see `givenBackJob`) takes nothing from the person's month, and that includes the model calls it made:
 * they ran and the provider bills them, so each stays in the books as our own cost (the pool and the envelope still count it), but is
 * written against nobody, like the job's minutes. Calls on the owner's own key cost the platform nothing and are not touched.
 * Safe to say twice (a call already given back no longer matches), and for a job that ran fine or that the person stopped it is never called.
 */
export async function giveBackModelCalls(jobId: string, personId: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE meter_events
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE("detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${personId}::text)
    WHERE "job_id" = ${jobId} AND "kind" = 'model_call' AND "pool" = 'computer' AND "payer_kind" = 'universe' AND "person_key" = ${`person:${personId}`}`);
  // What the job drew from credit given for computers goes back into the lots it came from (each draw once: asked again it gives nothing more)
  await giveBackComputerCredit(jobId);
}

/** The figures of a finished call go to the books once, and its room is settled. Safe to say twice. Not for a call nobody authorized. */
export async function settleModelCall(jobId: string, callId: string, facts: CallFacts, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'unknown_call' }> {
  if (!CALL_ID.test(callId)) return { ok: false, reason: 'unknown_call' };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true, personId: true, status: true, endedBy: true } });
  if (!job) return { ok: false, reason: 'unknown_call' };
  const reservation = await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(job.id, callId) } });
  // A call on the owner's own key took no room, so there is none to find: it is still recorded. Anything else with no room was never authorized
  if (!reservation && facts.payer.kind === 'universe') return { ok: false, reason: 'unknown_call' };
  const cost = facts.costMicros === null ? null : Math.max(0, Math.min(MAX_MICROS, Math.round(facts.costMicros)));
  const paidByOther = facts.payer.kind === 'person';
  const eventId = `computer:${job.id}:call:${callId}`;
  // A call that reports after its job failed on our side is written against nobody from the start (a call on the owner's own key is not the person's to give back)
  const givenBack = !paidByOther && givenBackJob(job.status, job.endedBy);
  const givenBackDetail = givenBack ? { givenBack: true, forPersonId: job.personId } : {};
  const reportedDetail = { ...(facts.tokens ? { tokens: facts.tokens } : {}), ...(facts.cutShort ? { cutShort: true } : {}), ...givenBackDetail };
  // Credit given on purpose (a gift for computers) is drawn first, before the event is written, so the allowance never counts what credit paid:
  // asked twice it is the same draw. A call on the owner's own key, with no price known, or on a job that failed on our side draws nothing
  if (!givenBack && !paidByOther && cost !== null && cost > 0) await drawComputerCredit({ eventId, personId: job.personId, botId: job.botId, jobId: job.id, costMicros: cost, chargeClass: 'computer_model' }, now);
  const written = await recordMeterEvent({
    eventId,
    kind: 'model_call',
    pool: 'computer',
    occurredAt: now,
    personKey: givenBack ? 'unknown' : `person:${job.personId}`,
    personId: givenBack ? null : job.personId,
    botId: job.botId,
    brick: true,
    payerKind: paidByOther ? 'person' : 'universe',
    payerPersonId: facts.payer.kind === 'person' ? facts.payer.personId : null,
    route: facts.route,
    jobId: job.id,
    quantity: 1,
    unit: 'call',
    costMicros: cost,
    basis: paidByOther ? 'paid_by_other' : cost === null ? 'unknown' : facts.basis,
    sourceRef: `computer_jobs:${job.id}`,
    detail: reportedDetail,
  });
  // The sweep writes a call that never reported as unknown. A report that comes after it carries the real figure, which replaces the
  // unknown one (only an unknown figure is ever replaced: a figure that was written stays as it was)
  if (!written.recorded && cost !== null) {
    await prisma.meterEvent.updateMany({
      where: { eventId, costMicros: null },
      data: { costMicros: BigInt(cost), basis: paidByOther ? 'paid_by_other' : facts.basis, route: facts.route, detail: reportedDetail },
    });
  }
  // The job may have failed while this call was being written: its calls are given back when it ends, and this one was written after that
  // looked. Look again (the answer is only ever "failed on our side" once, so this is cheap and settles the race either way)
  if (!givenBack && !paidByOther) {
    const now2 = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true, endedBy: true } });
    if (now2 && givenBackJob(now2.status, now2.endedBy)) await giveBackModelCalls(job.id, job.personId);
  }
  // The room settles at what the books hold for this call, never at what this report says: a report sent again after a first one that wrote
  // the event but did not settle (or with another figure) must settle at the event's own cost. A price that is not known settles at the
  // room that was held (never 0); one that is settles at what it was, at least 1
  if (reservation) {
    const stored = await prisma.meterEvent.findUnique({ where: { eventId }, select: { costMicros: true } });
    const booked = stored ? (stored.costMicros === null ? null : Number(stored.costMicros)) : cost;
    await settleRoom({ key: reservation.reservationKey, settledMicros: Math.max(1, booked ?? Number(reservation.amountMicros)) }, now);
  }
  return { ok: true };
}

/** The call was never sent: its room is given back. Safe to say twice. */
export async function releaseModelCall(jobId: string, callId: string, now: Date = new Date()): Promise<void> {
  if (!CALL_ID.test(callId)) return;
  await releaseRoom({ key: callRoomKey(jobId, callId) }, now);
}
