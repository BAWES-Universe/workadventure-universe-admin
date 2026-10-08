/**
 * GET /api/live: signed-in only; `{ available: false }` when the game can't say.
 */
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/live-presence', () => ({ fetchPresenceSnapshot: jest.fn(), buildLiveView: jest.fn() }));

import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { buildLiveView, fetchPresenceSnapshot } from '@/lib/live-presence';
import { GET } from '@/app/api/live/route';

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
