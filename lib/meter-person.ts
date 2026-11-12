import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { memberAllowance } from '@/lib/meter-allowance';
import { runningExtra } from '@/lib/meter-grants';
import { openRequestFor } from '@/lib/meter-requests';
import { monthOf } from '@/lib/meter-values';

/**
 * What a super admin sees about one person on the person's page (game #1999): their chat and voice cost over the last week, their
 * computer use against this month's allowance, the disk their Bricks keep, whether they asked for more, and the extra usage
 * they have been given. Figures come from the meter's books; a figure with no price known is left out of the sums.
 */

export interface PersonGrant {
  grantKey: string;
  multiplier: number | null;
  noLimit: boolean;
  startsAt: string;
  endsAt: string;
  givenById: string;
  givenByName: string;
  settlement: 'gift' | 'to_bill';
  billedAt: string | null;
  note: string | null;
}

export interface PersonUsage {
  /** Chat and voice cost us in the last 7 days, millionths of a dollar. */
  chatWeekMicros: number;
  bricks: number;
  /** This month's computer spending, and the allowance it counts against: the usual, the raised one, or none. */
  computerMonthMicros: number;
  /** Null when no limit is lifted for them now. */
  allowanceMicros: number | null;
  noLimit: boolean;
  /** The usual allowance is not set yet, so there is nothing to count against. */
  allowanceSet: boolean;
  keptBytes: number;
  asked: { at: string } | null;
  extra: PersonGrant | null;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** `viewerId` is the super admin looking: extra usage they gave themselves reads "you", as the mock says it. */
export async function personUsage(personId: string, now: Date = new Date(), viewerId: string | null = null): Promise<PersonUsage> {
  const personKey = `person:${personId}`;
  const month = monthOf(now);
  const settings = await getMeterSettings();
  const [chat, computer, bricks, kept, open, extra, allowance] = await Promise.all([
    prisma.meterEvent.aggregate({ where: { personKey, pool: 'chat', payerKind: 'universe', occurredAt: { gte: new Date(now.getTime() - WEEK), lte: now } }, _sum: { costMicros: true } }),
    prisma.meterEvent.aggregate({ where: { personKey, pool: 'computer', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } }, _sum: { costMicros: true } }),
    prisma.bot.count({ where: { ownerId: personId, deletedAt: null } }),
    prisma.$queryRaw<{ bytes: bigint | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM(latest.quantity), 0)::bigint AS bytes FROM (
        SELECT DISTINCT ON (bot_id) quantity FROM meter_events
        WHERE kind = 'stored_bytes' AND person_key = ${personKey} AND bot_id IS NOT NULL
        ORDER BY bot_id, occurred_at DESC, recorded_at DESC
      ) latest`),
    openRequestFor(personId),
    runningExtra(personId, now),
    memberAllowance(personId, now, settings),
  ]);
  let grant: PersonGrant | null = null;
  if (extra) {
    const row = await prisma.meterGrant.findUnique({ where: { grantKey: extra.grantKey } });
    if (row) {
      const giver = await prisma.user.findUnique({ where: { id: row.givenById }, select: { name: true, email: true } });
      grant = {
        grantKey: row.grantKey,
        multiplier: row.noLimit ? null : row.multiplier,
        noLimit: row.noLimit,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        givenById: row.givenById,
        givenByName: viewerId && row.givenById === viewerId ? 'you' : giver?.name?.trim() || giver?.email || 'a super admin',
        settlement: row.settlement === 'to_bill' ? 'to_bill' : 'gift',
        billedAt: row.billedAt?.toISOString() ?? null,
        note: row.note,
      };
    }
  }
  const base = settings.memberAllowanceMicros;
  return {
    chatWeekMicros: Number(chat._sum.costMicros ?? 0),
    bricks,
    computerMonthMicros: Number(computer._sum.costMicros ?? 0),
    allowanceMicros: base === null ? null : allowance?.unlimited ? null : base * (extra?.multiplier ?? 1),
    noLimit: !!allowance?.unlimited,
    allowanceSet: base !== null,
    keptBytes: Number(kept[0]?.bytes ?? 0),
    asked: open ? { at: open.createdAt.toISOString() } : null,
    extra: grant,
  };
}
