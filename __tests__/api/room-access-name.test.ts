/**
 * The name picked in the game is a person's name everywhere: entering a room never puts the sign-in name back over
 * it. The sign-in name is only used when the account has no name yet.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn().mockResolvedValue(null) },
    userAvatar: { findUnique: jest.fn().mockResolvedValue(null) },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn().mockResolvedValue(null) },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn().mockResolvedValue({ valid: true, textures: [] }),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SIGN_IN = { isAuthenticated: true, identifier: 'khalid-uuid', email: 'khalid@example.test', name: 'Khalid Al-Mutawa' };

async function enter() {
  const url = `http://localhost/api/room/access?userIdentifier=khalid-uuid&accessToken=token&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

const userUpdates = () => db.user.update.mock.calls.map(([args]) => args.data);

beforeEach(() => {
  jest.clearAllMocks();
  (authenticateRequest as jest.Mock).mockResolvedValue(SIGN_IN);
  db.world.findFirst.mockResolvedValue({
    id: 'w',
    universeId: 'un',
    isPublic: true,
    universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'owner' },
  });
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
  db.user.update.mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));
});

let existing: { id: string; uuid: string; email: string | null; name: string | null; isGuest: boolean; matrixChatId: null };

describe('GET /api/room/access, the name', () => {
  it('keeps the name picked in the game when the person enters a room again', async () => {
    existing = { id: 'u1', uuid: 'khalid-uuid', email: 'khalid@example.test', name: 'Khal', isGuest: false, matrixChatId: null };
    db.user.findFirst.mockResolvedValue(existing);

    const body = await enter();

    expect(body.status).toBe('ok');
    expect(userUpdates().some((data) => 'name' in data)).toBe(false);
    expect(body.username).toBe('Khal');
  });

  it('still takes the sign-in name for an account that has no name yet', async () => {
    existing = { id: 'u1', uuid: 'khalid-uuid', email: 'khalid@example.test', name: null, isGuest: false, matrixChatId: null };
    db.user.findFirst.mockResolvedValue(existing);

    await enter();

    expect(userUpdates()).toContainEqual(expect.objectContaining({ name: 'Khalid Al-Mutawa' }));
  });

  it('takes the sign-in name for an account created on the first entry', async () => {
    db.user.findFirst.mockResolvedValue(null);
    db.user.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'u2', matrixChatId: null, isGuest: false, ...data }),
    );

    await enter();

    expect(db.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ uuid: 'khalid-uuid', name: 'Khalid Al-Mutawa' }) });
  });
});
