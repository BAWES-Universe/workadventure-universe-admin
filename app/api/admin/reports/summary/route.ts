import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { playerNames, worldsModeratedBy } from '@/lib/moderation';

/**
 * Reports and appeals waiting in the worlds this person looks after (worlds in universes they own, worlds they're
 * an admin of), for the card on their Orbit home. Super admins only see their own worlds here.
 */
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const worlds = await prisma.world.findMany({
      where: worldsModeratedBy(sessionUser.id),
      select: { id: true, name: true, universe: { select: { name: true } } },
    });
    if (worlds.length === 0) return NextResponse.json({ total: 0, worlds: [], latest: null });
    const worldIds = worlds.map((world) => world.id);

    const [reportCounts, appealCounts] = await Promise.all([
      prisma.report.groupBy({ by: ['worldId'], where: { worldId: { in: worldIds }, status: 'open' }, _count: { _all: true } }),
      prisma.ban.groupBy({
        by: ['worldId'],
        where: {
          worldId: { in: worldIds },
          isActive: true,
          appealedAt: { not: null },
          appealDecision: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _count: { _all: true },
      }),
    ]);
    const reportsIn = new Map(reportCounts.map((row) => [row.worldId, row._count._all]));
    const appealsIn = new Map(appealCounts.map((row) => [row.worldId as string, row._count._all]));

    const waiting = worlds
      .map((world) => ({
        id: world.id,
        name: world.name,
        universeName: world.universe.name,
        reports: reportsIn.get(world.id) ?? 0,
        appeals: appealsIn.get(world.id) ?? 0,
      }))
      .filter((world) => world.reports + world.appeals > 0)
      .sort((a, b) => b.reports + b.appeals - (a.reports + a.appeals));
    const total = waiting.reduce((sum, world) => sum + world.reports + world.appeals, 0);

    // With one report waiting, the card shows its words
    let latest = null;
    if (total === 1 && waiting[0].reports === 1) {
      const report = await prisma.report.findFirst({
        where: { worldId: waiting[0].id, status: 'open' },
        include: { room: { select: { name: true } } },
      });
      if (report) {
        const nameOf = await playerNames(report.worldId, [
          { userId: report.reportedUserId, uuid: report.reportedUuid },
          { userId: report.reporterUserId, uuid: report.reporterUuid },
        ]);
        latest = {
          worldId: report.worldId,
          worldName: waiting[0].name,
          reportedName: nameOf({ userId: report.reportedUserId, uuid: report.reportedUuid }).name,
          reporterName: nameOf({ userId: report.reporterUserId, uuid: report.reporterUuid }).name,
          roomName: report.room?.name ?? null,
          comment: report.comment,
          createdAt: report.createdAt.toISOString(),
        };
      }
    }

    return NextResponse.json({ total, worlds: waiting, latest });
  } catch (error) {
    console.error('Error in GET /api/admin/reports/summary:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
