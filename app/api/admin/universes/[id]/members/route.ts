import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { withWokas } from '@/lib/woka-avatar';
import { failed, managesPeople, memberForJson, memberInclude, universeContext } from '@/lib/universe-route';

const PAGE = 50;

// GET /api/admin/universes/[id]/members?q=&roleId=&worldId=&cursor= - Everyone who joined the universe, newest first.
// `worldId` keeps the people whose membership or a role reaches that world.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe } = context;

    // Emails are for the people who invite, remove or give roles; everyone who can see the universe sees its members
    const showEmail = managesPeople(access);

    const search = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? '';
    const roleId = request.nextUrl.searchParams.get('roleId');
    const worldId = request.nextUrl.searchParams.get('worldId');
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
    const members = page.map((member) => memberForJson(member, universe.ownerId, showEmail));
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
            email: showEmail ? owner.email : null,
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
