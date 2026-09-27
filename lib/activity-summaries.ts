import { Prisma } from '@prisma/client';
import type { Viewer } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import type { HourBucket } from '@/lib/analytics-peak';
import { viewerWasLast } from '@/lib/analytics-viewer';

export type SummaryKind = 'rooms' | 'worlds' | 'universes';

/** At most this many places per request; the client splits bigger lists. */
export const MAX_SUMMARY_IDS = 100;

/** What every card shows about a place: how busy, when, and when you and the latest visitor were there. */
export interface ActivitySummary {
  totalAccesses: number;
  peakTimes: HourBucket[];
  lastVisitedByUser: { accessedAt: Date; userId: string | null; userUuid: string | null } | null;
  /** Only when: cards never say who the latest visitor was. */
  lastVisitedOverall: { accessedAt: Date } | null;
  youWereLast: boolean;
}

// Whitelisted: the only identifiers ever put into SQL.
const COLUMN: Record<SummaryKind, { field: 'roomId' | 'worldId' | 'universeId'; sql: Prisma.Sql }> = {
  rooms: { field: 'roomId', sql: Prisma.raw('room_id') },
  worlds: { field: 'worldId', sql: Prisma.raw('world_id') },
  universes: { field: 'universeId', sql: Prisma.raw('universe_id') },
};

export function isSummaryKind(value: unknown): value is SummaryKind {
  return value === 'rooms' || value === 'worlds' || value === 'universes';
}

type LastRow = { id: string; accessed_at: Date; user_id: string | null; user_uuid: string | null };

/**
 * Activity for many places in four queries, whatever their number: totals, all-time UTC hour buckets, the latest
 * visit, and the viewer's own latest visit. A place with no visits (or that doesn't exist) gets zeros.
 */
export async function activitySummaries(
  kind: SummaryKind,
  ids: string[],
  viewer: Viewer,
): Promise<Record<string, ActivitySummary>> {
  const unique = Array.from(new Set(ids)).slice(0, MAX_SUMMARY_IDS);
  if (unique.length === 0) return {};
  const { field, sql: column } = COLUMN[kind];
  const idList = Prisma.join(unique);
  const user = viewer.kind === 'user' ? viewer.user : null;

  const [totals, hours, latest, yours] = await Promise.all([
    prisma.roomAccess.groupBy({
      by: [field],
      where: { [field]: { in: unique } },
      _count: { _all: true },
    }) as unknown as Promise<Array<Record<string, unknown> & { _count: { _all: number } }>>,
    prisma.$queryRaw<Array<{ id: string; hour: number; count: bigint | number }>>`
      SELECT ${column} AS id, EXTRACT(HOUR FROM accessed_at)::int AS hour, COUNT(*) AS count
      FROM room_accesses
      WHERE ${column} IN (${idList})
      GROUP BY 1, 2`,
    prisma.$queryRaw<LastRow[]>`
      SELECT DISTINCT ON (${column}) ${column} AS id, accessed_at, user_id, user_uuid
      FROM room_accesses
      WHERE ${column} IN (${idList})
      ORDER BY ${column}, accessed_at DESC`,
    user
      ? prisma.$queryRaw<LastRow[]>`
          SELECT DISTINCT ON (${column}) ${column} AS id, accessed_at, user_id, user_uuid
          FROM room_accesses
          WHERE ${column} IN (${idList})
            AND (user_id = ${user.id}${user.uuid ? Prisma.sql` OR user_uuid = ${user.uuid}` : Prisma.empty})
          ORDER BY ${column}, accessed_at DESC`
      : Promise.resolve([] as LastRow[]),
  ]);

  const result: Record<string, ActivitySummary> = {};
  for (const id of unique) {
    result[id] = { totalAccesses: 0, peakTimes: [], lastVisitedByUser: null, lastVisitedOverall: null, youWereLast: false };
  }
  for (const row of totals) {
    const id = row[field];
    if (typeof id === 'string' && result[id]) result[id].totalAccesses = row._count._all;
  }
  for (const row of hours) {
    result[row.id]?.peakTimes.push({ hour: Number(row.hour), count: Number(row.count) });
  }
  for (const summary of Object.values(result)) {
    // Busiest first, as utcHourBuckets orders them.
    summary.peakTimes.sort((a, b) => b.count - a.count || a.hour - b.hour);
  }
  for (const row of latest) {
    const summary = result[row.id];
    if (!summary) continue;
    summary.lastVisitedOverall = { accessedAt: row.accessed_at };
    // Decided by identity here, so the answer never needs to say who the latest visitor was.
    summary.youWereLast = viewerWasLast(viewer, { userId: row.user_id, userUuid: row.user_uuid });
  }
  for (const row of yours) {
    const summary = result[row.id];
    if (summary) summary.lastVisitedByUser = { accessedAt: row.accessed_at, userId: row.user_id, userUuid: row.user_uuid };
  }
  return result;
}
