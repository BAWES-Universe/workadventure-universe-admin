/**
 * The Visitors list: one entry per person, every visit still reachable, and nobody learns more than the visit records
 * already tell them.
 */
jest.mock('@/lib/db', () => ({ prisma: { $queryRaw: jest.fn(), roomAccess: { findMany: jest.fn() } } }));
jest.mock('@/lib/access-scope', () => ({ ...jest.requireActual('@/lib/access-scope'), accessDetailFor: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({
  withWokas: jest.fn(async (records: { userId?: string }[]) => records.map((record) => ({ ...record, woka: record.userId ? [`/woka/${record.userId}.png`] : undefined }))),
}));

import { prisma } from '@/lib/db';
import { accessDetailFor, type Viewer } from '@/lib/access-scope';
import { loadPersonVisits, loadVisitorPeople, VISITS_SHOWN } from '@/lib/visitor-people';

const queryRaw = prisma.$queryRaw as unknown as jest.Mock;
const findMany = prisma.roomAccess.findMany as jest.Mock;
const detail = accessDetailFor as jest.Mock;
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

/** The grouped page, then the total, the way the two queries are sent. */
function groups(rows: { person: string; visits: number; ips: number }[], total = rows.length) {
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('').includes('COUNT(DISTINCT person)') ? [{ total: BigInt(total) }] : rows.map((row) => ({ ...row, visits: BigInt(row.visits), ips: BigInt(row.ips) }))));
}

beforeEach(() => {
  jest.clearAllMocks();
  detail.mockResolvedValue('full');
});

describe('loadVisitorPeople', () => {
  it('shows each person once, as their newest visit shows them, with how many visits and IPs', async () => {
    groups([{ person: 'u:fawaz', visits: 23, ips: 2 }, { person: 'g:browser-1', visits: 2, ips: 1 }], 214);
    findMany.mockImplementation(async ({ where }: { where: { AND: [unknown, { userId?: string | null }] } }) =>
      where.AND[1].userId === 'fawaz'
        ? [visit('a1', 'fawaz', 8, { membershipTags: ['admin'], hasMembership: true }), visit('a2', 'fawaz', 9, { ipAddress: '10.0.0.2', isAuthenticated: false })]
        : [visit('a3', null, 30)],
    );
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
    // Each person's newest visits only, in this place, newest first.
    expect(findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: { AND: [room, { userId: 'fawaz' }] }, skip: 0, take: VISITS_SHOWN }));
    expect(findMany.mock.calls[1][0].where).toEqual({ AND: [room, { userId: null, userUuid: 'browser-1' }] });
  });

  it('keeps IP addresses from people who manage the place without being super admins', async () => {
    detail.mockResolvedValue('manager');
    groups([{ person: 'u:fawaz', visits: 3, ips: 2 }]);
    findMany.mockResolvedValue([visit('a1', 'fawaz', 8)]);
    const [fawaz] = (await loadVisitorPeople(viewer, room)).people;
    expect(fawaz.ipCount).toBeUndefined();
    expect(fawaz.visits[0].ip).toBeUndefined();
    expect(fawaz.name).toBe('Name fawaz');
  });

  it('asks for the page of people it was given', async () => {
    groups([]);
    expect(await loadVisitorPeople(viewer, room, { page: 3, limit: 20 })).toEqual({ people: [], total: 0, hasMore: false });
    const values = queryRaw.mock.calls.find(([strings]) => !strings.join('').includes('COUNT(DISTINCT person)'))!.slice(1);
    expect(values.slice(-2)).toEqual([20, 40]);
  });

  it('says more people are left by position, not by how many it returned', async () => {
    // 21 people, page 2 of 20: the one row there is the last, even though the page before may have repeated someone.
    groups([{ person: 'g:last', visits: 1, ips: 1 }], 21);
    findMany.mockResolvedValue([visit('a9', null, 50)]);
    expect((await loadVisitorPeople(viewer, room, { page: 2, limit: 20 })).hasMore).toBe(false);
    groups([{ person: 'g:last', visits: 1, ips: 1 }], 22);
    expect((await loadVisitorPeople(viewer, room, { page: 2, limit: 20 })).hasMore).toBe(true);
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
