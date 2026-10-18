/**
 * The Visitors list: one entry per person, every visit still reachable, and nobody learns more than the visit records
 * already tell them.
 */
jest.mock('@/lib/db', () => ({ prisma: { $queryRaw: jest.fn(), roomAccess: { findMany: jest.fn() }, room: { findMany: jest.fn() } } }));
jest.mock('@/lib/access-scope', () => ({ ...jest.requireActual('@/lib/access-scope'), accessDetailFor: jest.fn(), memberWorldIdsOf: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({
  withWokas: jest.fn(async (records: { userId?: string }[]) => records.map((record) => ({ ...record, woka: record.userId ? [`/woka/${record.userId}.png`] : undefined }))),
}));

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { accessDetailFor, memberWorldIdsOf, type Viewer } from '@/lib/access-scope';
import { loadPersonVisits, loadVisitorPeople, VISITS_SHOWN } from '@/lib/visitor-people';

const queryRaw = prisma.$queryRaw as unknown as jest.Mock;
const findMany = prisma.roomAccess.findMany as jest.Mock;
const detail = accessDetailFor as jest.Mock;
const findRooms = prisma.room.findMany as jest.Mock;
const memberOf = memberWorldIdsOf as jest.Mock;
const viewer = { kind: 'user', user: { id: 'me', uuid: 'me-uuid', email: null, name: 'Me', tags: [], isSuperAdmin: false } } as unknown as Viewer;
const room = { roomId: 'r1' };

const visit = (id: string, userId: string | null, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  accessedAt: new Date(Date.UTC(2026, 9, 18, 12, 0) - minutesAgo * 60_000),
  userId,
  userName: userId ? `Name ${userId}` : 'Nova',
  userEmail: null,
  userUuid: userId ? `${userId}-uuid` : 'browser-1',
  ipAddress: '10.0.0.1',
  isGuest: !userId,
  textureIds: [],
  isAuthenticated: !!userId,
  hasMembership: false,
  membershipTags: [],
  room: { id: 'r1', name: 'HQ' },
  world: { id: 'w1', name: 'Kuwait' },
  ...extra,
});

/**
 * The grouped page, the total, and which visits are each person's newest, the way the three queries are sent. `newest`
 * maps a visit id to the person it belongs to; by default every visit findMany returns belongs to the first person.
 */
function groups(rows: { person: string; visits: number; ips: number }[], total = rows.length, newest?: Record<string, string>) {
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('COUNT(DISTINCT person)')) return [{ total: BigInt(total) }];
    if (sql.includes('ROW_NUMBER()')) return Object.entries(newest ?? {}).map(([id, person]) => ({ id, person }));
    return rows.map((row) => ({ ...row, visits: BigInt(row.visits), ips: BigInt(row.ips) }));
  });
}

/** The query that picks each person's newest visits, as it reaches the database: its SQL and every value sent. */
function newestQuery() {
  const call = queryRaw.mock.calls.find(([strings]) => strings.join('').includes('ROW_NUMBER()'));
  if (!call) return undefined;
  const query = Prisma.sql(call[0] as string[], ...call.slice(1));
  return { sql: query.sql, values: query.values };
}

beforeEach(() => {
  jest.clearAllMocks();
  detail.mockResolvedValue('full');
  memberOf.mockResolvedValue(new Set());
});

/** Rooms as the visibility rules read them: HQ is public in a public world; the others are whatever they are told. */
function roomsAre(...rooms: { id: string; isPublic?: boolean; worldId?: string; worldPublic?: boolean }[]) {
  findRooms.mockResolvedValue(
    rooms.map(({ id, isPublic = true, worldId = 'w1', worldPublic = true }) => ({
      id,
      isPublic,
      world: { id: worldId, isPublic: worldPublic, universe: { isPublic: true, ownerId: 'owner' } },
    })),
  );
}

describe('loadVisitorPeople', () => {
  it('shows each person once, as their newest visit shows them, with how many visits and IPs', async () => {
    groups([{ person: 'u:fawaz', visits: 23, ips: 2 }, { person: 'g:browser-1', visits: 2, ips: 1 }], 214, { a1: 'u:fawaz', a2: 'u:fawaz', a3: 'g:browser-1' });
    findMany.mockResolvedValue([
      visit('a1', 'fawaz', 8, { membershipTags: ['admin'], hasMembership: true }),
      visit('a2', 'fawaz', 9, { ipAddress: '10.0.0.2', isAuthenticated: false }),
      visit('a3', null, 30),
    ]);
    const { people, total, hasMore } = await loadVisitorPeople(viewer, room);
    expect(total).toBe(214);
    expect(hasMore).toBe(true);
    expect(people).toEqual([
      {
        key: 'u:fawaz',
        userId: 'fawaz',
        name: 'Name fawaz',
        woka: ['/woka/fawaz.png'],
        roles: ['admin'],
        visitCount: 23,
        ipCount: 2,
        visits: [
          { id: 'a1', at: '2026-10-18T11:52:00.000Z', signedIn: true, ip: '10.0.0.1', room: { id: 'r1', name: 'HQ' }, world: { id: 'w1', name: 'Kuwait' } },
          { id: 'a2', at: '2026-10-18T11:51:00.000Z', signedIn: false, ip: '10.0.0.2', room: { id: 'r1', name: 'HQ' }, world: { id: 'w1', name: 'Kuwait' } },
        ],
      },
      { key: 'g:browser-1', userId: null, name: 'Nova', woka: undefined, roles: [], visitCount: 2, ipCount: 1, visits: [expect.objectContaining({ id: 'a3', signedIn: false })] },
    ]);
    // Each person's newest visits only, picked by the same person key that grouped the page, then read in this place.
    const newest = newestQuery()!;
    expect(newest.sql).toContain('PARTITION BY person');
    expect(newest.values).toEqual(expect.arrayContaining(['u:fawaz', 'g:browser-1', VISITS_SHOWN]));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: { AND: [room, { id: { in: ['a1', 'a2', 'a3'] } }] }, orderBy: [{ accessedAt: 'desc' }, { id: 'desc' }] }));
  });

  it('keeps IP addresses from people who manage the place without being super admins', async () => {
    detail.mockResolvedValue('manager');
    groups([{ person: 'u:fawaz', visits: 3, ips: 2 }], 1, { a1: 'u:fawaz' });
    findMany.mockResolvedValue([visit('a1', 'fawaz', 8)]);
    const [fawaz] = (await loadVisitorPeople(viewer, room)).people;
    expect(fawaz.ipCount).toBeUndefined();
    expect(fawaz.visits[0].ip).toBeUndefined();
    expect(fawaz.name).toBe('Name fawaz');
  });

  it('reads a full page of people in the same few queries as one person', async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ person: `g:browser-${index}`, visits: 3, ips: 1 }));
    groups(page, 40, Object.fromEntries(page.map((row, index) => [`v${index}`, row.person])));
    findMany.mockResolvedValue(page.map((row, index) => visit(`v${index}`, null, index, { userUuid: row.person.slice(2) })));
    const { people } = await loadVisitorPeople(viewer, room);
    expect(people).toHaveLength(20);
    expect(people.every((person) => person.visits.length === 1)).toBe(true);
    // The page, the total, which visits are newest, and the visits: four queries, not one per person.
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('read together, still tells someone who doesn’t manage the place nothing about who made other visits', async () => {
    detail.mockResolvedValue('minimal');
    groups([{ person: 'u:me', visits: 2, ips: 2 }, { person: 'a:a5', visits: 1, ips: 1 }], 2, { a4: 'u:me', a6: 'u:me', a5: 'a:a5' });
    findMany.mockResolvedValue([
      visit('a4', 'me', 5, { ipAddress: '1.1.1.1' }),
      visit('a5', 'fawaz', 6, { ipAddress: '9.9.9.9', membershipTags: ['admin'], hasMembership: true }),
      visit('a6', null, 7, { userUuid: 'me-uuid' }),
    ]);
    const [mine, theirs] = (await loadVisitorPeople(viewer, room)).people;
    expect(theirs).toEqual({
      key: 'a:a5',
      userId: null,
      name: 'Guest',
      woka: undefined,
      roles: [],
      visitCount: 1,
      visits: [{ id: 'a5', at: '2026-10-18T11:54:00.000Z', signedIn: false, room: { id: 'r1', name: 'HQ' }, world: { id: 'w1', name: 'Kuwait' } }],
    });
    expect(JSON.stringify(theirs)).not.toMatch(/fawaz|9\.9\.9\.9|admin/);
    // Their own visits stay together and say who they are, without IPs, as one of their own visits on its own does.
    expect(mine).toEqual(expect.objectContaining({ key: 'u:me', userId: 'me', name: 'Name me', visitCount: 2 }));
    expect(mine.visits.map((visit) => visit.id)).toEqual(['a4', 'a6']);
    expect(mine.ipCount).toBeUndefined();
    expect(mine.visits.some((visit) => visit.ip)).toBe(false);
  });

  it('never reads the visits of a person the viewer may not ask for, even if one turned up on the page', async () => {
    detail.mockResolvedValue('minimal');
    groups([{ person: 'u:fawaz', visits: 4, ips: 2 }, { person: 'a:a5', visits: 1, ips: 1 }], 2, { a5: 'a:a5' });
    findMany.mockResolvedValue([visit('a5', 'fawaz', 6)]);
    const { people } = await loadVisitorPeople(viewer, room);
    expect(people.map((person) => person.key)).toEqual(['a:a5']);
    expect(newestQuery()!.values).not.toContain('u:fawaz');
  });

  it('asks for the page of people it was given', async () => {
    groups([]);
    expect(await loadVisitorPeople(viewer, room, { page: 3, limit: 20 })).toEqual({ people: [], total: 0, hasMore: false });
    const values = queryRaw.mock.calls.find(([strings]) => !strings.join('').includes('COUNT(DISTINCT person)'))!.slice(1);
    expect(values.slice(-2)).toEqual([20, 40]);
  });

  it('says more people are left by position, not by how many it returned', async () => {
    // 21 people, page 2 of 20: the one row there is the last, even though the page before may have repeated someone.
    groups([{ person: 'g:last', visits: 1, ips: 1 }], 21, { a9: 'g:last' });
    findMany.mockResolvedValue([visit('a9', null, 50)]);
    expect((await loadVisitorPeople(viewer, room, { page: 2, limit: 20 })).hasMore).toBe(false);
    groups([{ person: 'g:last', visits: 1, ips: 1 }], 22, { a9: 'g:last' });
    expect((await loadVisitorPeople(viewer, room, { page: 2, limit: 20 })).hasMore).toBe(true);
  });
});

describe('private rooms and worlds inside a place someone may see', () => {
  const vault = { room: { id: 'r2', name: 'Vault' } };
  const hidden = { world: { id: 'w2', name: 'Secret World' }, room: { id: 'r3', name: 'Bunker' } };

  it('counts visits to a private room on a world page, but does not name it', async () => {
    groups([{ person: 'u:fawaz', visits: 2, ips: 1 }], 1, { a1: 'u:fawaz', a2: 'u:fawaz' });
    findMany.mockResolvedValue([visit('a1', 'fawaz', 5), visit('a2', 'fawaz', 6, vault)]);
    roomsAre({ id: 'r1' }, { id: 'r2', isPublic: false });
    const [fawaz] = (await loadVisitorPeople(viewer, { worldId: 'w1' })).people;
    expect(fawaz.visitCount).toBe(2);
    expect(fawaz.visits.map((visit) => [visit.room, visit.world])).toEqual([
      [{ id: 'r1', name: 'HQ' }, { id: 'w1', name: 'Kuwait' }],
      [null, { id: 'w1', name: 'Kuwait' }],
    ]);
    expect(JSON.stringify(fawaz)).not.toContain('Vault');
  });

  it('hides a private world and its room on a universe page, also when loading more visits', async () => {
    findMany.mockResolvedValue([visit('a3', 'fawaz', 5, hidden)]);
    roomsAre({ id: 'r3', worldId: 'w2', worldPublic: false });
    const [more] = await loadPersonVisits(viewer, { universeId: 'u1' }, 'u:fawaz');
    expect(more.room).toBeNull();
    expect(more.world).toBeNull();
    expect(JSON.stringify(more)).not.toMatch(/Secret World|Bunker/);
  });

  it('names them for a member of that world, a super admin, and on the room’s own page', async () => {
    findMany.mockResolvedValue([visit('a3', 'fawaz', 5, hidden)]);
    roomsAre({ id: 'r3', isPublic: false, worldId: 'w2', worldPublic: false });
    memberOf.mockResolvedValue(new Set(['w2']));
    expect((await loadPersonVisits(viewer, { universeId: 'u1' }, 'u:fawaz'))[0]).toEqual(expect.objectContaining(hidden));
    memberOf.mockResolvedValue(new Set());
    findRooms.mockClear();
    const boss = { kind: 'user', user: { id: 'boss', uuid: null, isSuperAdmin: true } } as unknown as Viewer;
    expect((await loadPersonVisits(boss, { universeId: 'u1' }, 'u:fawaz'))[0]).toEqual(expect.objectContaining(hidden));
    expect((await loadPersonVisits(viewer, { roomId: 'r3' }, 'u:fawaz'))[0]).toEqual(expect.objectContaining(hidden));
    expect(findRooms).not.toHaveBeenCalled();
  });
});

describe('loadPersonVisits', () => {
  it('loads more of one person’s visits after the ones shown', async () => {
    findMany.mockResolvedValue([visit('a9', 'fawaz', 60)]);
    expect(await loadPersonVisits(viewer, room, 'u:fawaz', { offset: 10, limit: 20 })).toEqual([
      { id: 'a9', at: '2026-10-18T11:00:00.000Z', signedIn: true, ip: '10.0.0.1', room: { id: 'r1', name: 'HQ' }, world: { id: 'w1', name: 'Kuwait' } },
    ]);
    expect(findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: { AND: [room, { userId: 'fawaz' }] }, skip: 10, take: 20 }));
  });

  it('never tells someone who doesn’t manage the place which visits are one person’s, except their own', async () => {
    detail.mockResolvedValue('minimal');
    expect(await loadPersonVisits(viewer, room, 'u:fawaz')).toEqual([]);
    expect(await loadPersonVisits(viewer, room, 'g:browser-1')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockResolvedValue([]);
    await loadPersonVisits(viewer, room, 'u:me');
    expect(findMany.mock.calls[0][0].where).toEqual({ AND: [room, { OR: [{ userId: 'me' }, { userUuid: 'me-uuid' }] }] });
  });

  it('shows a lone visit to anyone who can see the place, without saying who made it', async () => {
    detail.mockResolvedValue('minimal');
    findMany.mockResolvedValue([visit('a1', 'fawaz', 8)]);
    const [only] = await loadPersonVisits(viewer, room, 'a:a1', { offset: 0 });
    expect(only).toEqual({ id: 'a1', at: '2026-10-18T11:52:00.000Z', signedIn: false, room: { id: 'r1', name: 'HQ' }, world: { id: 'w1', name: 'Kuwait' } });
    expect(findMany.mock.calls[0][0].where).toEqual({ AND: [room, { id: 'a1' }] });
  });

  it('ignores a person it does not know how to read', async () => {
    expect(await loadPersonVisits(viewer, room, 'x:1')).toEqual([]);
    expect(await loadPersonVisits(viewer, room, 'u:')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
