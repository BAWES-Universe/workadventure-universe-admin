/**
 * Roles (#314): /api/room/access tells the game each person's permission number in the world, from their roles, and
 * whether they can open the map editor (Edit maps). When their roles can't be read, their tags decide, as before.
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
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn().mockResolvedValue({ valid: true, textures: [] }),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const PERSON = { id: 'u-sara', uuid: 'uuid-sara', email: 'sara@example.test', name: 'Sara', isGuest: false };

function roles(given: { key: string; permissions: number; allWorlds?: boolean; worldIds?: string[] }[], tags: string[]) {
  db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags });
  db.universeMember.findUnique.mockResolvedValue({
    allWorlds: false,
    worldIds: ['w'],
    roles: given.map((role) => ({
      allWorlds: role.allWorlds ?? false,
      worldIds: role.worldIds ?? ['w'],
      role: { key: role.key, position: 50, permissions: BigInt(role.permissions) },
    })),
  });
}

async function enter() {
  const url = `http://localhost/api/room/access?userIdentifier=${PERSON.uuid}&playUri=${encodeURIComponent(
    'http://play.test/@/uni/world/room',
  )}&accessToken=signed-in-token`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

describe('GET /api/room/access, permissions from roles', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-token';
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: true, identifier: PERSON.uuid, email: PERSON.email });
    db.user.findFirst.mockResolvedValue(PERSON);
    db.user.update.mockResolvedValue(PERSON);
    db.world.findFirst.mockResolvedValue({
      id: 'w',
      universeId: 'un',
      isPublic: true,
      universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'u-owner' },
    });
    db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
    db.role.findUnique.mockImplementation(({ where }) =>
      Promise.resolve({ key: where.universeId_key.key, permissions: BigInt(where.universeId_key.key === 'everyone' ? 512 : 0) }),
    );
  });

  it('sends what their roles here allow, and Everyone, with the tags as before', async () => {
    // Moderate calls (2048) from a custom role, Send messages (512) from Everyone
    roles([{ key: 'moderator', permissions: 2048 }], ['moderator', 'member']);
    const body = await enter();
    expect(body.permissions).toBe(String(2048 | 512));
    expect(body.tags).toEqual(['moderator', 'member']);
    expect(body.canEdit).toBe(false);
  });

  it('lets them open the map editor when a role has Edit maps', async () => {
    roles([{ key: 'editor', permissions: 8416 }], ['editor', 'member']);
    const body = await enter();
    expect(body.canEdit).toBe(true);
  });

  it('follows the role, not the tag: an Editor whose Edit maps was switched off cannot edit', async () => {
    roles([{ key: 'editor', permissions: 8416 - 128 }], ['editor', 'member']);
    const body = await enter();
    expect(body.canEdit).toBe(false);
  });

  it('leaves out a role limited to other worlds', async () => {
    roles([{ key: 'admin', permissions: 16383, worldIds: ['elsewhere'] }], ['member']);
    const body = await enter();
    expect(body.permissions).toBe('512');
    expect(body.canEdit).toBe(false);
  });

  it('reads the tags of a world member with no universe membership', async () => {
    db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags: ['admin'] });
    db.universeMember.findUnique.mockResolvedValue(null);
    const body = await enter();
    expect(body.permissions).toBe(String(16383 | 512));
    expect(body.canEdit).toBe(true);
  });

  it('falls back to the tags when roles cannot be read', async () => {
    db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags: ['editor'] });
    db.role.findUnique.mockRejectedValue(new Error('database down'));
    const body = await enter();
    expect(body.status).toBe('ok');
    expect(body.permissions).toBe('8416');
    expect(body.canEdit).toBe(true);
  });
  it('never hands the roles or tags of the account an unchecked identifier names to whoever sent it', async () => {
    // No token: the identifier in the address is only what the caller sent
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: false });
    roles([{ key: 'admin', permissions: 16383 }], ['admin', 'member']);
    const url = `http://localhost/api/room/access?userIdentifier=${PERSON.uuid}&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}`;
    const body = await (await roomAccess(new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }))).json();
    expect(body.status).toBe('ok');
    expect(body.permissions).toBe('512');
    expect(body.tags).toEqual([]);
    expect(body.canEdit).toBe(false);
    expect(db.universeMember.findUnique).not.toHaveBeenCalled();
  });

  it('gives an unchecked identifier only Everyone when roles cannot be read, never its tags', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: true, identifier: PERSON.uuid, email: PERSON.email });
    (authenticateRequest as jest.Mock).mockResolvedValueOnce({ isAuthenticated: false });
    db.worldMember.findUnique.mockResolvedValue({ id: 'm', tags: ['editor'] });
    db.role.findUnique.mockRejectedValue(new Error('database down'));
    const url = `http://localhost/api/room/access?userIdentifier=${PERSON.uuid}&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}&accessToken=stale`;
    const body = await (await roomAccess(new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }))).json();
    expect(body.permissions).toBe('0');
    expect(body.tags).toEqual([]);
    expect(body.canEdit).toBe(false);
  });
});
