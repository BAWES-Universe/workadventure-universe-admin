import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { memberAllowance } from '@/lib/meter-allowance';
import { runningExtra, type RunningExtra } from '@/lib/meter-grants';
import { openRequestFor } from '@/lib/meter-requests';
import { getUniverseAiReplyLimits } from '@/lib/bot-limits';
import { nextMonthStart, usageWords, type UsageWords } from '@/lib/meter-values';

/**
 * What a person sees about their usage (game #1999): one bar and plain words, never a count of replies and never a price.
 *
 *  - Chat and voice: the Universe AI bar (the shipped fair usage, text and voice together, game #1159). It counts only what
 *    Universe AI paid for: a Brick on the person's own key uses none of it.
 *  - Computer time: this month's allowance, in the same plain words. Shown only to someone whose Brick uses a computer.
 *  - Storage: what their Bricks keep. There is no limit for now, and it says so.
 *  - Extra usage: one plain line while it runs. Nothing about how it was given or billed.
 */

export interface UsageBar {
  /** What is left, 0 to 1: the bar. */
  left: number;
  words: UsageWords;
  /** When the bar is full again; null when nothing has been used in a window that is running. */
  fullAgainAt: string | null;
}

export interface ComputerBar {
  left: number;
  words: UsageWords;
  /** The first moment of next month, when the allowance starts again. */
  startsAgainAt: string;
  /** True while extra usage lifts the member's own limit. */
  unlimited: boolean;
  /** They have asked and nobody has answered yet. */
  asked: boolean;
  /** "Ask for more" is only offered when the allowance ran out. */
  canAskForMore: boolean;
}

export interface MemberUsage {
  chat: UsageBar;
  computer: ComputerBar | null;
  storage: { bytes: number } | null;
  extra: { until: string } | null;
}

/**
 * The Universe AI bar. Read without starting a window: someone who has not asked for anything in the last window sees a full
 * bar and no end time. With extra usage running the bar is measured against the raised limit; with no limit it is always full.
 */
export async function chatBar(personId: string, now: Date, extra: RunningExtra | null): Promise<UsageBar> {
  const limits = await getUniverseAiReplyLimits();
  const key = `ua:person:${personId}`;
  const row = await prisma.replyWindow.findUnique({ where: { key } });
  const endsAt = row ? new Date(row.startedAt.getTime() + limits.windowHours * 3_600_000) : null;
  if (!row || !endsAt || endsAt <= now) return { left: 1, words: 'plenty', fullAgainAt: null };
  if (extra?.noLimit) return { left: 1, words: 'plenty', fullAgainAt: null };
  // Replies Universe AI paid for, from every Brick and bot: a reply a person's own key paid for is nobody's here
  const used = await prisma.botsAiUsage.count({ where: { talkedPersonId: personId, keyOwnerId: null, error: false, greeting: false, timestamp: { gte: row.startedAt } } });
  const limit = limits.signedIn * (extra?.multiplier ?? 1);
  const left = limit > 0 ? Math.min(1, Math.max(0, 1 - used / limit)) : 0;
  return { left, words: left >= 1 ? 'plenty' : chatWords(left), fullAgainAt: endsAt.toISOString() };
}

/** Chat's words: plenty until it is low, so the bar and the line agree ("Plenty left" is anything above a fifth). */
function chatWords(left: number): UsageWords {
  const words = usageWords(left);
  return words === 'half' ? 'plenty' : words;
}

/** Whether any of a person's Bricks has ever used a computer: only then do computer time and storage show. */
async function usesComputer(personId: string): Promise<boolean> {
  const found = await prisma.meterEvent.findFirst({ where: { personKey: `person:${personId}`, pool: 'computer' }, select: { id: true } });
  return !!found;
}

/** The bytes a person's Bricks keep: the newest size recorded for each of their Bricks, since a disk is a level. */
async function storedBytes(personId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT COALESCE(SUM(latest.quantity), 0)::bigint AS bytes FROM (
      SELECT DISTINCT ON (bot_id) quantity FROM meter_events
      WHERE kind = 'stored_bytes' AND person_key = ${`person:${personId}`} AND bot_id IS NOT NULL
      ORDER BY bot_id, occurred_at DESC, recorded_at DESC
    ) latest`;
  return Number(rows[0]?.bytes ?? 0);
}

/** What a signed-in person sees on their Usage page. */
export async function memberUsage(personId: string, now: Date = new Date()): Promise<MemberUsage> {
  const extra = await runningExtra(personId, now);
  const chat = await chatBar(personId, now, extra);
  let computer: ComputerBar | null = null;
  let storage: MemberUsage['storage'] = null;
  if (await usesComputer(personId)) {
    const settings = await getMeterSettings();
    const allowance = await memberAllowance(personId, now, settings);
    const asked = (await openRequestFor(personId)) !== null;
    if (allowance && settings.memberAllowanceMicros) {
      // Against what they have now: the usual, or the raised one while extra usage runs, so the bar is never more than full
      const total = settings.memberAllowanceMicros * (extra?.multiplier ?? 1);
      const left = allowance.unlimited ? 1 : Math.min(1, Math.max(0, (allowance.leftMicros ?? 0) / total));
      const words = allowance.unlimited ? 'plenty' : usageWords(left);
      computer = { left, words, startsAgainAt: nextMonthStart(now).toISOString(), unlimited: allowance.unlimited, asked, canAskForMore: words === 'out' };
    }
    storage = { bytes: await storedBytes(personId) };
  }
  return { chat, computer, storage, extra: extra ? { until: extra.endsAt.toISOString() } : null };
}
