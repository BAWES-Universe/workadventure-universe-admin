import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/admin/users/[id]/connect/route';
import { addUser, db } from '../../helpers/friends-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/friends-db').fakePrisma }));

const mockSessionUser = jest.fn();
jest.mock('@/lib/auth-session', () => ({ getSessionUser: (request: unknown) => mockSessionUser(request) }));

const URL_BASE = 'http://localhost:3333/api/admin/users';

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function signedInAs(id: string | null) {
  mockSessionUser.mockResolvedValue(id ? { id, uuid: `uuid-${id}`, email: `${id}@test`, name: id, tags: [], isSuperAdmin: false } : null);
}

async function read(id: string) {
  const res = await GET(new NextRequest(`${URL_BASE}/${id}/connect`), params(id));
  return { status: res.status, body: await res.json() };
}

async function act(id: string, action: unknown) {
  const res = await POST(
    new NextRequest(`${URL_BASE}/${id}/connect`, { method: 'POST', body: JSON.stringify({ action }), headers: { 'Content-Type': 'application/json' } }),
    params(id),
  );
  return { status: res.status, body: await res.json() };
}

describe('/api/admin/users/[id]/connect', () => {
  beforeEach(() => {
    db.reset();
    jest.clearAllMocks();
    addUser('a', 'Alice');
    addUser('b', 'Bilal');
    addUser('g', 'Guest', { isGuest: true });
    signedInAs('a');
  });

  it('needs a signed-in session', async () => {
    signedInAs(null);
    expect((await read('b')).status).toBe(401);
    expect((await act('b', 'request')).status).toBe(401);
  });

  it('says how you stand and gives their chat address, never their email', async () => {
    const { status, body } = await read('b');
    expect(status).toBe(200);
    expect(body).toEqual({ available: true, relationship: 'none', chatId: '@b:chat' });
  });

  it('is not available for yourself, a guest or someone who is gone', async () => {
    expect((await read('a')).body).toEqual({ available: false });
    expect((await read('g')).body).toEqual({ available: false });
    expect((await read('missing')).body).toEqual({ available: false });
    expect((await act('g', 'request')).status).toBe(403);
  });

  it('is not available to a guest viewer', async () => {
    signedInAs('g');
    expect((await read('b')).body).toEqual({ available: false });
    expect((await act('b', 'request')).status).toBe(403);
  });

  it('walks request, cancel, request, then the other side accepts and either can remove', async () => {
    expect((await act('b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect((await read('b')).body.relationship).toBe('request_sent');
    expect((await act('b', 'cancel')).body).toEqual({ relationship: 'none' });
    await act('b', 'request');

    signedInAs('b');
    expect((await read('a')).body.relationship).toBe('request_received');
    expect((await act('a', 'accept')).body).toEqual({ relationship: 'friends' });

    signedInAs('a');
    expect((await act('b', 'remove')).body).toEqual({ relationship: 'none' });
  });

  it('hides the chat address once either of you has blocked the other', async () => {
    db.friendships.push({ id: 'f1', user1Id: 'a', user2Id: 'b', status: 'blocked', requestedById: 'b', createdAt: new Date(), acceptedAt: null });
    expect((await read('b')).body).toEqual({ available: true, relationship: 'blocked_by_them', chatId: null });
    expect((await act('b', 'request')).body).toEqual({ error: 'blocked' });
  });

  it('only does the four steps the profile shows', async () => {
    expect((await act('b', 'block')).status).toBe(400);
    expect((await act('b', 'unblock')).status).toBe(400);
    expect((await act('b', 42)).status).toBe(400);
    expect(db.friendships).toHaveLength(0);
  });

  it('passes on the game’s rules for requests', async () => {
    db.preferences.push({ userId: 'b', key: 'people.friendRequestsFrom', value: 'nobody' });
    const { status, body } = await act('b', 'request');
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'not_accepting_requests' });
  });
});
