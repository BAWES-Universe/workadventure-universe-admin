/**
 * Recent visitors: each person once, newest first, and only for people who manage the place.
 */
jest.mock('@/lib/db', () => ({ prisma: { roomAccess: { findMany: jest.fn(), groupBy: jest.fn() } } }));
jest.mock('@/lib/access-scope', () => ({
  accessDetailFor: jest.fn(),
  viewerUserId: (viewer: { kind: string; user?: { id: string } } | null) => (viewer?.kind === 'user' ? viewer.user!.id : null),
}));
jest.mock('@/lib/woka-avatar', () => ({
  withWokas: jest.fn(async (records: { userId: string }[]) => records.map((record) => ({ ...record, woka: [`/woka/${record.userId}.png`] }))),
}));

import { prisma } from '@/lib/db';
import { accessDetailFor, type Viewer } from '@/lib/access-scope';
import { GUEST_DAYS, loadGuestsThisWeek, loadRecentVisitors, RECENT_VISITORS } from '@/lib/recent-visitors';

const findMany = prisma.roomAccess.findMany as jest.Mock;
const groupBy = prisma.roomAccess.groupBy as jest.Mock;
const detail = accessDetailFor as jest.Mock;
const viewer = { kind: 'user', user: { id: 'me', uuid: 'me-uuid', email: null, name: 'Me', tags: [], isSuperAdmin: false } } as Viewer;

const visit = (userId: string | null, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  userId,
  userName: userId ? `Name ${userId}` : null,
  accessedAt: new Date(Date.UTC(2026, 9, 7, 12, 0) - minutesAgo * 60_000),
  room: { id: `room-${userId}`, name: 'HQ Lobby' },
  user: userId ? { name: `User ${userId}`, isGuest: false } : null,
  ...extra,
});

/** The people-with-an-account query and the guest query hit the same table; tell them apart by what they ask for. */
function serve(members: unknown[], guests: unknown[] = []) {
  findMany.mockImplementation(async (args: { where: { userUuid?: unknown } }) => (args.where.userUuid ? guests : members));
}

const guestVisit = (uuid: string, name: string | null, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  userUuid: uuid,
  userName: name,
  textureIds: ['male1'],
  accessedAt: new Date(Date.UTC(2026, 9, 7, 12, 0) - minutesAgo * 60_000),
  room: { id: `room-${uuid}`, name: 'HQ Lobby' },
  ...extra,
});

beforeEach(() => {
  jest.resetAllMocks();
  detail.mockResolvedValue('manager');
  serve([]);
  const { withWokas } = jest.requireMock('@/lib/woka-avatar');
  withWokas.mockImplementation(async (records: { userId: string }[]) => records.map((record) => ({ ...record, woka: [`/woka/${record.userId}.png`] })));
});

describe('loadRecentVisitors', () => {
  it('lists each person once, newest first, with their name, face, room and time', async () => {
    serve([visit('omar', 1), visit('sara', 4), visit('omar', 30), visit('noor', 60)]);
    const visitors = await loadRecentVisitors(viewer, { universeId: 'u1' });
    expect(visitors.map((visitor) => visitor.userId)).toEqual(['omar', 'sara', 'noor']);
    expect(visitors[0]).toEqual({
      key: 'omar',
      userId: 'omar',
      guest: false,
      name: 'User omar',
      woka: ['/woka/omar.png'],
      at: '2026-10-07T11:59:00.000Z',
      room: { id: 'room-omar', name: 'HQ Lobby' },
    });
  });

  it('shows nothing, and does not even look, to someone who does not manage the place', async () => {
    detail.mockResolvedValue('minimal');
    expect(await loadRecentVisitors(viewer, { worldId: 'w1' })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('asks only for the place, people with an account, and not the viewer', async () => {
    await loadRecentVisitors(viewer, { roomId: 'r1' });
    const asked = (calls: unknown[][]) => calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
    expect(asked(findMany.mock.calls)).toContainEqual({ roomId: 'r1', userId: { not: 'me' } });
    findMany.mockClear();
    await loadRecentVisitors({ kind: 'admin-token' }, { roomId: 'r1' });
    expect(asked(findMany.mock.calls)).toContainEqual({ roomId: 'r1', userId: { not: null } });
  });

  it('leaves out guest accounts and visits with no account, and falls back to the name kept with the visit', async () => {
    serve([
      visit(null, 1),
      visit('guest', 2, { user: { name: 'Guest', isGuest: true } }),
      visit('kept', 3, { user: { name: '  ', isGuest: false } }),
      visit('nameless', 4, { userName: null, user: { name: null, isGuest: false } }),
    ]);
    const visitors = await loadRecentVisitors(viewer, { universeId: 'u1' });
    expect(visitors.map((visitor) => [visitor.userId, visitor.name])).toEqual([
      ['kept', 'Name kept'],
      ['nameless', 'Someone'],
    ]);
  });

  it('stops at eight faces', async () => {
    serve(Array.from({ length: 20 }, (_, index) => visit(`p${index}`, index)));
    expect(await loadRecentVisitors(viewer, { universeId: 'u1' })).toHaveLength(RECENT_VISITORS);
  });
});

describe('loadRecentVisitors, guests', () => {
  it('shows a guest who typed a name as a face with their own Woka, once, among the others by time', async () => {
    const { withWokas } = jest.requireMock('@/lib/woka-avatar');
    serve(
      [visit('omar', 1), visit('sara', 30)],
      [guestVisit('g-nova', 'Nova', 5), guestVisit('g-nova', 'Nova', 50, { textureIds: ['old'] }), guestVisit('g-zed', 'Zed', 90)],
    );
    const visitors = await loadRecentVisitors(viewer, { universeId: 'u1' });
    expect(visitors.map((visitor) => [visitor.key, visitor.guest, visitor.name])).toEqual([
      ['omar', false, 'User omar'],
      ['g-nova', true, 'Nova'],
      ['sara', false, 'User sara'],
      ['g-zed', true, 'Zed'],
    ]);
    expect(visitors[1].userId).toBeNull();
    // The guest's saved outfit goes to the Woka lookup as it is, marked as a guest.
    const asked = withWokas.mock.calls[0][0] as Record<string, unknown>[];
    expect(asked[1]).toEqual({ userId: null, userUuid: 'g-nova', isGuest: true, textureIds: ['male1'] });
  });

  it('asks only for guests with a typed name, never for an id as a name, and takes the outfit from the visit that has one', async () => {
    serve(
      [],
      [
        guestVisit('g-id', 'g-id', 1),
        guestVisit('g-blank', '   ', 2),
        guestVisit('g-late', 'Late', 3, { textureIds: [] }),
        guestVisit('g-late', 'Late', 9, { textureIds: ['female2'] }),
      ],
    );
    const visitors = await loadRecentVisitors(viewer, { worldId: 'w1' });
    expect(visitors.map((visitor) => visitor.name)).toEqual(['Late']);
    const guestQuery = findMany.mock.calls.map((call) => call[0].where).find((where) => where.userUuid);
    expect(guestQuery).toEqual({
      worldId: 'w1',
      userUuid: { not: null },
      userName: { not: null },
      OR: [{ userId: null }, { user: { isGuest: true } }],
    });
    const { withWokas } = jest.requireMock('@/lib/woka-avatar');
    expect(withWokas.mock.calls[0][0][0].textureIds).toEqual(['female2']);
  });

  it('keeps eight faces in all, guests included', async () => {
    serve(
      Array.from({ length: 8 }, (_, index) => visit(`p${index}`, 100 + index)),
      Array.from({ length: 8 }, (_, index) => guestVisit(`g${index}`, `Guest ${index}`, index)),
    );
    const visitors = await loadRecentVisitors(viewer, { universeId: 'u1' });
    expect(visitors).toHaveLength(RECENT_VISITORS);
    expect(visitors.every((visitor) => visitor.guest)).toBe(true);
  });
});

describe('loadGuestsThisWeek', () => {
  it('counts the different guests of the last week, from their visits, once each', async () => {
    groupBy.mockResolvedValue([{ userUuid: 'g1' }, { userUuid: 'g2' }, { userUuid: 'g3' }]);
    expect(await loadGuestsThisWeek(viewer, { worldId: 'w1' })).toBe(3);
    const args = groupBy.mock.calls[0][0];
    expect(args.by).toEqual(['userUuid']);
    expect(args.where.worldId).toBe('w1');
    expect(args.where.userUuid).toEqual({ not: null });
    expect(args.where.OR).toEqual([{ userId: null }, { user: { isGuest: true } }]);
    const days = (Date.now() - args.where.accessedAt.gte.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(GUEST_DAYS - 0.01);
    expect(days).toBeLessThan(GUEST_DAYS + 0.01);
  });

  it('is 0, without looking, for anyone who does not manage the place', async () => {
    detail.mockResolvedValue('minimal');
    expect(await loadGuestsThisWeek(viewer, { universeId: 'u1' })).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
