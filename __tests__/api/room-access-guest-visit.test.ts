/**
 * What a visit keeps about a guest: the name they typed (`name`) and the Woka they picked (`characterTextureIds`), so
 * Recent visitors and the Visitors list can show them as they chose. A person with an account keeps their own outfit
 * on the account, so no outfit is copied onto their visits.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn().mockResolvedValue(null) },
    userAvatar: { findUnique: jest.fn().mockResolvedValue(null) },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn() },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn().mockResolvedValue({ isAuthenticated: false }) }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn(async (_prisma: unknown, ids: string[]) => ({ valid: ids.every((id) => id !== 'bad'), textures: ids.map((id) => ({ id })) })),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: () => false }));

import { prisma } from '@/lib/db';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

async function enter(query: string) {
  const url = `http://localhost/api/room/access?${query}&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});
beforeEach(() => {
  jest.clearAllMocks();
  db.world.findFirst.mockResolvedValue({ id: 'w', universeId: 'un', isPublic: true, universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'someone' } });
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
  db.user.findFirst.mockResolvedValue(null);
});

describe('GET /api/room/access, what a guest visit keeps', () => {
  it('saves the typed name and the Woka the guest picked, with the visit', async () => {
    const body = await enter('userIdentifier=guest-uuid&name=Nova&characterTextureIds[]=body1&characterTextureIds[]=hair2');
    expect(body.status).toBe('ok');
    const saved = db.roomAccess.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ userUuid: 'guest-uuid', userId: null, userName: 'Nova', isGuest: true, textureIds: ['body1', 'hair2'] });
  });

  it('keeps no outfit for a Woka that does not check out, and still saves the visit', async () => {
    await enter('userIdentifier=guest-uuid&name=Nova&characterTextureIds[]=bad');
    expect(db.roomAccess.create.mock.calls[0][0].data).toMatchObject({ userName: 'Nova', textureIds: [] });
  });

  it('saves a visit with no name and no Woka as it always did', async () => {
    await enter('userIdentifier=guest-uuid');
    expect(db.roomAccess.create.mock.calls[0][0].data).toMatchObject({ userName: null, textureIds: [] });
  });

  it("does not copy the outfit onto a signed-in person's visit: their account has it", async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u1', uuid: 'member-uuid', email: 'm@example.test', name: 'Mona', isGuest: false });
    db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags: ['member'] });
    await enter('userIdentifier=member-uuid&characterTextureIds[]=body1');
    expect(db.roomAccess.create.mock.calls[0][0].data).toMatchObject({ userId: 'u1', textureIds: [] });
  });
});
