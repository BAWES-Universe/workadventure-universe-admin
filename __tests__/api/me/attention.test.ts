import { NextRequest } from 'next/server';
import { GET, OPTIONS } from '@/app/api/me/attention/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

type Invitation = { id: string; invitedUserId: string; status: string };
const invitations: Invitation[] = [];
const preferences: { userId: string; key: string; value: unknown }[] = [];

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    membershipInvitation: {
      findMany: jest.fn(async ({ where }: { where: { invitedUserId: string; status: string } }) =>
        invitations.filter((row) => row.invitedUserId === where.invitedUserId && row.status === where.status)
          .map(({ id }) => ({ id }))),
    },
    userPreference: {
      findUnique: jest.fn(async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => {
        const row = preferences.find((item) => item.userId === where.userId_key.userId && item.key === where.userId_key.key);
        return row ? { value: row.value } : null;
      }),
    },
  },
}));

const BASE = 'http://localhost:3333/api/me/attention';
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

function get(headers: Record<string, string> = {}) {
  return GET(new NextRequest(BASE, { headers }));
}

describe('/api/me/attention', () => {
  beforeEach(() => {
    invitations.length = 0;
    preferences.length = 0;
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
  });

  it('returns 401 when signed out', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(prisma.membershipInvitation.findMany).not.toHaveBeenCalled();
  });

  it('counts only the caller’s pending invitations', async () => {
    invitations.push(
      { id: 'i1', invitedUserId: 'user-a', status: 'pending' },
      { id: 'i2', invitedUserId: 'user-a', status: 'pending' },
      { id: 'i3', invitedUserId: 'user-a', status: 'accepted' },
      { id: 'i4', invitedUserId: 'user-b', status: 'pending' },
    );
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ count: 2, invitations: 2 });
  });

  it('leaves out invitations dismissed on Orbit home, and ignores a malformed dismissal', async () => {
    invitations.push(
      { id: 'i1', invitedUserId: 'user-a', status: 'pending' },
      { id: 'i2', invitedUserId: 'user-a', status: 'pending' },
    );
    preferences.push({ userId: 'user-a', key: 'guidance.dismissed.invitations', value: { ids: ['i1', 7] } });
    expect(await (await get()).json()).toEqual({ count: 1, invitations: 1 });

    preferences[0].value = 'not a list';
    expect(await (await get()).json()).toEqual({ count: 2, invitations: 2 });
  });

  it('allows the game origin but not other origins, and never answers with *', async () => {
    const game = await get({ Origin: 'http://play.workadventure.localhost' });
    expect(game.status).toBe(200);
    expect(game.headers.get('Access-Control-Allow-Origin')).toBe('http://play.workadventure.localhost');

    const evil = await get({ Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(getSessionUser).toHaveBeenCalledTimes(1);

    const preflight = await OPTIONS(new NextRequest(BASE, { method: 'OPTIONS', headers: { Origin: 'http://play.workadventure.localhost' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');

    const badPreflight = await OPTIONS(new NextRequest(BASE, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(badPreflight.status).toBe(403);
  });
});
