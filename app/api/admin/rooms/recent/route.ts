import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { Prisma } from '@prisma/client';
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

/** Rooms read per step, and at most this many steps (plenty for a limit of 20, bounded if most are hidden). */
const PAGE_SIZE = 20;
const MAX_PAGES = 5;

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

    // Each room's latest visit, newest first, chosen in the database before the limit applies; pages on when rooms
    // the person may no longer see (or the start map, or the excluded room) are left out.
    const whose = viewer
      ? Prisma.sql`WHERE (user_id = ${viewer.id}${viewer.uuid ? Prisma.sql` OR user_uuid = ${viewer.uuid}` : Prisma.empty})`
      : Prisma.empty;
    for (let page = 0; page < MAX_PAGES && recent.length < limit; page += 1) {
      const latest = await prisma.$queryRaw<Array<{ room_id: string; last_at: Date }>>`
        SELECT room_id, MAX(accessed_at) AS last_at
        FROM room_accesses
        ${whose}
        GROUP BY room_id
        ORDER BY last_at DESC, room_id
        LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`;
      if (latest.length === 0) break;
      const records = await prisma.room.findMany({
        where: { id: { in: latest.map((row) => row.room_id) } },
        select: ROOM_SELECT,
      });
      const byId = new Map(records.map((record) => [record.id, record as RecentRoomRecord]));

      for (const row of latest) {
        const room = byId.get(row.room_id);
        if (!room) continue;
        if (isStartRoom(room)) continue;
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
        if (recent.length >= limit) break;
      }
      if (latest.length < PAGE_SIZE) break;
    }

    return NextResponse.json({ rooms: recent });
  } catch (error) {
    console.error('Error fetching recent rooms:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
