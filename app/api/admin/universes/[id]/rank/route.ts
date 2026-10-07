import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getViewer, unauthorizedResponse } from '@/lib/access-scope';

// GET /api/admin/universes/[id]/rank - where a public universe stands this week, by visits, among public universes.
// `{ rank: null }` for a private universe or one nobody visited in the last 7 days. Counts only, never who visited.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const { id } = await params;

    const publicUniverses = await prisma.universe.findMany({ where: { isPublic: true }, select: { id: true } });
    const publicIds = publicUniverses.map((universe) => universe.id);
    if (!publicIds.includes(id)) return NextResponse.json({ rank: null });

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const counts = await prisma.roomAccess.groupBy({
      by: ['universeId'],
      where: { universeId: { in: publicIds }, accessedAt: { gte: weekAgo } },
      _count: { _all: true },
    });
    const mine = counts.find((row) => row.universeId === id)?._count._all ?? 0;
    if (mine === 0) return NextResponse.json({ rank: null });

    // Ties share the better place.
    const position = 1 + counts.filter((row) => row._count._all > mine).length;
    return NextResponse.json({ rank: { position, of: publicIds.length } });
  } catch (error) {
    console.error('Error fetching universe rank:', error);
    return NextResponse.json({ error: 'Failed to fetch rank' }, { status: 500 });
  }
}
