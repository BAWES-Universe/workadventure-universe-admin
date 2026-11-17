import { prisma } from '@/lib/db';
import { resolveUsagePerson } from '@/lib/usage-person';
import { ReplyAllowanceError, windowStart } from '@/lib/reply-limits';
import { servedVoiceLimits } from '@/lib/voice-limits';
import { runningExtra, type RunningExtra } from '@/lib/meter-grants';
import { checkSpeechCap, type SpeechStop } from '@/lib/speech-cap';
import { lockSpeech, speechReserved, SPEECH_LOCK } from '@/lib/speech-reserved';
import { planReply, type SpeechReason } from '@/lib/speech-admission';
import { monthOf } from '@/lib/meter-values';

/**
 * Voice replies inside the Universe AI allowance (game #1669), decided by Khalid 29 Oct 2026: a spoken reply comes out of the
 * same 5-hour window as a text reply, with some replies always kept for text (30 keeps 5, 10 keeps 2) and a guest limited to 3
 * spoken ones. The numbers are the voice limits (#740), so a super admin changes them with no deploy.
 *
 * The text of a reply is counted as ever, in the usage rows. This counts which replies were also spoken, one row per reply under
 * the turn the bot server names it by, so asking again for the same reply (a retry, a reconnect) never counts it twice.
 */
export type VoiceAllowance =
  /**
   * `left`: spoken replies still possible after this one; `resetsAt`: when the person's window ends. Both are missing for a person nobody could name.
   * `admission` is there for a game that asked with `contract: 2` (docs/speech-admission-contract.md): what Orbit set aside for this reply.
   */
  | { allowed: true; left?: number; resetsAt?: string; admission?: ReplyAdmission }
  /** `stoppedBy` says which of the five stops it was (person, budget, hold, provider, capacity); `retryAfterSeconds` only where waiting helps. */
  | { allowed: false; resetsAt: string; stoppedBy: SpeechReason; retryAfterSeconds?: number };

/** What admitting a reply set aside, as the game sees it. The receipt of the reply carries its `turnId`, and Orbit releases this when it arrives. */
export interface ReplyAdmission {
  contract: 2;
  turnId: string;
  rateVersion: number;
  provider: string | null;
  /** The member estimate, in seconds: the usual length of a reply. */
  admittedSeconds: number;
  /** The enforceable longest reply, in seconds. */
  maxSeconds: number;
  /** Universe's exposure for this reply, in millionths of a dollar, at `rateVersion`. */
  admittedMicros: number;
}

/** What a person has left, for the line at the bottom of the Voice menu. `resetsAt` is null while no window is running (nothing used yet). */
export interface VoiceLeft {
  /** `null` while the person has no limit (extra usage with no limit is running): there is no number to show. */
  left: number | null;
  resetsAt: string | null;
}

const HOUR = 60 * 60 * 1000;

type Served = Awaited<ReturnType<typeof servedVoiceLimits>>;

/**
 * Voice replies a person can still hear: what the voice limits leave of the window (30 gives 25, a guest 3) less the spoken ones,
 * and never more than what is left of the window once the replies kept for text are put aside, so replies they typed count too.
 * `null` when extra usage with no limit is running: nothing stops them, so there is no number.
 */
function repliesLeft(served: Served, guest: boolean, spoken: number, used: number, extra: RunningExtra | null): number | null {
  const { byVoice, byText } = places(served, guest, spoken, used, extra);
  const left = Math.min(byVoice, byText);
  return Number.isFinite(left) ? Math.max(0, Math.floor(left)) : null;
}

/**
 * The places the voice limits leave (`byVoice`), and the places the window leaves once the replies kept for text are put aside (`byText`).
 * Extra usage a super admin gave (game #1999) is applied the way the text limit applies it (lib/reply-limits.ts): a multiple of the
 * usual window, the replies kept for text and the voice replies with it, or no limit at all (both Infinity). A guest never has it.
 */
function places(served: Served, guest: boolean, spoken: number, used: number, extra: RunningExtra | null): { byVoice: number; byText: number } {
  const window = guest ? served.window.guest : served.window.signedIn;
  if (!guest && extra?.noLimit) return { byVoice: Infinity, byText: Infinity };
  const times = guest ? 1 : (extra?.multiplier ?? 1);
  return { byVoice: window.voiceReplies * times - spoken, byText: window.replies * times - used - window.textReserve * times };
}

/** The extra usage running for a signed-in person now, if any; a guest has none. */
const extraFor = (person: { personId: string | null }, now: Date) => (person.personId ? runningExtra(person.personId, now) : Promise.resolve(null));

/** An allowed answer; no `left` when there is no limit to count down from. */
const withLeft = (left: number | null, resetsAt: string): VoiceAllowance => (left === null ? { allowed: true, resetsAt } : { allowed: true, left, resetsAt });

/** The same answer with what was set aside for the reply, for a game that asked with `contract: 2`. */
const withAdmission = (answer: VoiceAllowance, admission: ReplyAdmission | undefined): VoiceAllowance => (admission && answer.allowed ? { ...answer, admission } : answer);

/** The Universe AI replies a person got in a window, from any bot, as the text limit counts them (lib/reply-limits.ts). */
const usedReplies = (db: Pick<typeof prisma, 'botsAiUsage'>, person: { personId: string | null }, userId: string, since: Date) =>
  db.botsAiUsage.count({
    where: {
      ...(person.personId ? { talkedPersonId: person.personId } : { talkedUserId: userId, talkedGuest: true }),
      keyOwnerId: null,
      error: false,
      // A greeting the bot made on its own is free for the person (see lib/reply-limits.ts)
      greeting: false,
      timestamp: { gte: since },
    },
  });

const refused = (stop: Pick<SpeechStop, 'reason' | 'resetsAt' | 'retryAfterSeconds'>): VoiceAllowance => ({ allowed: false, resetsAt: stop.resetsAt, stoppedBy: stop.reason, ...(stop.retryAfterSeconds !== undefined ? { retryAfterSeconds: stop.retryAfterSeconds } : {}) });

type Admitted = { turnId: string; contract: number; rateVersion: number | null; provider: string | null; memberSeconds: number | null; seconds: number | null; holdMicros: bigint | null };

/** What a reply that was admitted already is, as the game is told: the admission it was given, never a new one. */
function admissionOf(row: Admitted): ReplyAdmission | undefined {
  if (row.contract < 2 || row.rateVersion === null || row.seconds === null || row.holdMicros === null) return undefined;
  return { contract: 2, turnId: row.turnId, rateVersion: row.rateVersion, provider: row.provider, admittedSeconds: row.memberSeconds ?? row.seconds, maxSeconds: row.seconds, admittedMicros: Number(row.holdMicros) };
}

/**
 * The speech admission of one reply, inside the transaction that holds the speech lock: what it sets aside (the usual length for the person, the
 * enforceable longest in money for Universe, at the rate card as it is now), checked against the person's entitlement and the Speech budget,
 * and written as the row that holds it until its receipt arrives (contract 2) or for the saved time (contract 1, a game that cannot name the
 * reply on its receipt: it holds the longest reply for the person too, as before). Nothing is written for a reply that is turned down.
 */
async function admitSpeech(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  a: { botId: string; turnId: string; personKey: string; personId: string | null; now: Date; contract: number; provider: unknown; model: unknown; replySeconds: number; replyCharacters: number },
): Promise<{ ok: true; admission?: ReplyAdmission } | { ok: false; refusal: VoiceAllowance }> {
  const resetsAt = monthOf(a.now).end.toISOString();
  const planned = await planReply(tx, { provider: a.provider, model: a.model, replySeconds: a.replySeconds, replyCharacters: a.replyCharacters });
  if (!planned.ok) return { ok: false, refusal: refused({ reason: planned.stop === 'provider' ? 'provider' : 'budget', resetsAt }) };
  const { plan } = planned;
  const memberSeconds = a.contract >= 2 ? plan.memberSeconds : plan.maxSeconds;
  const held = await speechReserved(tx, { personKey: a.personKey.startsWith('anon:') ? null : a.personKey, replySeconds: a.replySeconds, now: a.now });
  const stop = await checkSpeechCap({ personId: a.personId, memberSeconds, exposureMicros: plan.price.micros, held }, a.now, tx);
  if (stop) return { ok: false, refusal: refused(stop) };
  const row = await tx.voiceReplyUse.create({
    data: {
      botId: a.botId,
      turnId: a.turnId,
      personKey: a.personKey,
      seconds: plan.maxSeconds,
      createdAt: a.now,
      contract: a.contract >= 2 ? 2 : 1,
      memberSeconds,
      holdMicros: BigInt(plan.price.micros),
      rateVersion: plan.price.rateVersion,
      provider: plan.company.adapter,
    },
  });
  return { ok: true, admission: a.contract >= 2 ? admissionOf(row) : undefined };
}

/**
 * May this reply be spoken? Asked by the bot server just before it says one that Universe AI pays for. A person the bot can't
 * name yet (no id) is never stopped: there is nobody to count. A reply that was allowed once is allowed again.
 */
export async function checkVoiceAllowance(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown; turnId?: unknown; contract?: unknown; provider?: unknown; model?: unknown },
  now: Date = new Date(),
): Promise<VoiceAllowance> {
  const turnId = typeof input.turnId === 'string' && input.turnId ? input.turnId : null;
  if (!turnId || turnId.length > 255) throw new ReplyAllowanceError('turnId is required (up to 255 characters)', 400);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);

  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  // Version 2 only when the game says so: it then promises to send the receipt that names this reply (docs/speech-admission-contract.md)
  const contract = input.contract === 2 ? 2 : 1;
  if (!userId) {
    // Nobody to count, but the Speech budget for everyone together still has its stop (lib/speech-cap.ts), and the reply holds what it may cost
    // like any other (under `anon:<bot>`, so asking again for the same reply is the same reply, and releasing it frees it)
    const { limits } = await servedVoiceLimits();
    return prisma.$transaction(async (tx): Promise<VoiceAllowance> => {
      await lockSpeech(tx);
      const already = await tx.voiceReplyUse.findUnique({ where: { botId_turnId: { botId, turnId } } });
      if (already) return { allowed: true, ...(contract >= 2 && admissionOf(already) ? { admission: admissionOf(already) } : {}) };
      const done = await admitSpeech(tx, { botId, turnId, personKey: `anon:${botId}`, personId: null, now, contract, provider: input.provider, model: input.model, replySeconds: limits.replySeconds, replyCharacters: limits.replyCharacters });
      return done.ok ? { allowed: true, ...(done.admission ? { admission: done.admission } : {}) } : done.refusal;
    }, SPEECH_LOCK);
  }

  const person = await resolveUsagePerson(userId, input.isGuest);
  const guest = !person.personId;
  // The same words the Universe AI reply window is kept under (lib/reply-limits.ts), so a spoken reply is in the same window
  const personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;

  const [served, extra] = await Promise.all([servedVoiceLimits(), extraFor(person, now)]);
  const { window } = served;
  const since = await windowStart(`ua:${personKey}`, window.hours, now);
  const resetsAt = new Date(since.getTime() + window.hours * HOUR).toISOString();

  // One person's replies are settled one at a time (a lock held to the end of the transaction), so two replies asked for at once
  // can't both take the last place, nothing is written for a reply that is turned down, and nothing has to be taken back
  return prisma.$transaction(async (tx): Promise<VoiceAllowance> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${personKey}))`;
    const already = await tx.voiceReplyUse.findUnique({ where: { botId_turnId: { botId, turnId } } });
    const spoken = await tx.voiceReplyUse.count({ where: { personKey, createdAt: { gte: since } } });
    const used = await usedReplies(tx, person, userId, since);
    // A reply asked for again was counted already, so what is left now is what is left
    if (already) return withAdmission(withLeft(repliesLeft(served, guest, spoken, used, extra), resetsAt), contract >= 2 ? admissionOf(already) : undefined);
    // A place is only for a reply when the replies kept for text stay kept: typed replies take places from the same window. The text of
    // this reply is counted as ever, and the bot server may have sent it before this is asked or not yet, so it is not counted twice:
    // `used` may already hold it, which is why the window only has to leave 0 places, not 1, and why what is left after this reply
    // is taken from `used` as it stands
    const { byVoice, byText } = places(served, guest, spoken, used, extra);
    // The person's own window of replies: theirs, so the reason is `person`
    if (byVoice < 1 || byText < 0) return { allowed: false, resetsAt, stoppedBy: 'person' };
    // The Speech budget and the person's own speech entitlement (lib/speech-cap.ts), asked before the reply is spoken, under the lock every
    // speech admission is made under, with what is already set aside and the books do not show yet, so replies asked for one after the other
    // (or at once, by different people) never all pass the last of what is allowed
    await lockSpeech(tx);
    const done = await admitSpeech(tx, { botId, turnId, personKey, personId: person.personId, now, contract, provider: input.provider, model: input.model, replySeconds: served.limits.replySeconds, replyCharacters: served.limits.replyCharacters });
    if (!done.ok) return done.refusal;
    const left = Math.min(byVoice - 1, byText);
    return withAdmission(withLeft(Number.isFinite(left) ? Math.max(0, Math.floor(left)) : null, resetsAt), done.admission);
  }, SPEECH_LOCK);
}

/**
 * What a person has left of their spoken replies, without counting anything or starting a window: the bot server asks it when
 * someone joins a bubble, so the Voice menu can say so before the first spoken reply. A window that has ended, or never began,
 * leaves them the whole allowance and has no end time. A person the bot can't name yet has no count (null).
 */
export async function voiceRepliesLeft(botId: string, input: { userId?: unknown; isGuest?: unknown }, now: Date = new Date()): Promise<VoiceLeft | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);
  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  if (!userId) return null;

  const person = await resolveUsagePerson(userId, input.isGuest);
  const guest = !person.personId;
  const personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;
  const [served, extra] = await Promise.all([servedVoiceLimits(), extraFor(person, now)]);
  const { window } = served;

  const row = await prisma.replyWindow.findUnique({ where: { key: `ua:${personKey}` }, select: { startedAt: true } });
  const endsAt = row ? new Date(row.startedAt.getTime() + window.hours * HOUR) : null;
  if (!row || !endsAt || endsAt <= now) return { left: repliesLeft(served, guest, 0, 0, extra), resetsAt: null };
  const [spoken, used] = await Promise.all([
    prisma.voiceReplyUse.count({ where: { personKey, createdAt: { gte: row.startedAt } } }),
    usedReplies(prisma, person, userId, row.startedAt),
  ]);
  return { left: repliesLeft(served, guest, spoken, used, extra), resetsAt: endsAt.toISOString() };
}

/**
 * A reply that was counted but never played (a person talked over it while it was being settled, a greeting that waited for audio
 * ran out of time, the voice provider failed) is given back to the person's window. Asked by the bot server under the reply's turn
 * id. Safe to ask twice, and a reply that was never counted (or already given back) releases nothing: `released` says whether
 * this call gave one back. A reply asked for again afterwards is counted again, as a new one.
 */
export async function releaseVoiceReply(botId: string, input: { turnId?: unknown }): Promise<{ released: boolean }> {
  const turnId = typeof input.turnId === 'string' && input.turnId ? input.turnId : null;
  if (!turnId || turnId.length > 255) throw new ReplyAllowanceError('turnId is required (up to 255 characters)', 400);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);
  // A reply whose receipt already arrived is spent, not given back: only a hold is released here
  const { count } = await prisma.voiceReplyUse.deleteMany({ where: { botId, turnId, settledAt: null } });
  return { released: count > 0 };
}
