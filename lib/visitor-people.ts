import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { accessDetailFor, detailForRecord, memberWorldIdsOf, redactAccess, type AccessDetail, type AccessScope, type Viewer } from '@/lib/access-scope';
import { canSeeRoom, canSeeWorld } from '@/lib/room-visibility';
import { withWokas } from '@/lib/woka-avatar';

/**
 * The Visitors list: who came to a universe, world or room, one entry per person, newest first, each with every visit
 * they made. A person is their account, or for a guest the id their browser keeps. Someone who doesn't manage the place
 * sees when visits happened, not who made them, so for them every visit stands alone (except their own).
 */

export const PEOPLE_PER_PAGE = 20;
/** Visits shown when a person is opened; the rest load on request. */
export const VISITS_SHOWN = 10;
export const MAX_VISITS_PER_LOAD = 50;

export interface PersonVisit {
  id: string;
  at: string;
  signedIn: boolean;
  /** Only for people who may see IP addresses. */
  ip?: string;
  /** Null when the viewer may not see that room or world: the visit still counts, but where it was stays private. */
  room: { id: string; name: string } | null;
  world: { id: string; name: string } | null;
}

export interface VisitorPerson {
  key: string;
  /** Their account, for the link to their profile; null for a guest or when the viewer may not know who it was. */
  userId: string | null;
  name: string;
  woka?: string[];
  roles: string[];
  visitCount: number;
  /** How many different IP addresses they came from, for people who may see them. */
  ipCount?: number;
  /** Their newest visits, newest first. */
  visits: PersonVisit[];
}

// Whitelisted: the only identifiers ever put into SQL.
const COLUMN = { universeId: Prisma.raw('universe_id'), worldId: Prisma.raw('world_id'), roomId: Prisma.raw('room_id') } as const;

function scopeSql(scope: AccessScope): Prisma.Sql {
  const [key, id] = Object.entries(scope)[0] as [keyof typeof COLUMN, string];
  return Prisma.sql`${COLUMN[key]} = ${id}`;
}

function viewerUser(viewer: Viewer | null) {
  return viewer?.kind === 'user' ? viewer.user : null;
}

/** The person a visit belongs to, as the viewer may tell people apart. */
function personKeySql(viewer: Viewer | null, detail: AccessDetail): Prisma.Sql {
  if (detail !== 'minimal') return Prisma.sql`COALESCE('u:' || user_id, 'g:' || user_uuid, 'a:' || id)`;
  const me = viewerUser(viewer);
  if (!me) return Prisma.sql`'a:' || id`;
  return Prisma.sql`CASE WHEN user_id = ${me.id} OR user_uuid = ${me.uuid ?? null} THEN ${'u:' + me.id} ELSE 'a:' || id END`;
}

/** The visits behind a person key, or null when the viewer may not ask for that person. */
function visitsWhere(viewer: Viewer | null, detail: AccessDetail, key: string): Prisma.RoomAccessWhereInput | null {
  const value = key.slice(2);
  if (!value) return null;
  if (key.startsWith('a:')) return { id: value };
  if (detail === 'minimal') {
    const me = viewerUser(viewer);
    if (!me || key !== `u:${me.id}`) return null;
    return { OR: [{ userId: me.id }, ...(me.uuid ? [{ userUuid: me.uuid }] : [])] };
  }
  if (key.startsWith('u:')) return { userId: value };
  if (key.startsWith('g:')) return { userId: null, userUuid: value };
  return null;
}

const VISIT_SELECT = {
  id: true,
  accessedAt: true,
  userId: true,
  userName: true,
  userEmail: true,
  userUuid: true,
  ipAddress: true,
  isGuest: true,
  textureIds: true,
  isAuthenticated: true,
  hasMembership: true,
  membershipTags: true,
  room: { select: { id: true, name: true } },
  world: { select: { id: true, name: true } },
} satisfies Prisma.RoomAccessSelect;

type VisitRow = Prisma.RoomAccessGetPayload<{ select: typeof VISIT_SELECT }>;

async function visitsOf(scope: AccessScope, where: Prisma.RoomAccessWhereInput, skip: number, take: number) {
  return prisma.roomAccess.findMany({ where: { AND: [scope, where] }, orderBy: [{ accessedAt: 'desc' }, { id: 'desc' }], skip, take, select: VISIT_SELECT });
}

/**
 * The newest visits of each person on a page, in two queries however many people there are: which visits are each
 * person's newest, then those visits. A person counts only when the viewer may ask for them (the same rule as asking for
 * more of their visits), and a visit belongs to a person by the same key that grouped the page.
 */
async function newestVisitsOf(
  viewer: Viewer | null,
  detail: AccessDetail,
  scope: AccessScope,
  visits: Prisma.Sql,
  keys: string[],
): Promise<Map<string, VisitRow[]>> {
  const allowed = keys.filter((key) => visitsWhere(viewer, detail, key) !== null);
  const byPerson = new Map(allowed.map((key) => [key, [] as VisitRow[]]));
  if (allowed.length === 0) return byPerson;
  const newest = await prisma.$queryRaw<Array<{ id: string; person: string }>>`
    SELECT id, person FROM (
      SELECT id, person, ROW_NUMBER() OVER (PARTITION BY person ORDER BY accessed_at DESC, id DESC) AS place
      FROM (${visits}) AS v
      WHERE person IN (${Prisma.join(allowed)})
    ) AS ranked
    WHERE place <= ${VISITS_SHOWN}`;
  const personOf = new Map(newest.map((row) => [row.id, row.person]));
  if (personOf.size === 0) return byPerson;
  const rows = await prisma.roomAccess.findMany({
    where: { AND: [scope, { id: { in: [...personOf.keys()] } }] },
    orderBy: [{ accessedAt: 'desc' }, { id: 'desc' }],
    select: VISIT_SELECT,
  });
  for (const row of rows) byPerson.get(personOf.get(row.id) ?? '')?.push(row);
  return byPerson;
}

/** The rooms and worlds on these visits that the viewer may not see, by the same rules as their own pages. */
async function hiddenPlaces(viewer: Viewer | null, scope: AccessScope, rows: VisitRow[]) {
  const hidden = { rooms: new Set<string>(), worlds: new Set<string>() };
  const user = viewerUser(viewer);
  // A room's visits are all in that room, which the viewer was already allowed to see.
  if ('roomId' in scope || viewer?.kind === 'admin-token' || user?.isSuperAdmin) return hidden;
  const roomIds = [...new Set(rows.map((row) => row.room.id))];
  if (roomIds.length === 0) return hidden;
  const rooms = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, isPublic: true, world: { select: { id: true, isPublic: true, universe: { select: { isPublic: true, ownerId: true } } } } },
  });
  const memberWorldIds = user ? await memberWorldIdsOf(user.id, [...new Set(rooms.map((room) => room.world.id))]) : new Set<string>();
  for (const room of rooms) {
    if (!canSeeRoom(room, user, memberWorldIds)) hidden.rooms.add(room.id);
    if (!canSeeWorld(room.world, user, memberWorldIds)) hidden.worlds.add(room.world.id);
  }
  return hidden;
}

/** Visits as this viewer may see them: redacted per record, and with rooms and worlds they may not see left out. */
async function toVisits(viewer: Viewer | null, detail: AccessDetail, scope: AccessScope, rows: VisitRow[]): Promise<PersonVisit[]> {
  const hidden = await hiddenPlaces(viewer, scope, rows);
  return rows.map((row) => {
    const seen = redactAccess(row, detailForRecord(viewer, row, detail));
    return {
      id: row.id,
      at: row.accessedAt.toISOString(),
      signedIn: seen.isAuthenticated === true,
      ...(typeof seen.ipAddress === 'string' ? { ip: seen.ipAddress } : {}),
      room: hidden.rooms.has(row.room.id) ? null : row.room,
      world: hidden.worlds.has(row.world.id) ? null : row.world,
    };
  });
}

/**
 * One page of people, newest first, how many people there are in all, and whether any come after this page. Someone who
 * comes back while the list is open moves to the top and pushes the rest down, so the list counts pages by position, not
 * by how many people it has shown.
 */
export async function loadVisitorPeople(
  viewer: Viewer | null,
  scope: AccessScope,
  { page = 1, limit = PEOPLE_PER_PAGE, lookingFromWorldId }: { page?: number; limit?: number; lookingFromWorldId?: string } = {},
): Promise<{ people: VisitorPerson[]; total: number; hasMore: boolean }> {
  const detail = await accessDetailFor(viewer, scope);
  const visits = Prisma.sql`SELECT id, accessed_at, ip_address, ${personKeySql(viewer, detail)} AS person FROM room_accesses WHERE ${scopeSql(scope)}`;
  const [groups, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ person: string; visits: bigint | number; ips: bigint | number }>>`
      SELECT person, COUNT(*) AS visits, COUNT(DISTINCT ip_address) AS ips, MAX(accessed_at) AS last
      FROM (${visits}) AS v
      GROUP BY person
      ORDER BY last DESC, person
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    prisma.$queryRaw<Array<{ total: bigint | number }>>`SELECT COUNT(DISTINCT person) AS total FROM (${visits}) AS v`,
  ]);
  const newest = await newestVisitsOf(viewer, detail, scope, visits, groups.map((group) => group.person));
  const rows = groups.map((group) => newest.get(group.person) ?? []);
  // Each person as their newest visit shows them, redacted the same way as one visit on its own.
  const faces = await withWokas(
    rows.map((personVisits) => {
      const latest = personVisits[0];
      return latest ? redactAccess(latest, detailForRecord(viewer, latest, detail)) : {};
    }),
    lookingFromWorldId,
  );
  const shown = await toVisits(viewer, detail, scope, rows.flat());
  const visitById = new Map(shown.map((visit) => [visit.id, visit]));
  const people = groups.flatMap((group, index): VisitorPerson[] => {
    const latest = faces[index] as Partial<VisitRow> & { woka?: string[] };
    if (!rows[index].length) return [];
    return [
      {
        key: group.person,
        userId: latest.userId ?? null,
        name: latest.userName || latest.userEmail || latest.userUuid || 'Guest',
        woka: latest.woka,
        roles: latest.hasMembership && latest.membershipTags?.length ? latest.membershipTags : [],
        visitCount: Number(group.visits),
        ...(typeof latest.ipAddress === 'string' ? { ipCount: Number(group.ips) } : {}),
        visits: rows[index].map((row) => visitById.get(row.id)!),
      },
    ];
  });
  const total = Number(counted[0]?.total ?? 0);
  return { people, total, hasMore: (page - 1) * limit + groups.length < total };
}

/** More of one person's visits, after the ones already shown. Nothing when the viewer may not ask for that person. */
export async function loadPersonVisits(
  viewer: Viewer | null,
  scope: AccessScope,
  key: string,
  { offset = VISITS_SHOWN, limit = MAX_VISITS_PER_LOAD }: { offset?: number; limit?: number } = {},
): Promise<PersonVisit[]> {
  const detail = await accessDetailFor(viewer, scope);
  const where = visitsWhere(viewer, detail, key);
  if (!where) return [];
  const rows = await visitsOf(scope, where, offset, limit);
  return toVisits(viewer, detail, scope, rows);
}
