import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getViewer, memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeRoom } from '@/lib/room-visibility';
import { questsProofEnabled } from '@/lib/quests/flag';
import { readRoomAreas } from '@/lib/quests/room-areas';

const MAX_BOTS = 50;

/**
 * GET /api/admin/rooms/[id]/quest-context
 *
 * What an owner can point a quest at in this room: its named areas (from the room's map) and its bots. Only for the
 * people who can edit the room, with the same rule as the room's own page. Read only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!questsProofEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const viewer = await getViewer(request);
    if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const isAdminToken = viewer.kind === 'admin-token';
    const sessionUser = viewer.kind === 'user' ? viewer.user : null;

    const { id } = await params;
    const room = await prisma.room.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        isPublic: true,
        worldId: true,
        world: {
          select: {
            id: true,
            slug: true,
            isPublic: true,
            universe: { select: { slug: true, ownerId: true, isPublic: true } },
          },
        },
      },
    });

    // A room this person may not see doesn't exist for them (as on the room's page).
    const memberWorldIds = sessionUser && room ? await memberWorldIdsOf(sessionUser.id, [room.world.id]) : new Set<string>();
    if (!room || (!isAdminToken && !canSeeRoom(room, sessionUser, memberWorldIds))) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    // Universe owner, or a world member tagged admin or editor (the room page's canEdit).
    let canEdit = isAdminToken;
    if (sessionUser) {
      canEdit =
        room.world.universe.ownerId === sessionUser.id ||
        !!(await prisma.worldMember.findFirst({
          where: { worldId: room.worldId, userId: sessionUser.id, tags: { hasSome: ['admin', 'editor'] } },
        }));
    }
    if (!canEdit) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const [{ areas, source }, bots] = await Promise.all([
      readRoomAreas(room),
      prisma.bot.findMany({
        where: { roomId: room.id, enabled: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: MAX_BOTS,
      }),
    ]);

    return NextResponse.json({ areas, bots, source });
  } catch (error) {
    console.error('Error loading quest context:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
