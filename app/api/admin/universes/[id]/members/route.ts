import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { EVERYONE_KEY, MEMBER_KEY } from '@/lib/roles';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { withWokas } from '@/lib/woka-avatar';
import { failed, managesPeople, memberForJson, memberInclude, seesHiddenRoles, universeContext } from '@/lib/universe-route';

const PAGE = 50;

/** Where a page of the ranked list stops: the last row's rank, when they joined, and their id. */
type RankCursor = { r: number; j: string; i: string };
function readCursor(value: string | null): RankCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.r === 'number' && typeof parsed.i === 'string' && typeof parsed.j === 'string' && !Number.isNaN(Date.parse(parsed.j))) return parsed;
  } catch {
    // A cursor that isn't ours starts from the top
  }
  return null;
}
const writeCursor = (cursor: RankCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

// GET /api/admin/universes/[id]/members?q=&roleId=&withoutRoleId=&worldId=&cursor= - Everyone who joined the universe, newest
// first. `worldId` keeps the people whose membership or a role reaches that world; `withoutRoleId` leaves out who has that role.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    // Emails are for the people who invite, remove or give roles; everyone who can see the universe sees its members
    const showEmail = managesPeople(access);
    const showHidden = seesHiddenRoles(access);

    const search = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? '';
    const worldId = request.nextUrl.searchParams.get('worldId');
    // Member and Everyone come with joining and are never given, so filtering by them means everyone who joined
    const roleParam = request.nextUrl.searchParams.get('roleId');
    const filterRole = roleParam
      ? await prisma.role.findFirst({ where: { id: roleParam, universeId: id }, select: { id: true, key: true, showBadge: true } })
      : null;
    const roleId = filterRole && (filterRole.key === MEMBER_KEY || filterRole.key === EVERYONE_KEY) ? null : roleParam;
    // A role whose badge is hidden doesn't say who has it, not even through the filter
    const hiddenFilter = !!filterRole && !filterRole.showBadge && !showHidden;
    // Who doesn't have a role yet, for giving it. Only for a role the viewer may see the holders of: the gaps would name them
    const withoutParam = request.nextUrl.searchParams.get('withoutRoleId');
    const withoutRole = withoutParam
      ? await prisma.role.findFirst({ where: { id: withoutParam, universeId: id }, select: { id: true, key: true, showBadge: true } })
      : null;
    const withoutRoleId =
      withoutRole && withoutRole.key !== MEMBER_KEY && withoutRole.key !== EVERYONE_KEY && (withoutRole.showBadge || showHidden) ? withoutRole.id : null;
    const cursor = request.nextUrl.searchParams.get('cursor');
    const where: Prisma.UniverseMemberWhereInput = {
      universeId: id,
      user: {
        AND: [
          NOT_SYSTEM_USER,
          ...(search
            ? [
                {
                  OR: [
                    { name: { contains: search, mode: 'insensitive' as const } },
                    ...(showEmail ? [{ email: { contains: search, mode: 'insensitive' as const } }] : []),
                  ],
                },
              ]
            : []),
        ],
      },
      ...(roleId ? { roles: { some: { roleId } } } : {}),
      ...(worldId
        ? {
            OR: [
              { allWorlds: true },
              { worldIds: { has: worldId } },
              { roles: { some: { OR: [{ allWorlds: true }, { worldIds: { has: worldId } }] } } },
            ],
          }
        : {}),
      ...(withoutRoleId ? { AND: [{ roles: { none: { roleId: withoutRoleId } } }] } : {}),
      ...(hiddenFilter ? { id: { in: [] } } : {}),
    };

    const ranked = request.nextUrl.searchParams.get('order') === 'roles';
    const [ownerAndDates, listed] = await Promise.all([
      Promise.all([
        prisma.user.findUnique({ where: { id: universe.ownerId }, select: { id: true, name: true, email: true } }),
        prisma.universeMember.findUnique({
          where: { universeId_userId: { universeId: id, userId: universe.ownerId } },
          select: { joinedAt: true },
        }),
        prisma.universe.findUnique({ where: { id }, select: { createdAt: true } }),
      ]),
      ranked ? listByRank(where, showHidden, user.id, readCursor(cursor)) : listNewest(where, cursor),
    ]);
    const [owner, ownerMember, created] = ownerAndDates;
    const { total, rows, nextCursor } = listed;
    const page = rows;
    const members = page.map((member) => {
      // Everyone sees their own email and roles
      const self = member.userId === user.id;
      return memberForJson(member, universe.ownerId, showEmail || self, showHidden || self);
    });
    const [ownerWithWoka] = owner ? await withWokas([{ userId: owner.id }]) : [];

    return NextResponse.json({
      members: await withWokas(members),
      total,
      // The owner has everything whether or not they joined, so the screens show them first. `joined` says whether
      // they are also among `members` (and `total`).
      owner: owner
        ? {
            userId: owner.id,
            name: owner.name,
            email: showEmail || owner.id === user.id ? owner.email : null,
            woka: ownerWithWoka?.woka ?? [],
            joinedAt: ownerMember?.joinedAt ?? created?.createdAt ?? null,
            joined: !!ownerMember,
          }
        : null,
      nextCursor,
    });
  } catch (error) {
    return failed(error, 'list members');
  }
}

/** The default order: newest first. */
async function listNewest(where: Prisma.UniverseMemberWhereInput, cursor: string | null) {
  const [total, rows] = await Promise.all([
    prisma.universeMember.count({ where }),
    prisma.universeMember.findMany({
      where,
      include: memberInclude,
      orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  ]);
  const page = rows.slice(0, PAGE);
  return { total, rows: page, nextCursor: rows.length > PAGE ? page[page.length - 1].id : null };
}

/**
 * Highest role first (`order=roles`, the Members page and the row of faces): by the position of each person's highest
 * role, then newest, then id, paged with a keyset cursor on those three so a page never skips or repeats anyone.
 * Someone with no role beyond Member ranks 1. A role whose badge is hidden doesn't lift anyone's rank for a viewer who
 * can't see it (their own rank always counts for them), or the order would say who holds it.
 */
async function listByRank(where: Prisma.UniverseMemberWhereInput, showHidden: boolean, viewerId: string, after: RankCursor | null) {
  const matching = await prisma.universeMember.findMany({ where, select: { id: true } });
  const ids = matching.map((member) => member.id);
  if (ids.length === 0) return { total: 0, rows: [], nextCursor: null };
  const keyset = after
    ? Prisma.sql`WHERE (ranked.rank, ranked.joined_at, ranked.id) < (${after.r}::int, ${after.j}::timestamp, ${after.i}::text)`
    : Prisma.empty;
  const order = await prisma.$queryRaw<{ id: string; rank: number; joined_at: Date }[]>(Prisma.sql`
    SELECT ranked.id, ranked.rank, ranked.joined_at
    FROM (
      SELECT m.id, m.joined_at,
        GREATEST(1, COALESCE((
          SELECT MAX(r.position)
          FROM universe_member_roles given
          JOIN roles r ON r.id = given.role_id
          WHERE given.member_id = m.id AND (r.show_badge OR ${showHidden} OR m.user_id = ${viewerId})
        ), 0))::int AS rank
      FROM universe_members m
      WHERE m.id = ANY(${ids}::text[])
    ) ranked
    ${keyset}
    ORDER BY ranked.rank DESC, ranked.joined_at DESC, ranked.id DESC
    LIMIT ${PAGE + 1}
  `);
  const pageOrder = order.slice(0, PAGE);
  const found = await prisma.universeMember.findMany({ where: { id: { in: pageOrder.map((row) => row.id) } }, include: memberInclude });
  const byId = new Map(found.map((member) => [member.id, member]));
  const rows = pageOrder.map((row) => byId.get(row.id)).filter((member): member is NonNullable<typeof member> => !!member);
  const last = pageOrder[pageOrder.length - 1];
  return {
    total: ids.length,
    rows,
    nextCursor: order.length > PAGE && last ? writeCursor({ r: Number(last.rank), j: last.joined_at.toISOString(), i: last.id }) : null,
  };
}
