import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { HourBucket } from '@/lib/analytics-peak';

// Whitelisted: the only identifiers ever put into SQL.
const SCOPE_COLUMN = {
  room: Prisma.raw('room_id'),
  world: Prisma.raw('world_id'),
  universe: Prisma.raw('universe_id'),
} as const;

/**
 * Every access to a room, world or universe counted by UTC hour in the database, busiest first: at most 24 rows,
 * however long its history (never every access row). Same order as utcHourBuckets.
 */
export async function utcHourBucketsFor(scope: keyof typeof SCOPE_COLUMN, id: string): Promise<HourBucket[]> {
  const rows = await prisma.$queryRaw<Array<{ hour: number; count: number }>>`
    SELECT EXTRACT(HOUR FROM accessed_at)::int AS hour, COUNT(*)::int AS count
    FROM room_accesses
    WHERE ${SCOPE_COLUMN[scope]} = ${id}
    GROUP BY 1`;
  return rows
    .map((row) => ({ hour: Number(row.hour), count: Number(row.count) }))
    .sort((a, b) => b.count - a.count || a.hour - b.hour);
}
