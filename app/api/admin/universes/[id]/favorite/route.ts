import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeUniverse } from '@/lib/room-visibility';

// POST /api/admin/universes/[id]/favorite
// Toggle the current user's star on a universe itself (its rooms' stars are separate, and untouched).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSession(request);
    const { id } = await params;

    const universe = await prisma.universe.findUnique({
      where: { id },
      select: { id: true, isPublic: true, ownerId: true, worlds: { select: { id: true } } },
    });
    const memberWorldIds = universe ? await memberWorldIdsOf(user.id, universe.worlds.map((world) => world.id)) : new Set<string>();
    if (!universe || !canSeeUniverse(universe, user, memberWorldIds.size > 0)) {
      return NextResponse.json({ error: 'Universe not found' }, { status: 404 });
    }

    // Stars on the place itself have no world and no room.
    const existing = await prisma.favorite.findFirst({ where: { userId: user.id, universeId: id, worldId: null, roomId: null } });
    let isStarred: boolean;
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      isStarred = false;
    } else {
      await prisma.favorite.create({ data: { userId: user.id, universeId: id } });
      isStarred = true;
    }
    const starCount = await prisma.favorite.count({ where: { universeId: id, worldId: null, roomId: null } });
    return NextResponse.json({ isStarred, starCount });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error toggling universe star:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
