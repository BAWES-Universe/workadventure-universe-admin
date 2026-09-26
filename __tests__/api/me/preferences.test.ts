import { NextRequest } from 'next/server';
import { GET, OPTIONS, PUT } from '@/app/api/me/preferences/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

type Row = { userId: string; key: string; value: unknown; updatedAt: Date };
const rows: Row[] = [];

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    userPreference: {
      findMany: jest.fn(async ({ where }: { where: { userId: string; key?: string } }) =>
        rows.filter((row) => row.userId === where.userId && (where.key === undefined || row.key === where.key))
          .map(({ key, value }) => ({ key, value }))),
      upsert: jest.fn(async ({ where, create, update }: {
        where: { userId_key: { userId: string; key: string } };
        create: { userId: string; key: string; value: unknown };
        update: { value: unknown };
      }) => {
        const existing = rows.find((row) => row.userId === where.userId_key.userId && row.key === where.userId_key.key);
        if (existing) {
          existing.value = update.value;
          existing.updatedAt = new Date();
          return { key: existing.key, value: existing.value, updatedAt: existing.updatedAt };
        }
        const row = { ...create, updatedAt: new Date() };
        rows.push(row);
        return { key: row.key, value: row.value, updatedAt: row.updatedAt };
      }),
    },
  },
}));

const BASE = 'http://localhost:3333/api/me/preferences';
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

function put(body: unknown, headers: Record<string, string> = {}) {
  return PUT(new NextRequest(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function get(query = '', headers: Record<string, string> = {}) {
  return GET(new NextRequest(`${BASE}${query}`, { headers }));
}

describe('/api/me/preferences', () => {
  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
  });

  it('returns 401 when signed out, for both GET and PUT', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await put({ key: 'orbit.introSeen', value: true })).status).toBe(401);
    expect(prisma.userPreference.findMany).not.toHaveBeenCalled();
    expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
  });

  it('GET returns what PUT stored', async () => {
    expect((await put({ key: 'orbit.introSeen', value: true })).status).toBe(200);
    expect((await put({ key: 'guidance.dismissed.first-room', value: { at: 1 } })).status).toBe(200);
    expect((await put({ key: 'orbit.introSeen', value: false })).status).toBe(200);

    const all = await get();
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({
      preferences: { 'orbit.introSeen': false, 'guidance.dismissed.first-room': { at: 1 } },
    });

    const one = await get('?key=guidance.dismissed.first-room');
    expect(await one.json()).toEqual({ preferences: { 'guidance.dismissed.first-room': { at: 1 } } });
  });

  it('only ever touches the session user rows, ignoring any userId in body or query', async () => {
    rows.push({ userId: 'user-b', key: 'orbit.introSeen', value: 'b-secret', updatedAt: new Date() });

    const written = await put({ key: 'orbit.introSeen', value: true, userId: 'user-b' });
    expect(written.status).toBe(200);
    expect(prisma.userPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_key: { userId: 'user-a', key: 'orbit.introSeen' } },
      create: { userId: 'user-a', key: 'orbit.introSeen', value: true },
    }));
    expect(rows.find((row) => row.userId === 'user-b')?.value).toBe('b-secret');

    const read = await get('?userId=user-b');
    expect(await read.json()).toEqual({ preferences: { 'orbit.introSeen': true } });
    expect(prisma.userPreference.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));
  });

  it.each([
    'orbit.somethingElse',
    'guidance.dismissed.',
    'guidance.dismissed.../x',
    'guidance.dismissed.has space',
    `guidance.dismissed.${'a'.repeat(65)}`,
    '__proto__',
  ])('rejects unknown key %p with 400', async (key) => {
    expect((await put({ key, value: true })).status).toBe(400);
    expect((await get(`?key=${encodeURIComponent(key)}`)).status).toBe(400);
    expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    expect(prisma.userPreference.findMany).not.toHaveBeenCalled();
  });

  it('rejects an oversized value', async () => {
    const response = await put({ key: 'quests.invitationDeclined', value: 'x'.repeat(2100) });
    expect(response.status).toBe(413);
    expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
  });

  it('rejects a missing value and invalid JSON', async () => {
    expect((await put({ key: 'orbit.introSeen' })).status).toBe(400);
    expect((await put('{not json')).status).toBe(400);
  });

  it('allows the game origin but not other origins, and never answers with *', async () => {
    const game = await get('', { Origin: 'http://play.workadventure.localhost' });
    expect(game.status).toBe(200);
    expect(game.headers.get('Access-Control-Allow-Origin')).toBe('http://play.workadventure.localhost');

    const evil = await put({ key: 'orbit.introSeen', value: true }, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const preflight = await OPTIONS(new NextRequest(BASE, { method: 'OPTIONS', headers: { Origin: 'http://play.workadventure.localhost' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PUT');

    const badPreflight = await OPTIONS(new NextRequest(BASE, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(badPreflight.status).toBe(403);
  });
});
