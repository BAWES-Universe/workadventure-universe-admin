import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { EVERYONE_KEY, MEMBER_KEY } from '@/lib/roles';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { withWokas } from '@/lib/woka-avatar';
import { failed, managesPeople, memberForJson, memberInclude, seesHiddenRoles, universeContext } from '@/lib/universe-route';

const PAGE = 50;

// GET /api/admin/universes/[id]/members?q=&roleId=&worldId=&cursor= - Everyone who joined the universe, newest first.
// `worldId` keeps the people whose membership or a role reaches that world.
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
      ...(hiddenFilter ? { id: { in: [] } } : {}),
    };

    const [total, rows, owner, ownerMember, created] = await Promise.all([
      prisma.universeMember.count({ where }),
      prisma.universeMember.findMany({
        where,
        include: memberInclude,
        // `order=roles` is the row of faces: people with roles come first, so the highest ranks are among them
        orderBy: [...(request.nextUrl.searchParams.get('order') === 'roles' ? [{ roles: { _count: 'desc' as const } }] : []), { joinedAt: 'desc' }, { id: 'desc' }],
        take: PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      prisma.user.findUnique({ where: { id: universe.ownerId }, select: { id: true, name: true, email: true } }),
      prisma.universeMember.findUnique({
        where: { universeId_userId: { universeId: id, userId: universe.ownerId } },
        select: { joinedAt: true },
      }),
      prisma.universe.findUnique({ where: { id }, select: { createdAt: true } }),
    ]);
    const page = rows.slice(0, PAGE);
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
      nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    });
  } catch (error) {
    return failed(error, 'list members');
  }
}
