import { NextRequest } from 'next/server';
import { GET as getPassport } from '@/app/api/me/passport/route';
import { GET as getActivity } from '@/app/api/me/activity/route';
import { getSessionUser } from '@/lib/auth-session';
import { loadActivity } from '@/lib/activity';
import { loadPassport } from '@/lib/passport';
import { prisma } from '@/lib/db';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/passport', () => ({ loadPassport: jest.fn() }));
jest.mock('@/lib/activity', () => ({ loadActivity: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { userPreference: { findMany: jest.fn() } } }));

const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const request = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3333/api/me/${path}`, { headers });

beforeEach(() => {
  jest.resetAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
  (prisma.userPreference.findMany as jest.Mock).mockResolvedValue([]);
});

describe('/api/me/passport', () => {
  it('gives the caller their own passport, every world, and Everyone until they choose', async () => {
    (loadPassport as jest.Mock).mockResolvedValue({ stamps: [], worlds: 0, universes: 0, since: null, days: 0 });
    const response = await getPassport(request('passport'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ audience: 'everyone', passport: { worlds: 0 } });
    expect(loadPassport).toHaveBeenCalledWith('user-a', { owner: true });
  });

  it('says who they show it to', async () => {
    (loadPassport as jest.Mock).mockResolvedValue({ stamps: [], worlds: 0, universes: 0, since: null, days: 0 });
    (prisma.userPreference.findMany as jest.Mock).mockResolvedValue([{ key: 'people.sharePassport', value: 'friends' }]);
    expect((await (await getPassport(request('passport'))).json()).audience).toBe('friends');
  });

  it('wants someone signed in, and the right origin', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await getPassport(request('passport'))).status).toBe(401);
    expect((await getPassport(request('passport', { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(loadPassport).not.toHaveBeenCalled();
  });

  it('answers 500, not a stack, when it cannot load', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (loadPassport as jest.Mock).mockRejectedValue(new Error('db'));
    const response = await getPassport(request('passport'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('/api/me/activity', () => {
  it('gives the caller their own events', async () => {
    (loadActivity as jest.Mock).mockResolvedValue([{ id: 'x', kind: 'star', text: 'You starred HQ', at: '2026-10-01T00:00:00.000Z', href: null }]);
    const response = await getActivity(request('activity'));
    expect(response.status).toBe(200);
    expect((await response.json()).events).toHaveLength(1);
    expect(loadActivity).toHaveBeenCalledWith('user-a');
  });

  it('wants someone signed in, and the right origin', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await getActivity(request('activity'))).status).toBe(401);
    expect((await getActivity(request('activity', { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(loadActivity).not.toHaveBeenCalled();
  });
});
