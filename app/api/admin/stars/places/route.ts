import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canSeeUniverse, canSeeWorld } from '@/lib/room-visibility';
import { hiddenSystemOwnerId } from '@/lib/system-user';

// GET /api/admin/stars/places
// The universes and worlds the current user starred themselves (stars on rooms are /api/admin/stars/rooms), newest first,
// each with its star count. Ones that are no longer visible to them are left out.
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession(request);
    const hidden = await hiddenSystemOwnerId();

    const [favorites, memberships] = await Promise.all([
      prisma.favorite.findMany({
        where: { userId: user.id, roomId: null },
        orderBy: { favoritedAt: 'desc' },
        include: {
          universe: {
            select: { id: true, slug: true, name: true, description: true, isPublic: true, ownerId: true, owner: { select: { name: true } } },
          },
          world: {
            select: {
              id: true,
              slug: true,
              name: true,
              description: true,
              isPublic: true,
              universe: { select: { id: true, slug: true, name: true, isPublic: true, ownerId: true } },
            },
          },
        },
      }),
      prisma.worldMember.findMany({ where: { userId: user.id }, select: { worldId: true, world: { select: { universeId: true } } } }),
    ]);
    const memberWorldIds = new Set(memberships.map((membership) => membership.worldId));
    const memberUniverseIds = new Set(memberships.map((membership) => membership.world.universeId));

    const universeFavorites = favorites.filter((favorite) => favorite.worldId === null && favorite.universe);
    const worldFavorites = favorites.filter((favorite) => favorite.worldId !== null && favorite.world);

    const [universeCounts, worldCounts] = await Promise.all([
      universeFavorites.length > 0
        ? prisma.favorite.groupBy({
            by: ['universeId'],
            where: { universeId: { in: universeFavorites.map((favorite) => favorite.universeId!) }, worldId: null, roomId: null },
            _count: { id: true },
          })
        : [],
      worldFavorites.length > 0
        ? prisma.favorite.groupBy({
            by: ['worldId'],
            where: { worldId: { in: worldFavorites.map((favorite) => favorite.worldId!) }, roomId: null },
            _count: { id: true },
          })
        : [],
    ]);
    const universeCountMap = new Map(universeCounts.map((row) => [row.universeId!, row._count.id]));
    const worldCountMap = new Map(worldCounts.map((row) => [row.worldId!, row._count.id]));

    const universes = universeFavorites
      .filter((favorite) => canSeeUniverse(favorite.universe!, user, memberUniverseIds.has(favorite.universe!.id)))
      .filter((favorite) => !hidden || favorite.universe!.ownerId !== hidden)
      .map((favorite) => ({
        id: favorite.universe!.id,
        slug: favorite.universe!.slug,
        name: favorite.universe!.name,
        description: favorite.universe!.description,
        ownerName: favorite.universe!.owner?.name ?? null,
        isStarred: true,
        starCount: universeCountMap.get(favorite.universe!.id) || 0,
        favoritedAt: favorite.favoritedAt,
      }));

    const worlds = worldFavorites
      .filter((favorite) => canSeeWorld(favorite.world!, user, memberWorldIds))
      .filter((favorite) => !hidden || favorite.world!.universe.ownerId !== hidden)
      .map((favorite) => ({
        id: favorite.world!.id,
        slug: favorite.world!.slug,
        name: favorite.world!.name,
        description: favorite.world!.description,
        universe: { id: favorite.world!.universe.id, slug: favorite.world!.universe.slug, name: favorite.world!.universe.name },
        isStarred: true,
        starCount: worldCountMap.get(favorite.world!.id) || 0,
        favoritedAt: favorite.favoritedAt,
      }));

    return NextResponse.json({ universes, worlds });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching starred places:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
