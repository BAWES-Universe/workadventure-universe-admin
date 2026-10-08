import { NextRequest, NextResponse } from 'next/server';
import { getViewer, viewerUserId, unauthorizedResponse } from '@/lib/access-scope';
import { CARD_STAMPS, visibleStamps } from '@/lib/passport';

export const dynamic = 'force-dynamic';

/** GET /api/admin/users/[id]/passport - the stamps this viewer may see on someone's card: public worlds, if they share it. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const { id } = await params;
    const stamps = await visibleStamps(viewerUserId(viewer), id, CARD_STAMPS);
    return NextResponse.json({ stamps }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching passport:', error);
    return NextResponse.json({ error: 'Failed to fetch passport' }, { status: 500 });
  }
}
