import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId } from '@/lib/system-user';

export const dynamic = 'force-dynamic';

// GET /api/memberships/my/universes - The universes you belong to and the roles you hold in each (Your memberships).
// A universe you own is listed even when you never joined it: the owner has everything everywhere.
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Never System's universes once they are hidden
    const hidden = await hiddenSystemOwnerId();
    const notHidden = hidden ? { ownerId: { not: hidden } } : {};
    const universeSelect = {
      id: true,
      name: true,
      ownerId: true,
      createdAt: true,
      worlds: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' as const } },
    };

    const [joined, owned] = await Promise.all([
      prisma.universeMember.findMany({
        where: { userId: sessionUser.id, universe: notHidden },
        include: {
          universe: { select: universeSelect },
          roles: { include: { role: { select: { key: true, name: true, color: true, position: true } } } },
        },
        orderBy: { joinedAt: 'desc' },
      }),
      prisma.universe.findMany({ where: { ownerId: sessionUser.id, ...notHidden }, select: universeSelect, orderBy: { createdAt: 'desc' } }),
    ]);

    const everywhere = { allWorlds: true, worldIds: [] as string[] };
    const memberships = joined.map((member) => ({
      universe: { id: member.universe.id, name: member.universe.name, worlds: member.universe.worlds },
      isOwner: member.universe.ownerId === sessionUser.id,
      joinedAt: member.joinedAt,
      worlds: { allWorlds: member.allWorlds, worldIds: member.worldIds },
      roles: [...member.roles]
        .sort((a, b) => b.role.position - a.role.position)
        .map((given) => ({
          key: given.role.key,
          name: given.role.name,
          color: given.role.color,
          allWorlds: given.allWorlds,
          worldIds: given.worldIds,
        })),
    }));
    const joinedIds = new Set(memberships.map((membership) => membership.universe.id));
    for (const universe of owned) {
      if (joinedIds.has(universe.id)) continue;
      memberships.push({
        universe: { id: universe.id, name: universe.name, worlds: universe.worlds },
        isOwner: true,
        joinedAt: universe.createdAt,
        worlds: everywhere,
        roles: [],
      });
    }

    return NextResponse.json({ universes: memberships });
  } catch (error) {
    console.error('Error fetching universe memberships:', error);
    return NextResponse.json({ error: 'Failed to fetch memberships' }, { status: 500 });
  }
}
