import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getViewer, isPrivileged, unauthorizedResponse } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import { wokaLayersForMany } from '@/lib/woka-avatar';
import { NOT_SYSTEM_USER, NOT_SYSTEM_USER_SQL } from '@/lib/system-user';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A positive integer from a query parameter, or the fallback when it is missing or not a number. */
function intParam(value: string | null, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Prisma's `contains` as an ILIKE pattern. Prisma does not escape `%` or `_` in the search text, so neither does this:
 * the page query must match exactly the rows `prisma.user.count` counts.
 */
function containsPattern(search: string): string {
  return `%${search}%`;
}

type PageRow = { id: string; last_accessed: Date | null; total_accesses: bigint | number };

// GET /api/admin/users - List all users
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) {
      return unauthorizedResponse();
    }
    // Email addresses are only visible to, and searchable by, privileged viewers.
    const canSeeEmail = isPrivileged(viewer);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, intParam(searchParams.get('page'), 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, intParam(searchParams.get('limit'), DEFAULT_LIMIT)));
    const search = searchParams.get('search') || '';
    // `guests=exclude` leaves guest accounts out before counting and paging, so totals and pages agree.
    const excludeGuests = searchParams.get('guests') === 'exclude';
    const offset = (page - 1) * limit;

    // The same filter twice: as a Prisma `where` (for the count) and as SQL (for the page, whose order depends on
    // access aggregates Prisma cannot sort by). Keep the two in step.
    const searchWhere: Prisma.UserWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            ...(canSeeEmail ? [{ email: { contains: search, mode: 'insensitive' as const } }] : []),
            { uuid: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    // The internal System account is nobody: it is left out of everyone's list, server-side.
    const visibleWhere: Prisma.UserWhereInput = { AND: [searchWhere, NOT_SYSTEM_USER] };
    const where: Prisma.UserWhereInput = excludeGuests ? { AND: [visibleWhere, { isGuest: false }] } : visibleWhere;

    const conditions: Prisma.Sql[] = [];
    if (search) {
      const pattern = containsPattern(search);
      const fields = [
        Prisma.sql`u.name ILIKE ${pattern}`,
        ...(canSeeEmail ? [Prisma.sql`u.email ILIKE ${pattern}`] : []),
        Prisma.sql`u.uuid ILIKE ${pattern}`,
      ];
      conditions.push(Prisma.sql`(${Prisma.join(fields, ' OR ')})`);
    }
    conditions.push(NOT_SYSTEM_USER_SQL);
    if (excludeGuests) {
      conditions.push(Prisma.sql`u.is_guest = false`);
    }
    const whereSql = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

    // One page of user ids, most recently seen first, then most accesses, then newest; id breaks remaining ties so
    // pages never overlap. An access counts towards a person by user id, or by uuid when it has no user id; their last
    // access is the latest one matching either. Aggregates are computed in the database, only for matching users.
    const [total, pageRows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.$queryRaw<PageRow[]>(Prisma.sql`
        WITH matched AS (
          SELECT u.id, u.uuid, u.created_at FROM users u ${whereSql}
        ),
        by_id AS (
          SELECT ra.user_id AS key, MAX(ra.accessed_at) AS last_at, COUNT(*) AS n
          FROM room_accesses ra
          WHERE ra.user_id IN (SELECT id FROM matched)
          GROUP BY ra.user_id
        ),
        by_uuid AS (
          SELECT ra.user_uuid AS key, MAX(ra.accessed_at) AS last_at, COUNT(*) FILTER (WHERE ra.user_id IS NULL) AS n
          FROM room_accesses ra
          WHERE ra.user_uuid IN (SELECT uuid FROM matched)
          GROUP BY ra.user_uuid
        )
        SELECT m.id,
               GREATEST(i.last_at, q.last_at) AS last_accessed,
               COALESCE(i.n, 0) + COALESCE(q.n, 0) AS total_accesses
        FROM matched m
        LEFT JOIN by_id i ON i.key = m.id
        LEFT JOIN by_uuid q ON q.key = m.uuid
        ORDER BY last_accessed DESC NULLS LAST, total_accesses DESC, m.created_at DESC, m.id ASC
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);

    const pagination = { page, limit, total, totalPages: Math.ceil(total / limit) };
    if (pageRows.length === 0) {
      return NextResponse.json({ users: [], pagination });
    }

    const pageIds = pageRows.map((row) => row.id);
    const [rows, wokas] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: pageIds } },
        select: {
          id: true,
          uuid: true,
          email: canSeeEmail,
          name: true,
          isGuest: true,
          createdAt: true,
          _count: {
            select: {
              ownedUniverses: true,
              worldMemberships: true,
            },
          },
        },
      }),
      // Each person's Woka, for their avatar (decoration: never costs the list).
      wokaLayersForMany(pageIds).catch(() => new Map<string, string[]>()),
    ]);

    const byId = new Map(rows.map((user) => [user.id, user]));
    const users = pageRows.flatMap((row) => {
      const user = byId.get(row.id);
      // A user deleted between the two queries is simply left off the page.
      if (!user) return [];
      return [
        {
          ...user,
          totalAccesses: Number(row.total_accesses),
          lastAccessed: row.last_accessed ? new Date(row.last_accessed).toISOString() : null,
          woka: wokas.get(user.id) ?? [],
        },
      ];
    });

    return NextResponse.json({ users, pagination });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching users:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
