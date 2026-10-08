import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth-session';
import { canSeeRoom } from '@/lib/room-visibility';
import { andNotSystemOwnedSql, hiddenSystemOwnerId } from '@/lib/system-user';

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

    const memberWorldIds = new Set(
      (viewer ? await prisma.worldMember.findMany({ where: { userId: viewer.id }, select: { worldId: true } }) : []).map(
        (membership) => membership.worldId,
      ),
    );

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

    // Each room's latest visit, newest first, with everything the list leaves out filtered in the database before
    // the limit applies: the start map, System's rooms once they are hidden, the excluded room and, for a person,
    // rooms they may no longer see (the same rule as canSeeRoom). So the limit always counts rooms that will be
    // shown, however many were hidden before them.
    const hidden = await hiddenSystemOwnerId();
    const whose = viewer
      ? Prisma.sql`AND (ra.user_id = ${viewer.id}${viewer.uuid ? Prisma.sql` OR ra.user_uuid = ${viewer.uuid}` : Prisma.empty})`
      : Prisma.empty;
    const visible =
      viewer && !viewer.isSuperAdmin
        ? Prisma.sql`AND (
            (r.is_public AND w.is_public AND u.is_public)
            OR u.owner_id = ${viewer.id}
            OR EXISTS (SELECT 1 FROM world_members wm WHERE wm.world_id = w.id AND wm.user_id = ${viewer.id})
          )`
        : Prisma.empty;
    const latest = await prisma.$queryRaw<Array<{ room_id: string; last_at: Date }>>`
      SELECT ra.room_id, MAX(ra.accessed_at) AS last_at
      FROM room_accesses ra
      JOIN rooms r ON r.id = ra.room_id
      JOIN worlds w ON w.id = r.world_id
      JOIN universes u ON u.id = w.universe_id
      WHERE NOT (u.slug = 'default' AND w.slug = 'default' AND r.slug = 'default')
        ${andNotSystemOwnedSql(hidden)}
        ${excludeRoomId ? Prisma.sql`AND r.id <> ${excludeRoomId}` : Prisma.empty}
        ${whose}
        ${visible}
      GROUP BY ra.room_id
      ORDER BY last_at DESC, ra.room_id
      LIMIT ${limit}`;

    const records = latest.length
      ? await prisma.room.findMany({ where: { id: { in: latest.map((row) => row.room_id) } }, select: ROOM_SELECT })
      : [];
    const byId = new Map(records.map((record) => [record.id, record as RecentRoomRecord]));

    for (const row of latest) {
      const room = byId.get(row.room_id);
      if (!room) continue;
      // The query applied these already; kept as a guard should the two ever drift apart.
      if (isStartRoom(room) || (hidden && room.world.universe.ownerId === hidden)) continue;
      if (excludeRoomId && room.id === excludeRoomId) continue;
      if (!isAdminToken && !canSeeRoom(room, viewer, memberWorldIds)) continue;
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
        accessedAt: new Date(row.last_at),
      });
    }

    return NextResponse.json({ rooms: recent });
  } catch (error) {
    console.error('Error fetching recent rooms:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
