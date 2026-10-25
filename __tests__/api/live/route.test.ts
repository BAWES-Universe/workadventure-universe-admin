/**
 * GET /api/live: signed-in only; `{ available: false }` when the game can't say.
 */
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/live-presence', () => ({ fetchPresenceSnapshot: jest.fn(), buildLiveView: jest.fn() }));

import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { buildLiveView, fetchPresenceSnapshot } from '@/lib/live-presence';
import { GET, OPTIONS } from '@/app/api/live/route';

const request = () => new NextRequest('http://orbit.test/api/live');
const me = { id: 'u-me', uuid: 'me', email: null, name: 'Me', tags: [], isSuperAdmin: false };

beforeEach(() => jest.clearAllMocks());

it('asks you to sign in', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
  expect(fetchPresenceSnapshot).not.toHaveBeenCalled();
});

it('says Live now is unavailable when the game has no answer', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue(me);
  (fetchPresenceSnapshot as jest.Mock).mockResolvedValue(null);
  const response = await GET(request());
  expect(await response.json()).toEqual({ available: false });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

it('answers with what you may see', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue(me);
  const snapshot = { generatedAt: 1, users: [], rooms: {} };
  (fetchPresenceSnapshot as jest.Mock).mockResolvedValue(snapshot);
  (buildLiveView as jest.Mock).mockResolvedValue({ available: true, generatedAt: 1, places: [], people: [] });
  const response = await GET(request());
  expect(buildLiveView).toHaveBeenCalledWith(snapshot, me);
  expect((await response.json()).available).toBe(true);
});

describe('from the game', () => {
  const PLAY = 'https://play.example';
  const saved = process.env.NEXT_PUBLIC_PLAY_URL;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_PLAY_URL = PLAY;
  });
  afterAll(() => {
    process.env.NEXT_PUBLIC_PLAY_URL = saved;
  });
  const from = (origin: string, method = 'GET') => new NextRequest('http://orbit.test/api/live', { method, headers: { Origin: origin } });

  it("answers the game's own origin, with its CORS headers", async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(me);
    (fetchPresenceSnapshot as jest.Mock).mockResolvedValue({ generatedAt: 1, users: [], rooms: {} });
    (buildLiveView as jest.Mock).mockResolvedValue({ available: true, generatedAt: 1, places: [], people: [] });
    const response = await GET(from(PLAY));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PLAY);
    expect((await OPTIONS(from(PLAY, 'OPTIONS'))).status).toBe(204);
  });

  it('refuses any other origin before reading anything', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(me);
    expect((await GET(from('https://evil.example'))).status).toBe(403);
    expect((await OPTIONS(from('https://evil.example', 'OPTIONS'))).status).toBe(403);
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(fetchPresenceSnapshot).not.toHaveBeenCalled();
  });
});
