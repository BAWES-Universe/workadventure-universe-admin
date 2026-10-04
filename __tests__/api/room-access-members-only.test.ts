/**
 * Members-only places: /api/room/access lets someone into a room only when the room, its world and its universe are
 * all public, or they own the universe, are a member of the world, are a super admin, or are one of the room's bots.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn() },
    userAvatar: { findUnique: jest.fn().mockResolvedValue(null) },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn() },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn().mockResolvedValue({ isAuthenticated: false }) }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn().mockResolvedValue({ valid: true, textures: [] }),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'root@example.test' }));

import { prisma } from '@/lib/db';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const USERS: Record<string, { id: string; uuid: string; email: string; name: string; isGuest: boolean }> = {
  'uuid-owner': { id: 'u-owner', uuid: 'uuid-owner', email: 'owner@example.test', name: 'Owner', isGuest: false },
  'uuid-member': { id: 'u-member', uuid: 'uuid-member', email: 'm@example.test', name: 'Member', isGuest: false },
  'uuid-stranger': { id: 'u-stranger', uuid: 'uuid-stranger', email: 's@example.test', name: 'Stranger', isGuest: false },
  'uuid-root': { id: 'u-root', uuid: 'uuid-root', email: 'root@example.test', name: 'Root', isGuest: false },
};
const BOT = 'bot-11111111-2222-4333-8444-555555555555';

function place({ room = true, world = true, universe = true }) {
  db.world.findFirst.mockResolvedValue({
    id: 'w',
    universeId: 'un',
    isPublic: world,
    universe: { id: 'un', slug: 'uni', isPublic: universe, ownerId: 'u-owner' },
  });
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: room });
}

async function enter(userIdentifier: string) {
  const url = `http://localhost/api/room/access?userIdentifier=${userIdentifier}&playUri=${encodeURIComponent(
    'http://play.test/@/uni/world/room',
  )}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  const body = await (await roomAccess(request)).json();
  return body.status === 'ok' ? 'ok' : body.code;
}

describe('GET /api/room/access, members-only places', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-token';
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findFirst.mockImplementation(({ where }) => Promise.resolve(USERS[where.OR[0].uuid] ?? null));
    db.worldMember.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.userId_worldId.userId === 'u-member' ? { id: 'm', tags: ['member'] } : null),
    );
    db.bot.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(where.id === BOT.slice(4) && where.roomId === 'r' ? { id: where.id } : null),
    );
  });

  it('lets everyone into an open room', async () => {
    place({});
    expect(await enter('guest-123')).toBe('ok');
    expect(await enter('uuid-stranger')).toBe('ok');
  });

  it.each([
    ['a private room', { room: false }],
    ['a room in a private world', { world: false }],
    ['a room in a private universe', { universe: false }],
  ])('keeps guests and strangers out of %s', async (_label, visibility) => {
    place(visibility);
    expect(await enter('guest-123')).toBe('MEMBERS_ONLY');
    expect(await enter('uuid-stranger')).toBe('MEMBERS_ONLY');
    expect(db.roomAccess.create).not.toHaveBeenCalled();
  });

  it.each(['uuid-member', 'uuid-owner', 'uuid-root'])('lets %s into a members-only room', async (who) => {
    place({ world: false });
    expect(await enter(who)).toBe('ok');
  });

  it("lets only the room's own bots into a members-only room", async () => {
    place({ room: false });
    expect(await enter(BOT)).toBe('ok');
    expect(await enter('bot-99999999-2222-4333-8444-555555555555')).toBe('MEMBERS_ONLY');
  });
});
