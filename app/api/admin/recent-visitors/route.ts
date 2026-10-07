import { NextRequest, NextResponse } from 'next/server';
import { getViewer, unauthorizedResponse, type AccessScope } from '@/lib/access-scope';
import { loadGuestsThisWeek, loadRecentVisitors } from '@/lib/recent-visitors';

export const dynamic = 'force-dynamic';

const SCOPES = { universe: 'universeId', world: 'worldId', room: 'roomId' } as const;

/**
 * GET /api/admin/recent-visitors?scope=universe|world|room&id=... - who came by lately, newest first, each once, and how many different guests came this week.
 * Empty for anyone who doesn't manage the place: the names are the same ones the Visitors list shows managers.
 */
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const scope = request.nextUrl.searchParams.get('scope');
    const id = request.nextUrl.searchParams.get('id');
    if (!id || !scope || !Object.hasOwn(SCOPES, scope)) return NextResponse.json({ error: 'Pick a scope and an id' }, { status: 400 });
    const key = SCOPES[scope as keyof typeof SCOPES];
    const where = { [key]: id } as AccessScope;
    const [visitors, guests] = await Promise.all([loadRecentVisitors(viewer, where), loadGuestsThisWeek(viewer, where)]);
    return NextResponse.json({ visitors, guests }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching recent visitors:', error);
    return NextResponse.json({ error: 'Failed to fetch recent visitors' }, { status: 500 });
  }
}
