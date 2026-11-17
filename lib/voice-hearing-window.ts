import { prisma } from '@/lib/db';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { resolveUsagePerson } from '@/lib/usage-person';
import { monthOf } from '@/lib/meter-values';
import { checkSpeechCap } from '@/lib/speech-cap';
import { lockSpeech, speechReserved, SPEECH_LOCK } from '@/lib/speech-reserved';
import { planHearing, type SpeechReason } from '@/lib/speech-admission';

/**
 * Live hearing, admitted in windows (docs/speech-admission-contract.md, section 4). A funded call that hears a person asks for a window when it
 * starts and again, in the background, before the current one is used up: never one admission per audio frame, and never in the way of the audio.
 * Admitting a window sets aside, at the hearing rate, what it may cost Universe, and counts its seconds against the person's own entitlement,
 * checked against the Speech budget like any other use (lib/speech-cap.ts). The hearing events that name the window use it up
 * (lib/speech-receipts.ts); `releaseHearingWindow` gives back what was not used when the call or the window ends. A window never released and
 * never used up stays counted as unknown (lib/speech-reserved.ts): a timer alone never proves nothing was heard.
 *
 * The same `windowId` asked again is the same window, never a second one.
 */
export type HearingWindowAnswer =
  | {
      allowed: true;
      windowId: string;
      rateVersion: number;
      provider: string | null;
      /** Seconds of hearing the window admits. */
      admittedSeconds: number;
      /** The game asks for the next window once this many seconds of this one have passed. */
      renewAfterSeconds: number;
      /** What the window may cost Universe, in millionths of a dollar, at `rateVersion`. */
      admittedMicros: number;
    }
  | { allowed: false; resetsAt: string; stoppedBy: SpeechReason; retryAfterSeconds?: number };

const idOf = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw new ReplyAllowanceError(`${name} is required (up to 255 characters)`, 400);
  return value.trim();
};

export async function admitHearingWindow(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown; windowId?: unknown; provider?: unknown; model?: unknown },
  now: Date = new Date(),
): Promise<HearingWindowAnswer> {
  const windowId = idOf(input.windowId, 'windowId');
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);
  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  const person = userId ? await resolveUsagePerson(userId, input.isGuest) : null;
  const personId = person?.personId ?? null;
  const personKey = userId ? (personId ? `person:${personId}` : `guest:${userId}`) : `anon:${botId}`;
  const resetsAt = monthOf(now).end.toISOString();

  return prisma.$transaction(async (tx): Promise<HearingWindowAnswer> => {
    await lockSpeech(tx);
    const answer = (row: { windowId: string; rateVersion: number; provider: string | null; admittedSeconds: number; holdMicros: bigint }, lead: number): HearingWindowAnswer => ({
      allowed: true,
      windowId: row.windowId,
      rateVersion: row.rateVersion,
      provider: row.provider,
      admittedSeconds: row.admittedSeconds,
      renewAfterSeconds: Math.max(1, row.admittedSeconds - lead),
      admittedMicros: Number(row.holdMicros),
    });
    const planned = await planHearing(tx, { provider: input.provider, model: input.model });
    const existing = await tx.voiceHearingWindow.findUnique({ where: { botId_windowId: { botId, windowId } } });
    if (existing) return answer(existing, planned.ok ? (planned.plan.terms.hearingRenewLeadSeconds ?? 0) : 0);
    if (!planned.ok) return { allowed: false, resetsAt, stoppedBy: planned.stop === 'provider' ? 'provider' : 'budget' };
    const { plan } = planned;
    const held = await speechReserved(tx, { personKey, replySeconds: plan.seconds, now });
    const stop = await checkSpeechCap({ personId, memberSeconds: plan.seconds, exposureMicros: plan.price.micros, held }, now, tx);
    if (stop) return { allowed: false, resetsAt: stop.resetsAt, stoppedBy: stop.reason, ...(stop.retryAfterSeconds !== undefined ? { retryAfterSeconds: stop.retryAfterSeconds } : {}) };
    const row = await tx.voiceHearingWindow.create({
      data: { botId, windowId, personKey, provider: plan.company.adapter, rateVersion: plan.price.rateVersion, admittedSeconds: plan.seconds, holdMicros: BigInt(plan.price.micros), createdAt: now },
    });
    return answer(row, plan.terms.hearingRenewLeadSeconds ?? 0);
  }, SPEECH_LOCK);
}

/**
 * Gives back what a window did not use: its hold stops counting, what was heard stays in the books (its events). Safe to ask twice: `released` says
 * whether this call closed it.
 */
export async function releaseHearingWindow(botId: string, input: { windowId?: unknown }, now: Date = new Date()): Promise<{ released: boolean }> {
  const windowId = idOf(input.windowId, 'windowId');
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);
  return prisma.$transaction(async (tx) => {
    await lockSpeech(tx);
    const { count } = await tx.voiceHearingWindow.updateMany({ where: { botId, windowId, closedAt: null }, data: { closedAt: now } });
    return { released: count > 0 };
  }, SPEECH_LOCK);
}
