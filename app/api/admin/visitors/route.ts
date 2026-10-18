import { NextRequest, NextResponse } from 'next/server';
import { getViewer, memberWorldIdsOf, unauthorizedResponse, type AccessScope, type Viewer } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import { canSeeRoom, canSeeUniverse, canSeeWorld } from '@/lib/room-visibility';
import { loadPersonVisits, loadVisitorPeople, MAX_VISITS_PER_LOAD, PEOPLE_PER_PAGE, VISITS_SHOWN } from '@/lib/visitor-people';
import { viewerWorldId } from '@/lib/viewer-world';

export const dynamic = 'force-dynamic';

const SCOPES = { universe: 'universeId', world: 'worldId', room: 'roomId' } as const;

/** A whole number from the query, kept between min and max; the fallback when it is missing or not a number. */
function whole(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const PLACE_SELECT = { isPublic: true, ownerId: true } as const;

/**
 * Whether the viewer may see this room, world or universe at all, by the same rules as its own page: public, the
 * universe's owner, a member of the world, or a super admin. To anyone else it doesn't exist.
 */
async function canSeePlace(viewer: Viewer, scope: keyof typeof SCOPES, id: string): Promise<boolean> {
  if (viewer.kind === 'admin-token') return true;
  const { user } = viewer;
  if (scope === 'room') {
    const room = await prisma.room.findUnique({
      where: { id },
      select: { isPublic: true, world: { select: { id: true, isPublic: true, universe: { select: PLACE_SELECT } } } },
    });
    return !!room && canSeeRoom(room, user, await memberWorldIdsOf(user.id, [room.world.id]));
  }
  if (scope === 'world') {
    const world = await prisma.world.findUnique({ where: { id }, select: { id: true, isPublic: true, universe: { select: PLACE_SELECT } } });
    return !!world && canSeeWorld(world, user, await memberWorldIdsOf(user.id, [world.id]));
  }
  const universe = await prisma.universe.findUnique({ where: { id }, select: { ...PLACE_SELECT, worlds: { select: { id: true } } } });
  if (!universe) return false;
  const memberWorldIds = await memberWorldIdsOf(user.id, universe.worlds.map((world) => world.id));
  return canSeeUniverse(universe, user, memberWorldIds.size > 0);
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
    if (!(await canSeePlace(viewer, scope as keyof typeof SCOPES, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
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
