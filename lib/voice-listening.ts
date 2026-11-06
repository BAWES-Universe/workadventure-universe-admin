import { prisma } from '@/lib/db';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { effectiveBotVoice } from '@/lib/bot-voice';

/**
 * A bot's daily listening limit (game #1859, Orbit #740): "minutes a day one bot listens for its name, all the people near it
 * together". The bot server reports the seconds of group speech it sent to the listening provider that were not said to the bot
 * (a person alone with it is never counted), and once the day's minutes are used the bot stops taking group microphones until the
 * next UTC day. It still answers typed lines and still speaks, so a spent day is text for the group, never a hard stop.
 *
 * The limit is the voice limit a super admin sets (recommended 60), or the one the owner of a lent listening key set on that key
 * (#783), read from the same place the bot server reads its limits (effectiveBotVoice), so a change needs no deploy.
 */
export interface ListeningDay {
  /** True once the day's minutes are used: the bot stops listening to groups until `resetsAt`. */
  spent: boolean;
  usedSeconds: number;
  limitSeconds: number;
  /** The start of the next UTC day. */
  resetsAt: string;
}

/** The most one report may add: a day of listening is at most 1,440 minutes and a report covers a few minutes, so a bigger number is a mistake. */
export const MAX_REPORT_SECONDS = 3_600;

const dayOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Adds seconds of group listening to the bot's day (0 adds nothing and only reads) and says whether the day's minutes are used.
 * A report that pushes the day past the limit still counts in full, so the day can show how much was heard.
 */
export async function reportListening(botId: string, input: { seconds?: unknown }, now: Date = new Date()): Promise<ListeningDay> {
  const raw = input.seconds === undefined ? 0 : input.seconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_REPORT_SECONDS) {
    throw new ReplyAllowanceError(`seconds must be a number from 0 to ${MAX_REPORT_SECONDS}`, 400);
  }
  const seconds = Math.round(raw);

  const day = dayOf(now);
  const resetsAt = new Date(day.getTime() + 24 * 60 * 60 * 1000).toISOString();
  // Throws "Bot not found" (404) for a bot that does not exist. Key health is left out: a Down key reads as "key-down" with no profile,
  // which would swap a lent listening key's own limit for the server's
  const { limits } = await effectiveBotVoice(botId, { ignoreSwitch: true, ignoreKeyHealth: true });
  const limitSeconds = Math.max(0, Math.round(limits.listenMinutesPerDay * 60));

  // One statement adds to the day, so reports that arrive together are all counted
  const row =
    seconds > 0
      ? await prisma.voiceListenUse.upsert({
          where: { botId_day: { botId, day } },
          create: { botId, day, seconds },
          update: { seconds: { increment: seconds } },
          select: { seconds: true },
        })
      : await prisma.voiceListenUse.findUnique({ where: { botId_day: { botId, day } }, select: { seconds: true } });
  const usedSeconds = row?.seconds ?? 0;
  return { spent: usedSeconds >= limitSeconds, usedSeconds, limitSeconds, resetsAt };
}
