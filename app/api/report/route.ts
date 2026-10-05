import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { findUserByIdentifier, parseWorldAddress } from '@/lib/moderation';

/** The longest report Orbit keeps; the game's form is shorter. */
const MAX_COMMENT = 2000;
const MAX_REPORTS_PER_HOUR = 20;

/**
 * A player's report about another player, sent by the game. It is saved for the world's admins and the universe's
 * owner, who see it on their Orbit home and in the world's Safety tab.
 */
export async function POST(request: NextRequest) {
  try {
    requireAuth(request);

    const body = await request.json();
    const { reportedUserUuid, reportedUserComment, reporterUserUuid, reportWorldSlug } = body;

    if (typeof reportedUserUuid !== 'string' || typeof reporterUserUuid !== 'string' || typeof reportWorldSlug !== 'string' || !reportedUserUuid || !reporterUserUuid) {
      return NextResponse.json(
        { error: 'reportedUserUuid, reporterUserUuid, and reportWorldSlug are required' },
        { status: 400 }
      );
    }
    const comment = typeof reportedUserComment === 'string' ? reportedUserComment.trim().slice(0, MAX_COMMENT) : '';

    const address = parseWorldAddress(reportWorldSlug);
    const worldData = address
      ? await prisma.world.findFirst({
          where: { slug: address.world, universe: { slug: address.universe } },
          select: { id: true },
        })
      : null;
    if (!worldData) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // A player can't flood a world's admins: past this many reports an hour, more are dropped quietly
    const recent = await prisma.report.count({
      where: { reporterUuid: reporterUserUuid, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= MAX_REPORTS_PER_HOUR) {
      return NextResponse.json({ success: true });
    }
    
    const [reportedUser, reporterUser, room] = await Promise.all([
      findUserByIdentifier(reportedUserUuid),
      findUserByIdentifier(reporterUserUuid),
      address?.room
        ? prisma.room.findFirst({ where: { worldId: worldData.id, slug: address.room }, select: { id: true } })
        : null,
    ]);

    await prisma.report.create({
      data: {
        worldId: worldData.id,
        roomId: room?.id ?? null,
        reportedUserId: reportedUser?.id ?? null,
        reportedUuid: reportedUserUuid,
        reporterUserId: reporterUser?.id ?? null,
        reporterUuid: reporterUserUuid,
        comment,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.error('Error in /api/report:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
