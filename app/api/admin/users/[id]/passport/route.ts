import { NextRequest, NextResponse } from 'next/server';
import { getViewer, viewerUserId, unauthorizedResponse } from '@/lib/access-scope';
import { CARD_STAMPS, visiblePassport, visibleStamps } from '@/lib/passport';

export const dynamic = 'force-dynamic';

/** GET /api/admin/users/[id]/passport - the stamps this viewer may see on someone's card, and the whole passport for their profile (null when they hide it): public worlds, if they share it. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const { id } = await params;
    const viewerId = viewerUserId(viewer);
    const [stamps, passport] = await Promise.all([visibleStamps(viewerId, id, CARD_STAMPS), visiblePassport(viewerId, id)]);
    return NextResponse.json({ stamps, passport }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching passport:', error);
    return NextResponse.json({ error: 'Failed to fetch passport' }, { status: 500 });
  }
}
