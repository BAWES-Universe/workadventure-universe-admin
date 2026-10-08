import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeWorld } from '@/lib/room-visibility';

// POST /api/admin/worlds/[id]/favorite
// Toggle the current user's star on a world itself (its rooms' stars are separate, and untouched).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSession(request);
    const { id } = await params;

    const world = await prisma.world.findUnique({
      where: { id },
      select: { id: true, isPublic: true, universeId: true, universe: { select: { isPublic: true, ownerId: true } } },
    });
    // A world you can't see doesn't exist for you, so it can't be starred.
    const memberWorldIds = world ? await memberWorldIdsOf(user.id, [world.id]) : new Set<string>();
    if (!world || !canSeeWorld(world, user, memberWorldIds)) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // Stars on the place itself have no room.
    const existing = await prisma.favorite.findFirst({ where: { userId: user.id, worldId: id, roomId: null } });
    let isStarred: boolean;
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      isStarred = false;
    } else {
      await prisma.favorite.create({ data: { userId: user.id, worldId: id, universeId: world.universeId } });
      isStarred = true;
    }
    const starCount = await prisma.favorite.count({ where: { worldId: id, roomId: null } });
    return NextResponse.json({ isStarred, starCount });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error toggling world star:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
