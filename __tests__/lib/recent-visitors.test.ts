/**
 * Recent visitors: each person once, newest first, and only for people who manage the place.
 */
jest.mock('@/lib/db', () => ({ prisma: { roomAccess: { findMany: jest.fn() } } }));
jest.mock('@/lib/access-scope', () => ({
  accessDetailFor: jest.fn(),
  viewerUserId: (viewer: { kind: string; user?: { id: string } } | null) => (viewer?.kind === 'user' ? viewer.user!.id : null),
}));
jest.mock('@/lib/woka-avatar', () => ({
  withWokas: jest.fn(async (records: { userId: string }[]) => records.map((record) => ({ ...record, woka: [`/woka/${record.userId}.png`] }))),
}));

import { prisma } from '@/lib/db';
import { accessDetailFor, type Viewer } from '@/lib/access-scope';
import { loadRecentVisitors, RECENT_VISITORS } from '@/lib/recent-visitors';

const findMany = prisma.roomAccess.findMany as jest.Mock;
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

beforeEach(() => {
  jest.resetAllMocks();
  detail.mockResolvedValue('manager');
  findMany.mockResolvedValue([]);
  const { withWokas } = jest.requireMock('@/lib/woka-avatar');
  withWokas.mockImplementation(async (records: { userId: string }[]) => records.map((record) => ({ ...record, woka: [`/woka/${record.userId}.png`] })));
});

describe('loadRecentVisitors', () => {
  it('lists each person once, newest first, with their name, face, room and time', async () => {
    findMany.mockResolvedValue([visit('omar', 1), visit('sara', 4), visit('omar', 30), visit('noor', 60)]);
    const visitors = await loadRecentVisitors(viewer, { universeId: 'u1' });
    expect(visitors.map((visitor) => visitor.userId)).toEqual(['omar', 'sara', 'noor']);
    expect(visitors[0]).toEqual({
      userId: 'omar',
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
    expect(findMany.mock.calls[0][0].where).toEqual({ roomId: 'r1', userId: { not: 'me' } });
    await loadRecentVisitors({ kind: 'admin-token' }, { roomId: 'r1' });
    expect(findMany.mock.calls[1][0].where).toEqual({ roomId: 'r1', userId: { not: null } });
  });

  it('leaves out guests and visits with no account, and falls back to the name kept with the visit', async () => {
    findMany.mockResolvedValue([
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
    findMany.mockResolvedValue(Array.from({ length: 20 }, (_, index) => visit(`p${index}`, index)));
    expect(await loadRecentVisitors(viewer, { universeId: 'u1' })).toHaveLength(RECENT_VISITORS);
  });
});
