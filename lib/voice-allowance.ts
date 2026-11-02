import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveUsagePerson } from '@/lib/usage-person';
import { ReplyAllowanceError, windowStart } from '@/lib/reply-limits';
import { servedVoiceLimits } from '@/lib/voice-limits';

/**
 * Voice replies inside the Universe AI allowance (game #1669), decided by Khalid 29 Oct 2026: a spoken reply comes out of the
 * same 5-hour window as a text reply, with some replies always kept for text (30 keeps 5, 10 keeps 2) and a guest limited to 3
 * spoken ones. The numbers are the voice limits (#740), so a super admin changes them with no deploy.
 *
 * The text of a reply is counted as ever, in the usage rows. This counts which replies were also spoken, one row per reply under
 * the turn the bot server names it by, so asking again for the same reply (a retry, a reconnect) never counts it twice.
 */
export type VoiceAllowance = { allowed: true } | { allowed: false; resetsAt: string };

const HOUR = 60 * 60 * 1000;

const isUniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

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
  if (!userId) return { allowed: true };

  const already = await prisma.voiceReplyUse.findUnique({ where: { botId_turnId: { botId, turnId } }, select: { id: true } });
  if (already) return { allowed: true };

  const person = await resolveUsagePerson(userId, input.isGuest);
  const guest = !person.personId;
  // The same words the Universe AI reply window is kept under (lib/reply-limits.ts), so a spoken reply is in the same window
  const personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;

  const { window } = await servedVoiceLimits();
  const spokenLimit = guest ? window.guest.voiceReplies : window.signedIn.voiceReplies;
  const since = await windowStart(`ua:${personKey}`, window.hours, now);

  // The reply is written down first and counted after, so two replies asked for at once can't both take the last place
  try {
    await prisma.voiceReplyUse.create({ data: { botId, turnId, personKey, createdAt: now } });
  } catch (error) {
    if (isUniqueViolation(error)) return { allowed: true };
    throw error;
  }
  const spoken = await prisma.voiceReplyUse.count({ where: { personKey, createdAt: { gte: since } } });
  if (spoken <= spokenLimit) return { allowed: true };

  await prisma.voiceReplyUse.delete({ where: { botId_turnId: { botId, turnId } } }).catch(() => undefined);
  return { allowed: false, resetsAt: new Date(since.getTime() + window.hours * HOUR).toISOString() };
}
