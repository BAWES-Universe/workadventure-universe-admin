import { prisma } from '@/lib/db';
import { resolveUsagePerson } from '@/lib/usage-person';
import { ReplyAllowanceError, windowStart } from '@/lib/reply-limits';
import { servedVoiceLimits } from '@/lib/voice-limits';
import { repliesPerWindowFor } from '@/lib/credit-replies';
import { textReserve, voiceReplies } from '@/lib/voice-limit-values';
import { runningExtra, type RunningExtra } from '@/lib/meter-grants';
import { checkSpeechCap } from '@/lib/speech-cap';
import { lockSpeech, speechReserved, SPEECH_LOCK } from '@/lib/speech-reserved';

/**
 * Voice replies inside the Universe AI allowance (game #1669), decided by Khalid 29 Oct 2026: a spoken reply comes out of the
 * same 5-hour window as a text reply, with some replies always kept for text (30 keeps 5, 10 keeps 2) and a guest limited to 3
 * spoken ones. The numbers are the voice limits (#740), so a super admin changes them with no deploy.
 *
 * The text of a reply is counted as ever, in the usage rows. This counts which replies were also spoken, one row per reply under
 * the turn the bot server names it by, so asking again for the same reply (a retry, a reconnect) never counts it twice.
 */
export type VoiceAllowance =
  /** `left`: spoken replies still possible after this one; `resetsAt`: when the person's window ends. Both are missing for a person nobody could name. */
  | { allowed: true; left?: number; resetsAt?: string }
  | { allowed: false; resetsAt: string };

/** What a person has left, for the line at the bottom of the Voice menu. `resetsAt` is null while no window is running (nothing used yet). */
export interface VoiceLeft {
  /** `null` while the person has no limit (extra usage with no limit is running): there is no number to show. `null` with no `unlimited` is a person nobody could name. */
  left: number | null;
  resetsAt: string | null;
  /** True when `left` is null because the person has no limit (so the menu can say "unlimited"); absent otherwise, so a game that does not read it still reads null as "nothing to show". */
  unlimited?: true;
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
  // The replies kept for text, and the voice replies, are worked out from the window the person really has, after its multiple, the way the
  // text limit does (lib/reply-limits.ts): scaling the usual window's own figures would leave a one-reply window with a 2x grant no place at all
  const total = window.replies * times;
  return { byVoice: voiceReplies(total, served.limits, guest) - spoken, byText: total - used - textReserve(total, served.limits.textReserveShare) };
}

/**
 * The windows a person is served: a signed-in person's own number of replies when a super admin's exception sets one (or gives none, so
 * a spoken reply is no place either), the usual one when it does not. The text limit reads it the same way (lib/reply-limits.ts).
 */
async function servedFor(served: Served, person: { personId: string | null }, now: Date): Promise<Served> {
  if (!person.personId) return served;
  const base = served.window.signedIn.replies;
  const replies = await repliesPerWindowFor(person.personId, base, now);
  if (replies === base) return served;
  return { ...served, window: { ...served.window, signedIn: { replies, textReserve: textReserve(replies, served.limits.textReserveShare), voiceReplies: voiceReplies(replies, served.limits, false) } } };
}

/** The extra usage running for a signed-in person now, if any; a guest has none. */
const extraFor = (person: { personId: string | null }, now: Date) => (person.personId ? runningExtra(person.personId, now) : Promise.resolve(null));

/** An allowed answer; no `left` when there is no limit to count down from. */
const withLeft = (left: number | null, resetsAt: string): VoiceAllowance => (left === null ? { allowed: true, resetsAt } : { allowed: true, left, resetsAt });

/** The Universe AI replies a person got in a window, from any bot, as the text limit counts them (lib/reply-limits.ts). */
const usedReplies = (db: Pick<typeof prisma, 'botsAiUsage'>, person: { personId: string | null }, userId: string, since: Date) =>
  db.botsAiUsage.count({
    where: {
      ...(person.personId ? { talkedPersonId: person.personId } : { talkedUserId: userId, talkedGuest: true }),
      keyOwnerId: null,
      error: false,
      // A greeting the bot made on its own is free for the person (see lib/reply-limits.ts)
      greeting: false,
      // So is a look Universe AI's vision took at an image: the person's use, never a reply
      imageRead: false,
      timestamp: { gte: since },
    },
  });

/**
 * May this reply be spoken? Asked by the bot server just before it says one that Universe AI pays for. A person the bot can't
 * name yet (no id) is never stopped: there is nobody to count. A reply that was allowed once is allowed again.
 */
export async function checkVoiceAllowance(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown; turnId?: unknown },
  now: Date = new Date(),
): Promise<VoiceAllowance> {
  const turnId = typeof input.turnId === 'string' && input.turnId ? input.turnId : null;
  if (!turnId || turnId.length > 255) throw new ReplyAllowanceError('turnId is required (up to 255 characters)', 400);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);

  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  if (!userId) {
    // Nobody to count, but the month's speech for everyone together still has its stop (lib/speech-cap.ts), and the reply holds its seconds
    // like any other (under `anon:<bot>`, so asking again for the same reply is the same reply, and releasing it frees them)
    const replySeconds = (await servedVoiceLimits()).limits.replySeconds;
    return prisma.$transaction(async (tx): Promise<VoiceAllowance> => {
      await lockSpeech(tx);
      if (await tx.voiceReplyUse.findUnique({ where: { botId_turnId: { botId, turnId } }, select: { id: true } })) return { allowed: true };
      const stop = await checkSpeechCap({ personId: null, seconds: replySeconds, inFlight: await speechReserved(tx, { personKey: null, replySeconds, now }) }, now, tx);
      if (stop) return { allowed: false, resetsAt: stop.resetsAt };
      await tx.voiceReplyUse.create({ data: { botId, turnId, personKey: `anon:${botId}`, seconds: replySeconds, createdAt: now } });
      return { allowed: true };
    }, SPEECH_LOCK);
  }

  const person = await resolveUsagePerson(userId, input.isGuest);
  const guest = !person.personId;
  // The same words the Universe AI reply window is kept under (lib/reply-limits.ts), so a spoken reply is in the same window
  const personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;

  const [usual, extra] = await Promise.all([servedVoiceLimits(), extraFor(person, now)]);
  const served = await servedFor(usual, person, now);
  const { window } = served;
  const since = await windowStart(`ua:${personKey}`, window.hours, now);
  const resetsAt = new Date(since.getTime() + window.hours * HOUR).toISOString();

  // One person's replies are settled one at a time (a lock held to the end of the transaction), so two replies asked for at once
  // can't both take the last place, nothing is written for a reply that is turned down, and nothing has to be taken back
  return prisma.$transaction(async (tx): Promise<VoiceAllowance> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${personKey}))`;
    const already = await tx.voiceReplyUse.findUnique({ where: { botId_turnId: { botId, turnId } }, select: { id: true } });
    const spoken = await tx.voiceReplyUse.count({ where: { personKey, createdAt: { gte: since } } });
    const used = await usedReplies(tx, person, userId, since);
    // A reply asked for again was counted already, so what is left now is what is left
    if (already) return withLeft(repliesLeft(served, guest, spoken, used, extra), resetsAt);
    // A place is only for a reply when the replies kept for text stay kept: typed replies take places from the same window. The text of
    // this reply is counted as ever, and the bot server may have sent it before this is asked or not yet, so it is not counted twice:
    // `used` may already hold it, which is why the window only has to leave 0 places, not 1, and why what is left after this reply
    // is taken from `used` as it stands
    const { byVoice, byText } = places(served, guest, spoken, used, extra);
    if (byVoice < 1 || byText < 0) return { allowed: false, resetsAt };
    // The month's spending stop on the speech Universe AI pays for, asked with the longest a reply may be, before it is spoken (lib/speech-cap.ts).
    // Under the lock every speech reservation is made under, with what notes and replies already admitted hold and the books do not show yet,
    // so replies asked for one after the other (or at once, by different people) never all pass the last seconds of a Limit
    await lockSpeech(tx);
    const inFlight = await speechReserved(tx, { personKey, replySeconds: served.limits.replySeconds, now });
    const stop = await checkSpeechCap({ personId: person.personId, seconds: served.limits.replySeconds, inFlight }, now, tx);
    if (stop) return { allowed: false, resetsAt: stop.resetsAt };
    await tx.voiceReplyUse.create({ data: { botId, turnId, personKey, seconds: served.limits.replySeconds, createdAt: now } });
    const left = Math.min(byVoice - 1, byText);
    return withLeft(Number.isFinite(left) ? Math.max(0, Math.floor(left)) : null, resetsAt);
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
  const [usual, extra] = await Promise.all([servedVoiceLimits(), extraFor(person, now)]);
  const served = await servedFor(usual, person, now);
  const { window } = served;

  const row = await prisma.replyWindow.findUnique({ where: { key: `ua:${personKey}` }, select: { startedAt: true } });
  const endsAt = row ? new Date(row.startedAt.getTime() + window.hours * HOUR) : null;
  if (!row || !endsAt || endsAt <= now) return withUnlimited({ left: repliesLeft(served, guest, 0, 0, extra), resetsAt: null });
  const [spoken, used] = await Promise.all([
    prisma.voiceReplyUse.count({ where: { personKey, createdAt: { gte: row.startedAt } } }),
    usedReplies(prisma, person, userId, row.startedAt),
  ]);
  return withUnlimited({ left: repliesLeft(served, guest, spoken, used, extra), resetsAt: endsAt.toISOString() });
}

/** A person with no limit has no number, and says so: null alone also means "nobody the bot could name". */
const withUnlimited = (answer: VoiceLeft): VoiceLeft => (answer.left === null ? { ...answer, unlimited: true } : answer);

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
  const { count } = await prisma.voiceReplyUse.deleteMany({ where: { botId, turnId } });
  return { released: count > 0 };
}
