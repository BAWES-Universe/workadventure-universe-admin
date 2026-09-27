import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth-session';
import { canSeeRoom } from '@/lib/room-visibility';

const ROOM_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  mapUrl: true,
  isPublic: true,
  world: {
    select: {
      id: true,
      name: true,
      slug: true,
      isPublic: true,
      universe: { select: { id: true, name: true, slug: true, isPublic: true, ownerId: true } },
    },
  },
  _count: { select: { favorites: true } },
} as const;

type RecentRoomRecord = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  mapUrl: string | null;
  isPublic: boolean;
  world: {
    id: string;
    name: string;
    slug: string;
    isPublic: boolean;
    universe: { id: string; name: string; slug: string; isPublic: boolean; ownerId: string };
  };
  _count?: { favorites?: number };
};

function isStartRoom(room: RecentRoomRecord): boolean {
  return room.world.universe.slug === 'default' && room.world.slug === 'default' && room.slug === 'default';
}

/**
 * GET /api/admin/rooms/recent - the rooms this person visited most recently, newest first, one entry per room.
 *
 * Personal and access-filtered: only the caller's own visits, and only rooms they may still see. With the admin
 * token (the game, not a person) it is the most recent visits across everyone, as before.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const isAdminToken =
      authHeader?.startsWith('Bearer ') && authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;

    let viewer: SessionUser | null = null;
    if (isAdminToken) {
      requireAuth(request);
    } else {
      viewer = await getSessionUser(request);
      if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(20, Math.max(1, parseInt(searchParams.get('limit') || '2', 10) || 2));
    const excludeRoomId = searchParams.get('excludeRoomId');

    const [accesses, memberships] = await Promise.all([
      prisma.roomAccess.findMany({
        where: viewer ? { OR: [{ userId: viewer.id }, { userUuid: viewer.uuid }] } : {},
        select: { accessedAt: true, room: { select: ROOM_SELECT } },
        orderBy: { accessedAt: 'desc' },
        take: 60,
      }),
      viewer
        ? prisma.worldMember.findMany({ where: { userId: viewer.id }, select: { worldId: true } })
        : Promise.resolve([] as { worldId: string }[]),
    ]);
    const memberWorldIds = new Set(memberships.map((membership) => membership.worldId));

    const seen = new Set<string>();
    const recent: {
      roomId: string;
      roomName: string;
      roomSlug: string;
      roomDescription: string | null;
      roomMapUrl: string | null;
      roomFavorites: number;
      worldId: string;
      worldName: string;
      worldSlug: string;
      universeId: string;
      universeName: string;
      universeSlug: string;
      accessedAt: Date;
    }[] = [];

    for (const access of accesses) {
      const room = access.room as RecentRoomRecord | null;
      if (!room) continue;
      if (isStartRoom(room)) continue;
      if (excludeRoomId && room.id === excludeRoomId) continue;
      if (seen.has(room.id)) continue;
      if (!isAdminToken && !canSeeRoom(room, viewer, memberWorldIds)) continue;
      seen.add(room.id);

      recent.push({
        roomId: room.id,
        roomName: room.name,
        roomSlug: room.slug,
        roomDescription: room.description,
        roomMapUrl: room.mapUrl,
        roomFavorites: room._count?.favorites ?? 0,
        worldId: room.world.id,
        worldName: room.world.name,
        worldSlug: room.world.slug,
        universeId: room.world.universe.id,
        universeName: room.world.universe.name,
        universeSlug: room.world.universe.slug,
        accessedAt: access.accessedAt,
      });
      if (recent.length >= limit) break;
    }

    return NextResponse.json({ rooms: recent });
  } catch (error) {
    console.error('Error fetching recent rooms:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
