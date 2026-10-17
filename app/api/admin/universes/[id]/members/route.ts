import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { EVERYONE_KEY, MEMBER_KEY } from '@/lib/roles';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { withWokas } from '@/lib/woka-avatar';
import { failed, managesPeople, memberForJson, memberInclude, universeContext } from '@/lib/universe-route';

const PAGE = 50;

// GET /api/admin/universes/[id]/members?q=&roleId=&cursor= - Everyone who joined the universe, newest first
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe } = context;

    // Emails are for the people who invite, remove or give roles; everyone who can see the universe sees its members
    const showEmail = managesPeople(access);

    const search = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? '';
    // Member and Everyone come with joining and are never given, so filtering by them means everyone who joined
    const roleParam = request.nextUrl.searchParams.get('roleId');
    const filterRole = roleParam
      ? await prisma.role.findFirst({ where: { id: roleParam, universeId: id }, select: { id: true, key: true } })
      : null;
    const roleId = filterRole && (filterRole.key === MEMBER_KEY || filterRole.key === EVERYONE_KEY) ? null : roleParam;
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
    };

    const [total, rows, owner] = await Promise.all([
      prisma.universeMember.count({ where }),
      prisma.universeMember.findMany({
        where,
        include: memberInclude,
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        take: PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      prisma.user.findUnique({ where: { id: universe.ownerId }, select: { id: true, name: true } }),
    ]);
    const page = rows.slice(0, PAGE);
    const members = page.map((member) => memberForJson(member, universe.ownerId, showEmail));

    return NextResponse.json({
      members: await withWokas(members),
      total,
      // The owner has everything whether or not they joined, so the screens show them first
      owner: owner ? { userId: owner.id, name: owner.name } : null,
      nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    });
  } catch (error) {
    return failed(error, 'list members');
  }
}
