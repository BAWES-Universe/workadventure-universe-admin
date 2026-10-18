import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { accessDetailFor, detailForRecord, redactAccess, type AccessDetail, type AccessScope, type Viewer } from '@/lib/access-scope';
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
  room: { id: string; name: string };
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
} satisfies Prisma.RoomAccessSelect;

type VisitRow = Prisma.RoomAccessGetPayload<{ select: typeof VISIT_SELECT }>;

async function visitsOf(scope: AccessScope, where: Prisma.RoomAccessWhereInput, skip: number, take: number) {
  return prisma.roomAccess.findMany({ where: { AND: [scope, where] }, orderBy: [{ accessedAt: 'desc' }, { id: 'desc' }], skip, take, select: VISIT_SELECT });
}

function toVisit(viewer: Viewer | null, detail: AccessDetail, row: VisitRow): PersonVisit {
  const seen = redactAccess(row, detailForRecord(viewer, row, detail));
  return {
    id: row.id,
    at: row.accessedAt.toISOString(),
    signedIn: seen.isAuthenticated === true,
    ...(typeof seen.ipAddress === 'string' ? { ip: seen.ipAddress } : {}),
    room: row.room,
  };
}

/** One page of people, newest first, and how many people there are in all. */
export async function loadVisitorPeople(
  viewer: Viewer | null,
  scope: AccessScope,
  { page = 1, limit = PEOPLE_PER_PAGE, lookingFromWorldId }: { page?: number; limit?: number; lookingFromWorldId?: string } = {},
): Promise<{ people: VisitorPerson[]; total: number }> {
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
  const rows = await Promise.all(
    groups.map(async (group) => {
      const where = visitsWhere(viewer, detail, group.person);
      return where ? visitsOf(scope, where, 0, VISITS_SHOWN) : [];
    }),
  );
  // Each person as their newest visit shows them, redacted the same way as one visit on its own.
  const faces = await withWokas(
    rows.map((personVisits) => {
      const latest = personVisits[0];
      return latest ? redactAccess(latest, detailForRecord(viewer, latest, detail)) : {};
    }),
    lookingFromWorldId,
  );
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
        visits: rows[index].map((row) => toVisit(viewer, detail, row)),
      },
    ];
  });
  return { people, total: Number(counted[0]?.total ?? 0) };
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
  return rows.map((row) => toVisit(viewer, detail, row));
}
