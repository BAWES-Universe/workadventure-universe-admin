import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { buildLiveView, fetchPresenceSnapshot } from '@/lib/live-presence';

export const runtime = 'nodejs';

// GET /api/live - who is where right now, as the caller may see it. `{ available: false }` when the game can't say.
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const snapshot = await fetchPresenceSnapshot();
  if (!snapshot) return NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const view = await buildLiveView(snapshot, user);
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Live] Could not build the view:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
