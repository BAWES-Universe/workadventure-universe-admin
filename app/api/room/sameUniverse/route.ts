import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri, buildPlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import { isSuperAdmin } from '@/lib/super-admin';
import { memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeRoom } from '@/lib/room-visibility';
import type { SessionUser } from '@/lib/auth-session';

export interface UniverseRoomDescription {
  name: string;
  roomUrl: string;
  description?: string;
  stars: number;
  visits: number;
  /** The busiest UTC hour of the day (0-23) over every visit, or absent when nobody has visited. */
  peakHourUtc?: number;
  isCurrent: boolean;
}

export interface UniverseWorldDescription {
  name: string;
  slug: string;
  thumbnailUrl?: string;
  isCurrent: boolean;
  rooms: UniverseRoomDescription[];
}

export interface UniverseRoomsResponse {
  universeName: string;
  worlds: UniverseWorldDescription[];
}

/**
 * GET /api/room/sameUniverse
 *
 * Every room the player may see in the universe of `roomUrl`, grouped by world, for the game's "Explore" list.
 * The current world comes first, then the others by total visits. Within a world the current room comes first, then
 * the others by visits (most first). Each room carries its star count, visit count and busiest UTC hour.
 *
 * Visibility follows canSeeRoom for the player named by `userUuid` (owner, world member, super admin, or public).
 * The current world's public rooms are always listed, as /api/room/sameWorld does.
 *
 * Query Parameters:
 * - roomUrl (required): the room the player is in, "https://play.example/@/universe/world/room"
 * - userUuid (optional): the player's WorkAdventure uuid
 */
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);

    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const userUuid = searchParams.get('userUuid');

    if (!roomUrl) {
      return NextResponse.json({ error: 'roomUrl is required' }, { status: 400 });
    }

    let slugs: ReturnType<typeof parsePlayUri>;
    try {
      slugs = parsePlayUri(roomUrl);
    } catch {
      return NextResponse.json({ error: 'roomUrl must look like /@/universe/world/room' }, { status: 400 });
    }
    const baseUrl = new URL(roomUrl).origin;

    const universe = await prisma.universe.findUnique({
      where: { slug: slugs.universe },
      select: {
        id: true,
        name: true,
        isPublic: true,
        ownerId: true,
        worlds: {
          select: {
            id: true,
            name: true,
            slug: true,
            isPublic: true,
            thumbnailUrl: true,
            rooms: { select: { id: true, name: true, slug: true, description: true, isPublic: true } },
          },
        },
      },
    });

    if (!universe) {
      return NextResponse.json({ error: 'Universe not found' }, { status: 404 });
    }

    const viewer = await viewerFor(userUuid);
    const memberWorldIds = viewer
      ? await memberWorldIdsOf(
          viewer.id,
          universe.worlds.map((world) => world.id),
        )
      : new Set<string>();
    const universeRecord = { isPublic: universe.isPublic, ownerId: universe.ownerId };

    const worlds = universe.worlds
      .map((world) => {
        const isCurrentWorld = world.slug === slugs.world;
        const worldRecord = { id: world.id, isPublic: world.isPublic, universe: universeRecord };
        const rooms = world.rooms.filter(
          (room) =>
            (isCurrentWorld && room.isPublic) ||
            canSeeRoom({ isPublic: room.isPublic, world: worldRecord }, viewer, memberWorldIds),
        );
        return { world, isCurrentWorld, rooms };
      })
      .filter(({ rooms }) => rooms.length > 0);

    const roomIds = worlds.flatMap(({ rooms }) => rooms.map((room) => room.id));
    const [activity, stars] = await Promise.all([roomActivity(universe.id, roomIds), roomStars(roomIds)]);

    const response: UniverseRoomsResponse = {
      universeName: universe.name,
      worlds: worlds
        .map(({ world, isCurrentWorld, rooms }) => ({
          name: world.name,
          slug: world.slug,
          ...(world.thumbnailUrl ? { thumbnailUrl: world.thumbnailUrl } : {}),
          isCurrent: isCurrentWorld,
          rooms: rooms
            .map((room): UniverseRoomDescription => {
              const roomActivity = activity.get(room.id);
              return {
                name: room.name,
                roomUrl: buildPlayUri(baseUrl, slugs.universe, world.slug, room.slug),
                ...(room.description ? { description: room.description } : {}),
                stars: stars.get(room.id) ?? 0,
                visits: roomActivity?.visits ?? 0,
                ...(roomActivity ? { peakHourUtc: roomActivity.peakHourUtc } : {}),
                isCurrent: isCurrentWorld && room.slug === slugs.room,
              };
            })
            .sort(currentThenMostVisited),
        }))
        .sort((a, b) => {
          if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
          return totalVisits(b) - totalVisits(a) || a.name.localeCompare(b.name);
        }),
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('Error in /api/room/sameUniverse:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** The player as canSeeRoom needs them, or null for a guest or an unknown uuid. */
async function viewerFor(userUuid: string | null): Promise<SessionUser | null> {
  if (!userUuid) return null;
  const user = await prisma.user.findUnique({
    where: { uuid: userUuid },
    select: { id: true, uuid: true, email: true, name: true, isGuest: true },
  });
  if (!user || user.isGuest) return null;
  const { id, uuid, email, name } = user;
  return { id, uuid, email, name, tags: [], isSuperAdmin: isSuperAdmin(email) };
}

/**
 * Every visit to the given (visible) rooms counted by room and UTC hour in the database (at most 24 rows per room), folded
 * into each room's total and busiest hour. Ties go to the earlier hour, as in utcHourBuckets.
 */
async function roomActivity(
  universeId: string,
  roomIds: string[],
): Promise<Map<string, { visits: number; peakHourUtc: number }>> {
  if (roomIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ room_id: string; hour: number; count: bigint | number }>>(Prisma.sql`
    SELECT room_id, EXTRACT(HOUR FROM accessed_at)::int AS hour, COUNT(*) AS count
    FROM room_accesses
    WHERE universe_id = ${universeId}
      AND room_id IN (${Prisma.join(roomIds)})
    GROUP BY 1, 2`);

  const byRoom = new Map<string, { visits: number; peakHourUtc: number; peakCount: number }>();
  for (const row of rows) {
    const hour = Number(row.hour);
    const count = Number(row.count);
    const room = byRoom.get(row.room_id);
    if (!room) {
      byRoom.set(row.room_id, { visits: count, peakHourUtc: hour, peakCount: count });
      continue;
    }
    room.visits += count;
    if (count > room.peakCount || (count === room.peakCount && hour < room.peakHourUtc)) {
      room.peakHourUtc = hour;
      room.peakCount = count;
    }
  }
  return new Map(Array.from(byRoom, ([id, { visits, peakHourUtc }]) => [id, { visits, peakHourUtc }]));
}

async function roomStars(roomIds: string[]): Promise<Map<string, number>> {
  if (roomIds.length === 0) return new Map();
  const rows = await prisma.favorite.groupBy({
    by: ['roomId'],
    where: { roomId: { in: roomIds } },
    _count: { _all: true },
  });
  return new Map(rows.filter((row) => row.roomId).map((row) => [row.roomId as string, row._count._all]));
}

function currentThenMostVisited(a: UniverseRoomDescription, b: UniverseRoomDescription): number {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  return b.visits - a.visits || a.name.localeCompare(b.name);
}

function totalVisits(world: { rooms: UniverseRoomDescription[] }): number {
  return world.rooms.reduce((sum, room) => sum + room.visits, 0);
}
