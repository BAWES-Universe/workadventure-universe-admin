import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { monthOf, nextMonthStart, usageWords, type UsageWords } from '@/lib/meter-values';
import { extendedCeiling, runningEntitlement, type EntitlementScope } from '@/lib/entitlement-grants';
import { openRequestFor } from '@/lib/meter-requests';
import { getRateCard } from '@/lib/speech-rates';
import { speechSpent } from '@/lib/speech-cap';

/**
 * The one entitlement a person is shown for speech and for Apps (billing consensus v2, P5): their own monthly allowance, in plain words
 * (never a number a visitor could use), with whether they asked for more, whether "Ask for more" is offered (only when this entitlement is
 * used up, never for a platform budget), and the extra running for it. A super admin's view adds the numbers and what a grant would extend.
 *
 *  - speech: `speechMemberCeilingSeconds`, against the seconds Universe AI paid for this month (hearing and speaking).
 *  - apps: `appUseMemberCeilingMicros`, against what this person's Bricks used of connected Apps on Universe's money this month.
 */
export interface EntitlementLine {
  scope: EntitlementScope;
  /** What is left of their own entitlement, 0 to 1. */
  left: number;
  words: UsageWords;
  /** When it starts again: the first moment of next month (UTC). */
  startsAgainAt: string;
  /** They have asked and nobody has answered yet. */
  asked: boolean;
  /** Offered only when this entitlement is used up. */
  canAskForMore: boolean;
  /** The extra running for it: a multiple, or no limit on their own entitlement, and when it ends. Never a platform budget. */
  extra: { multiplier: number | null; noLimit: boolean; until: string } | null;
}

export interface EntitlementFigures {
  unit: 'seconds' | 'micros';
  used: number;
  /** The saved entitlement, before any extra; null while none is saved. */
  base: number | null;
  /** With the extra running; null means no limit on their own entitlement. */
  ceiling: number | null;
}

/** What this person has used of an entitlement this month, in its own unit. */
async function usedOf(personId: string, scope: EntitlementScope, now: Date): Promise<number> {
  const month = monthOf(now);
  if (scope === 'speech') return (await speechSpent(prisma, await getRateCard(prisma), now, personId)).seconds;
  const sum = await prisma.meterEvent.aggregate({
    where: { pool: 'chat', kind: 'app_use', route: 'app', payerKind: 'universe', personKey: `person:${personId}`, occurredAt: { gte: month.start, lt: month.end } },
    _sum: { costMicros: true },
  });
  return Number(sum._sum.costMicros ?? 0);
}

/**
 * One person's entitlement of one scope. Null while the entitlement is not saved (there is nothing to count against) or the person has used
 * none of it this month and has no extra: a line that has nothing to say is not shown.
 */
export async function entitlementLine(personId: string, scope: EntitlementScope, now: Date = new Date(), withFigures = false): Promise<{ line: EntitlementLine; figures: EntitlementFigures } | null> {
  const settings = await getMeterSettings();
  const base = scope === 'speech' ? settings.speechMemberCeilingSeconds : settings.appUseMemberCeilingMicros;
  const [extra, used, open] = await Promise.all([runningEntitlement(personId, scope, now), usedOf(personId, scope, now), openRequestFor(personId, scope === 'speech' ? 'speech' : 'apps')]);
  if (base === null) return null;
  if (!withFigures && used === 0 && !extra) return null;
  const ceiling = extendedCeiling(base, extra);
  const left = ceiling === null ? 1 : ceiling > 0 ? Math.min(1, Math.max(0, (ceiling - used) / ceiling)) : 0;
  const words = ceiling === null ? 'plenty' : usageWords(left);
  return {
    line: {
      scope,
      left,
      words,
      startsAgainAt: nextMonthStart(now).toISOString(),
      asked: open !== null,
      canAskForMore: words === 'out',
      extra: extra ? { multiplier: extra.noLimit ? null : extra.multiplier, noLimit: extra.noLimit, until: extra.endsAt.toISOString() } : null,
    },
    figures: { unit: scope === 'speech' ? 'seconds' : 'micros', used, base, ceiling },
  };
}
