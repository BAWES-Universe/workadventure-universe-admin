import { prisma } from '@/lib/db';
import { getMeterSettings, getMeterSettingsStrict } from '@/lib/meter';
import { heldRoom, memberAllowance } from '@/lib/meter-allowance';
import { runningExtra, type RunningExtra } from '@/lib/meter-grants';
import { openRequestFor } from '@/lib/meter-requests';
import { getUniverseAiReplyLimits } from '@/lib/bot-limits';
import { nextMonthStart, usageWords, type UsageWords } from '@/lib/meter-values';
import { activityFor, type ActivityItem } from '@/lib/task-receipts';
import { repliesPerWindowFor } from '@/lib/credit-replies';
import { creditUsage, type CreditEntry, type MoneyLine, type Unavailable } from '@/lib/credit-usage';

/**
 * What a person sees about their usage (game #1999): one bar and plain words, never a count of replies and never a price.
 *
 *  - Chat and voice: the Universe AI bar (the shipped fair usage, text and voice together, game #1159). It counts only what
 *    Universe AI paid for: a Brick on the person's own key uses none of it.
 *  - Computer time: this month's allowance, in the same plain words. Shown only to someone whose Brick uses a computer.
 *  - Storage: what their Bricks keep. There is no limit for now, and it says so.
 *  - Extra usage: one plain line while it runs. Nothing about how it was given or billed.
 *
 * Paying spec v3 adds real numbers beside those words (additive: every old field keeps its meaning, and every new one is optional for the
 * reader): replies as "18 of 30 available", Instant Apps in dollars, computer dollars, extra credit, and a version stamp so an older
 * answer never overwrites a newer one. A part that cannot be read says `unavailable`, never a made-up full or empty bar.
 */

export interface UsageBar {
  /** What is left, 0 to 1: the bar. */
  left: number;
  words: UsageWords;
  /** When the bar is full again; null when nothing has been used in a window that is running. */
  fullAgainAt: string | null;
  /** Real counts: what is available out of the total for this window. `running` is false while no window has started (opening Usage never starts one). Missing with no personal limit. */
  replies?: { available: number; total: number; running: boolean; windowHours: number };
  /** The extra running now: a multiple of the usual, or no personal limit, and when it ends. */
  extra?: { multiplier: number | null; noLimit: boolean; until: string };
  /** The numbers could not be read. */
  unavailable?: true;
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
  /** The same allowance in dollars (omitted while extra usage lifts the member's own limit). */
  kind?: 'monthly';
  availableMicros?: number;
  totalMicros?: number;
  inProgressMicros?: number;
  renewsAt?: string;
  /** The numbers could not be read: the part says so rather than show a made-up bar. */
  unavailable?: boolean;
}

export interface MemberUsage {
  /** A stamp that only grows: the moment this was read. A reader keeps the answer with the bigger one. */
  version: number;
  chat: UsageBar;
  computer: ComputerBar | null;
  storage: { bytes: number } | null;
  extra: { until: string } | null;
  /** One line for each finished task, newest first (paying spec 3, part O4): what it used and who paid. Empty when none, or when it could not be read. */
  activity: ActivityItem[];
  /** Instant Apps credit, in dollars. Missing (null) when nobody has been given any: no section. */
  apps?: MoneyLine | Unavailable | null;
  /** Extra credit someone has now, one amount for everything it covers. */
  credit?: CreditEntry[] | Unavailable;
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
  // What the replies check enforces: Limits' number, or a super admin's exception for this person, times any extra running
  const perWindow = await repliesPerWindowFor(personId, limits.signedIn, now);
  const total = perWindow * (extra?.multiplier ?? 1);
  const extraWords = extra ? { multiplier: extra.noLimit ? null : extra.multiplier, noLimit: extra.noLimit, until: extra.endsAt.toISOString() } : undefined;
  if (extra?.noLimit) return { left: 1, words: 'plenty', fullAgainAt: null, extra: extraWords };
  if (!row || !endsAt || endsAt <= now) return { left: perWindow > 0 ? 1 : 0, words: perWindow > 0 ? 'plenty' : 'out', fullAgainAt: null, replies: { available: total, total, running: false, windowHours: limits.windowHours }, ...(extraWords ? { extra: extraWords } : {}) };
  // Replies Universe AI paid for, from every Brick and bot: a reply a person's own key paid for is nobody's here
  const used = await prisma.botsAiUsage.count({ where: { talkedPersonId: personId, keyOwnerId: null, error: false, greeting: false, imageRead: false, timestamp: { gte: row.startedAt } } });
  const left = total > 0 ? Math.min(1, Math.max(0, 1 - used / total)) : 0;
  return {
    left,
    words: left >= 1 ? 'plenty' : chatWords(left),
    // A window a reply check started before any reply was counted is full and has nothing to wait for
    fullAgainAt: used === 0 ? null : endsAt.toISOString(),
    replies: { available: Math.max(0, total - used), total, running: true, windowHours: limits.windowHours },
    ...(extraWords ? { extra: extraWords } : {}),
  };
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
  // Never a made-up bar: if the numbers cannot be read, the part says so
  const chat: UsageBar = await chatBar(personId, now, extra).catch((error): UsageBar => {
    console.error('[Usage] Could not read the chat bar:', error instanceof Error ? error.message : 'unknown');
    return { left: 0, words: 'out', fullAgainAt: null, unavailable: true };
  });
  const money = await creditUsage(personId, now);
  let computer: ComputerBar | null = null;
  let storage: MemberUsage['storage'] = null;
  // A computer part that cannot be read says so and leaves the others as they are: the bar and the credit above are what the person came for
  try {
  if (await usesComputer(personId)) {
    // Read strictly: a failed read must reach the catch below and show the computer part as unavailable, not leave it out as "no allowance"
    const settings = await getMeterSettingsStrict();
    // The allowance, the grant it was worked from and the room held are read from one snapshot, so an admin changing a grant between
    // the reads can never leave the bar with a total from one grant and a figure left from another
    const { allowance, grant, held } = await prisma.$transaction(
      async (tx) => {
        const grant = await runningExtra(personId, now, tx);
        const allowance = await memberAllowance(personId, now, settings, tx);
        const held = !allowance || allowance.unlimited ? 0 : await heldRoom(personId, now, tx);
        return { grant, allowance, held };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    const asked = (await openRequestFor(personId, 'computer')) !== null;
    if (allowance && settings.memberAllowanceMicros) {
      // Against what they have now: the usual, or the raised one while extra usage runs, so the bar is never more than full
      // (their month is the default, or what an exception says for them, and credit given to them for computers is on top of it)
      const total = allowance.baseMicros * (grant?.multiplier ?? 1) + allowance.creditTotalMicros;
      // What is left is what new work can take: the allowance less everything held, as admission counts it (a hold that ran out and is not yet settled still counts)
      const available = allowance.unlimited ? 0 : Math.max(0, (allowance.leftMicros ?? 0) - held);
      const left = allowance.unlimited ? 1 : total > 0 ? Math.min(1, Math.max(0, available / total)) : 0;
      const words = allowance.unlimited ? 'plenty' : usageWords(left);
      const inProgress = await prisma.meterReservation.aggregate({ where: { personKey: `person:${personId}`, state: 'held', expiresAt: { gt: now } }, _sum: { amountMicros: true } });
      computer = {
        left,
        words,
        startsAgainAt: nextMonthStart(now).toISOString(),
        unlimited: allowance.unlimited,
        asked,
        canAskForMore: words === 'out',
        ...(allowance.unlimited ? {} : { kind: 'monthly' as const, availableMicros: available, totalMicros: total, inProgressMicros: Number(inProgress._sum.amountMicros ?? 0), renewsAt: nextMonthStart(now).toISOString(), unavailable: false as const }),
      };
    }
    storage = { bytes: await storedBytes(personId) };
  }
  } catch (error) {
    console.error('[Usage] Could not read the computer part:', error instanceof Error ? error.message : 'unknown');
    computer = { left: 0, words: 'out', startsAgainAt: nextMonthStart(now).toISOString(), unlimited: false, asked: false, canAskForMore: false, unavailable: true };
    storage = null;
  }
  // A receipt that cannot be read leaves the list empty, never the whole page: the bars above are what the person came for
  const activity = await activityFor(personId).catch((error) => {
    console.error('[Usage] Could not read Activity:', error instanceof Error ? error.message : 'unknown');
    return [];
  });
  return { version: now.getTime(), chat, computer, storage, extra: extra ? { until: extra.endsAt.toISOString() } : null, apps: money.apps, credit: money.credit, activity };
}
