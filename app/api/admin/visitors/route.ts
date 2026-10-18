import { NextRequest, NextResponse } from 'next/server';
import { getViewer, unauthorizedResponse, type AccessScope } from '@/lib/access-scope';
import { loadPersonVisits, loadVisitorPeople, MAX_VISITS_PER_LOAD, PEOPLE_PER_PAGE, VISITS_SHOWN } from '@/lib/visitor-people';
import { viewerWorldId } from '@/lib/viewer-world';

export const dynamic = 'force-dynamic';

const SCOPES = { universe: 'universeId', world: 'worldId', room: 'roomId' } as const;

/** A whole number from the query, kept between min and max; the fallback when it is missing or not a number. */
function whole(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/**
 * GET /api/admin/visitors?scope=universe|world|room&id=...&page=1 - who came, one entry per person, newest first, with
 * their newest visits and how many people there are in all.
 * GET /api/admin/visitors?scope=...&id=...&person=<key>&offset=10 - more of one person's visits.
 */
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const params = request.nextUrl.searchParams;
    const scope = params.get('scope');
    const id = params.get('id');
    if (!id || !scope || !Object.hasOwn(SCOPES, scope)) return NextResponse.json({ error: 'Pick a scope and an id' }, { status: 400 });
    const where = { [SCOPES[scope as keyof typeof SCOPES]]: id } as AccessScope;
    const person = params.get('person');
    if (person) {
      const visits = await loadPersonVisits(viewer, where, person, {
        offset: whole(params.get('offset'), VISITS_SHOWN, 0, Number.MAX_SAFE_INTEGER),
        limit: whole(params.get('limit'), MAX_VISITS_PER_LOAD, 1, MAX_VISITS_PER_LOAD),
      });
      return NextResponse.json({ visits }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const result = await loadVisitorPeople(viewer, where, {
      page: whole(params.get('page'), 1, 1, 100000),
      limit: whole(params.get('limit'), PEOPLE_PER_PAGE, 1, 50),
      lookingFromWorldId: await viewerWorldId(request, viewer).catch(() => undefined),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching visitors:', error);
    return NextResponse.json({ error: 'Failed to fetch visitors' }, { status: 500 });
  }
}
