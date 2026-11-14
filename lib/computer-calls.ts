import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { releaseRoom, reserveRoom, settleRoom } from '@/lib/meter-allowance';
import { verifyJobToken } from '@/lib/computer-token';

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
  | { ok: false; reason: 'pool' };

export async function authorizeModelCall(
  input: { token: string; callId: string; estimateMicros: number; payer: 'universe' | 'own-key' },
  now: Date = new Date(),
): Promise<Authorized> {
  if (!CALL_ID.test(input.callId)) return { ok: false, reason: 'refused' };
  const verified = await verifyJobToken(input.token, 'model', now);
  if (!verified.ok) return { ok: false, reason: 'refused' };
  const base = { jobId: verified.jobId, botId: verified.botId, personId: verified.personId };
  if (input.payer === 'own-key') return { ok: true, ...base, reservedMicros: null };
  if (!Number.isSafeInteger(input.estimateMicros) || input.estimateMicros <= 0 || input.estimateMicros > MAX_MICROS) return { ok: false, reason: 'refused' };
  const room = await reserveRoom({ key: callRoomKey(base.jobId, input.callId), personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, newJob: false }, now);
  if (room.ok) return { ok: true, ...base, reservedMicros: room.reservation.amountMicros };
  if (room.reason === 'allowance') return { ok: false, reason: 'allowance' };
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

/** The figures of a finished call go to the books once, and its room is settled. Safe to say twice. Not for a call nobody authorized. */
export async function settleModelCall(jobId: string, callId: string, facts: CallFacts, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'unknown_call' }> {
  if (!CALL_ID.test(callId)) return { ok: false, reason: 'unknown_call' };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true, personId: true } });
  if (!job) return { ok: false, reason: 'unknown_call' };
  const reservation = await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(job.id, callId) } });
  // A call on the owner's own key took no room, so there is none to find: it is still recorded. Anything else with no room was never authorized
  if (!reservation && facts.payer.kind === 'universe') return { ok: false, reason: 'unknown_call' };
  const cost = facts.costMicros === null ? null : Math.max(0, Math.min(MAX_MICROS, Math.round(facts.costMicros)));
  const paidByOther = facts.payer.kind === 'person';
  await recordMeterEvent({
    eventId: `computer:${job.id}:call:${callId}`,
    kind: 'model_call',
    pool: 'computer',
    occurredAt: now,
    personKey: `person:${job.personId}`,
    personId: job.personId,
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
    detail: { ...(facts.tokens ? { tokens: facts.tokens } : {}), ...(facts.cutShort ? { cutShort: true } : {}) },
  });
  // A price that is not known settles at the room that was held (never 0); one that is settles at what it was, at least 1
  if (reservation) await settleRoom({ key: reservation.reservationKey, settledMicros: Math.max(1, cost ?? Number(reservation.amountMicros)) }, now);
  return { ok: true };
}

/** The call was never sent: its room is given back. Safe to say twice. */
export async function releaseModelCall(jobId: string, callId: string, now: Date = new Date()): Promise<void> {
  if (!CALL_ID.test(callId)) return;
  await releaseRoom({ key: callRoomKey(jobId, callId) }, now);
}
