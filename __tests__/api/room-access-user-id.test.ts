/**
 * /api/room/access gives the game Orbit's own id for a verified account (User.id), so the game can tell PostHog who
 * someone is without their email. An identifier somebody only claimed gets none (#408).
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn(), update: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn() },
    role: { findUnique: jest.fn() },
    universeMember: { findUnique: jest.fn() },
    userAvatar: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn() },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/user-outfits', () => ({ currentOutfit: jest.fn().mockResolvedValue(null), recordOutfitPick: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/woka-wearable', () => ({
  wearableHere: jest.fn().mockResolvedValue({ wearable: true }),
  companionWearableHere: jest.fn().mockResolvedValue({ wearable: true }),
}));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn().mockResolvedValue({ valid: true, textures: [] }),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const PERSON = { id: 'u-sara', uuid: 'uuid-sara', email: 'sara@example.test', name: 'Sara', isGuest: false };

async function enter(withToken: boolean) {
  const url = `http://localhost/api/room/access?userIdentifier=${PERSON.uuid}&playUri=${encodeURIComponent(
    'http://play.test/@/uni/world/room',
  )}${withToken ? '&accessToken=signed-in-token' : ''}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

describe('GET /api/room/access, userId', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-token';
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findFirst.mockResolvedValue(PERSON);
    db.user.update.mockResolvedValue(PERSON);
    db.world.findFirst.mockResolvedValue({
      id: 'w',
      universeId: 'un',
      isPublic: true,
      universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'u-owner' },
    });
    db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
    db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags: [] });
    db.universeMember.findUnique.mockResolvedValue(null);
    db.role.findUnique.mockResolvedValue({ key: 'everyone', permissions: BigInt(512) });
  });

  it("sends the account's own id, which is neither its uuid nor its email", async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: true, identifier: PERSON.uuid, email: PERSON.email });
    const body = await enter(true);
    expect(body.userId).toBe('u-sara');
    expect(body.userId).not.toBe(body.userUuid);
    expect(body.userId).not.toBe(body.email);
  });

  it('sends no id for an identifier whose token could not be checked', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: false });
    const body = await enter(false);
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('userId');
  });

  it('sends no id for a guest who only presents their guest identifier', async () => {
    const guest = { id: 'u-guest', uuid: 'guest-uuid', email: null, name: null, isGuest: true };
    db.user.findFirst.mockResolvedValue(guest);
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: false });
    const url = `http://localhost/api/room/access?userIdentifier=${guest.uuid}&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}`;
    const body = await (await roomAccess(new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }))).json();
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('userId');
  });
});
