/** The shells that routes share, against a pretend database: what they answer when the database fails or the bot is gone. */
import { NextRequest } from 'next/server';

const findUser = jest.fn();
const findBot = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: (...args: unknown[]) => findUser(...args) }, bot: { findUnique: (...args: unknown[]) => findBot(...args) } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => ({ id: 'u1' })) }));
jest.mock('@/lib/me-route', () => ({
  meOriginAllowed: () => true,
  meRespond: (_request: unknown, body: unknown, status: number) => Response.json(body, { status }),
}));
jest.mock('@/lib/bot-memory-person', () => ({ rememberingOf: jest.fn(async () => ({ id: 'u1' })) }));

import { appsRoute } from '@/lib/me-apps-route';
import { myMemoryAuth } from '@/lib/my-memory-api';

const request = () => new NextRequest('https://orbit.example.com/api/me/apps');

describe('the apps route shell', () => {
  it('answers in its own words when the guest lookup fails, like a failure later on', async () => {
    findUser.mockRejectedValueOnce(new Error('database down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = jest.fn();
    const answer = await appsRoute(request(), 'GET', 'List', run);
    expect(answer.status).toBe(500);
    expect(await answer.json()).toEqual({ error: 'Internal server error' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('what a bot remembers about the person', () => {
  it('has no list to show for a room bot that is gone, and does for one that is there', async () => {
    findBot.mockResolvedValueOnce({ roomId: 'room-1', ownerId: null, deletedAt: new Date() });
    expect((await myMemoryAuth(request(), 'b1')).response?.status).toBe(404);
    findBot.mockResolvedValueOnce({ roomId: 'room-1', ownerId: null, deletedAt: null });
    expect((await myMemoryAuth(request(), 'b1')).who).toBeDefined();
  });
});
