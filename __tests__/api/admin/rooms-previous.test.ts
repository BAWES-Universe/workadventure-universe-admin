/**
 * Before this on Home: the room you were in just before, found from your own visits whether or not Orbit knows the
 * room you're in now (the start map often isn't one of Orbit's rooms).
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({ prisma: { roomAccess: { findFirst: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/system-user', () => ({ hiddenSystemOwnerId: jest.fn(async () => null), notSystemUniverse: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/rooms/previous/route';

const findFirst = (prisma as unknown as { roomAccess: { findFirst: jest.Mock } }).roomAccess.findFirst;
const NOW = new Date('2026-10-02T20:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const test = {
  id: 'r-test',
  name: 'test',
  slug: 'test',
  description: null,
  mapUrl: null,
  world: { id: 'w-test', name: 'test', slug: 'test', universe: { id: 'u-test', name: 'test', slug: 'test' } },
  _count: { favorites: 0 },
};

const ask = (query: string) => GET(new NextRequest(`http://orbit.test/api/admin/rooms/previous?${query}`));
/** The where clause of the lookup for the room before this one (the last findFirst call). */
const previousWhere = () => findFirst.mock.calls[findFirst.mock.calls.length - 1][0].where;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  findFirst.mockReset();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u-1', uuid: 'uuid-1' });
});
afterEach(() => jest.useRealTimers());

describe('GET /api/admin/rooms/previous', () => {
  it('finds the room you just left on a map Orbit doesn’t know, looking back an hour from now', async () => {
    findFirst.mockResolvedValueOnce({ accessedAt: minutesAgo(1), room: test });
    const response = await ask(`playUri=${encodeURIComponent('https://play.example.com/@/default/default/default')}`);
    expect((await response.json()).room.id).toBe('r-test');
    // No arrival to look up: the only query is the one for the room before.
    expect(findFirst).toHaveBeenCalledTimes(1);
    const where = previousWhere();
    expect(where.roomId).toBeUndefined();
    expect(where.accessedAt).toEqual({ gte: minutesAgo(60), lte: NOW });
  });

  it('finds the room you left even when it was logged a moment after you arrived here', async () => {
    findFirst
      .mockResolvedValueOnce({ accessedAt: minutesAgo(2) }) // arriving here
      .mockResolvedValueOnce({ accessedAt: minutesAgo(1), room: test }); // the room before, logged late
    const response = await ask('currentRoomId=r-start&playUri=x');
    expect((await response.json()).room.id).toBe('r-test');
    const where = previousWhere();
    expect(where.roomId).toEqual({ not: 'r-start' });
    expect(where.accessedAt).toEqual({ gte: minutesAgo(62), lte: NOW });
  });

  it('looks back from now when your last arrival here is hours old (a visit that failed to log)', async () => {
    findFirst.mockResolvedValueOnce({ accessedAt: minutesAgo(300) }).mockResolvedValueOnce(null);
    const response = await ask('currentRoomId=r-start');
    expect((await response.json()).room).toBeNull();
    expect(previousWhere().accessedAt).toEqual({ gte: minutesAgo(60), lte: NOW });
  });

  it('needs to know where you are', async () => {
    expect((await ask('')).status).toBe(400);
  });
});
