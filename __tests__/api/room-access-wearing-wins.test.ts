/**
 * Wearing wins: a signed-in person's latest outfit (picked in any world) follows them into every world that allows it
 * and where they have no outfit saved yet, and is saved for that world too. An outfit saved for a world is never
 * replaced. Where it isn't allowed, the outfit saved for the world they enter (else the one the game sent) is used as
 * before. Guests and bots never get this.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn(), update: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn().mockResolvedValue(null) },
    userAvatar: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn() },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn() },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  // Outfits whose ids start with "no-" are not allowed here
  resolveTextureUrls: jest.fn(async (_prisma: unknown, ids: string[]) => ({
    valid: ids.length > 0 && ids.every((id) => !id.startsWith('no-')),
    textures: ids.map((id) => ({ id, url: `https://play.test/${id}.png` })),
  })),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: () => false }));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { resolveTextureUrls } from '@/lib/avatar-catalog-validator';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PERSON = { id: 'u1', uuid: 'person-uuid', email: 'p@example.test', name: 'Pat', isGuest: false };
const BOT = 'bot-11111111-2222-4333-8444-555555555555';

async function enter(who: string, { signedIn = true, sent = ['sent1'] } = {}) {
  (authenticateRequest as jest.Mock).mockResolvedValue(
    signedIn ? { isAuthenticated: true, identifier: who, email: PERSON.email } : { isAuthenticated: false },
  );
  const textures = sent.map((id) => `&characterTextureIds[]=${id}`).join('');
  const url = `http://localhost/api/room/access?userIdentifier=${who}${textures}&playUri=${encodeURIComponent(
    'http://play.test/@/uni/world-b/room',
  )}${signedIn ? '&accessToken=token' : ''}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

const ids = (body: { characterTextures: { id: string }[] }) => body.characterTextures.map((texture) => texture.id);

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});
beforeEach(() => {
  jest.clearAllMocks();
  db.world.findFirst.mockResolvedValue({ id: 'world-b', universeId: 'un', isPublic: true, universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'someone' } });
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
  db.user.findFirst.mockResolvedValue(PERSON);
  db.user.update.mockImplementation(({ data }) => Promise.resolve({ ...PERSON, ...data }));
  db.bot.findFirst.mockResolvedValue({ id: BOT.slice(4) });
  // Saved for world B (tests of a world with nothing saved override this)
  db.userAvatar.findUnique.mockResolvedValue({ userId: 'u1', worldId: 'world-b', textureIds: ['saved-b'], companionTextureId: null });
  db.userAvatar.findFirst.mockResolvedValue(null);
  db.userAvatar.upsert.mockResolvedValue({});
});

describe('GET /api/room/access, wearing wins', () => {
  it("brings the latest outfit from another world into a world with none saved, and saves it for this one", async () => {
    db.userAvatar.findUnique.mockResolvedValue(null);
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1', 'outfit-a2'] });
    const body = await enter(PERSON.uuid);
    expect(ids(body)).toEqual(['outfit-a1', 'outfit-a2']);
    expect(body.isCharacterTexturesValid).toBe(true);
    expect(body.characterTextureIds).toEqual(['outfit-a1', 'outfit-a2']);
    // It is checked against the world being entered, like any outfit
    expect(resolveTextureUrls).toHaveBeenCalledWith(expect.anything(), ['outfit-a1', 'outfit-a2'], 'world-b', 'un', expect.any(String));
    // Only the outfit is saved: the companion saved for this world is left alone
    expect(db.userAvatar.upsert).toHaveBeenCalledTimes(1);
    expect(db.userAvatar.upsert).toHaveBeenCalledWith({
      where: { userId_worldId: { userId: 'u1', worldId: 'world-b' } },
      create: { userId: 'u1', worldId: 'world-b', textureIds: ['outfit-a1', 'outfit-a2'], outfitUpdatedAt: expect.any(Date) },
      update: { textureIds: ['outfit-a1', 'outfit-a2'], outfitUpdatedAt: expect.any(Date) },
    });
  });

  it("keeps the outfit saved for this world, and saves nothing, when the latest pick was in another world", async () => {
    // A has Y, B has X (picked later): entering A keeps Y
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    const body = await enter(PERSON.uuid);
    expect(ids(body)).toEqual(['saved-b']);
    expect(body.characterTextureIds).toEqual(['saved-b']);
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it("treats a world whose saved outfit is empty as having none saved", async () => {
    db.userAvatar.findUnique.mockResolvedValue({ userId: 'u1', worldId: 'world-b', textureIds: [], companionTextureId: null });
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    expect(ids(await enter(PERSON.uuid))).toEqual(['outfit-a1']);
    expect(db.userAvatar.upsert).toHaveBeenCalledTimes(1);
  });

  it("looks for the latest outfit among the person's saved outfits in every world", async () => {
    db.userAvatar.findUnique.mockResolvedValue(null);
    await enter(PERSON.uuid);
    expect(db.userAvatar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }), orderBy: [{ outfitUpdatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }] }),
    );
  });

  it("never lets the textures the game sent undo the latest pick", async () => {
    db.userAvatar.findUnique.mockResolvedValue(null);
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    expect(ids(await enter(PERSON.uuid, { sent: ['stale-device-pick'] }))).toEqual(['outfit-a1']);
  });

  it("uses the outfit saved for this world when the latest one isn't allowed here, and saves nothing", async () => {
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['no-costume'] });
    const body = await enter(PERSON.uuid);
    expect(ids(body)).toEqual(['saved-b']);
    expect(body.isCharacterTexturesValid).toBe(true);
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it("falls back to the textures the game sent when the latest isn't allowed and nothing is saved here", async () => {
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['no-costume'] });
    db.userAvatar.findUnique.mockResolvedValue(null);
    expect(ids(await enter(PERSON.uuid))).toEqual(['sent1']);
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it("changes nothing when the latest outfit is the one saved for this world", async () => {
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-b', textureIds: ['saved-b'] });
    expect(ids(await enter(PERSON.uuid))).toEqual(['saved-b']);
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it("changes nothing for someone who never picked an outfit", async () => {
    db.userAvatar.findUnique.mockResolvedValue(null);
    expect(ids(await enter(PERSON.uuid))).toEqual(['sent1']);
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it("still lets them in, wearing it, when saving it for this world fails", async () => {
    db.userAvatar.findUnique.mockResolvedValue(null);
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    db.userAvatar.upsert.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await enter(PERSON.uuid);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['outfit-a1']);
    error.mockRestore();
  });

  it("still lets them in with this world's outfit when the lookup fails", async () => {
    db.userAvatar.findFirst.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await enter(PERSON.uuid);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['saved-b']);
    error.mockRestore();
  });

  it('leaves guests as they were', async () => {
    db.user.findFirst.mockResolvedValue(null);
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    const body = await enter('guest-uuid', { signedIn: false });
    expect(ids(body)).toEqual(['sent1']);
    expect(db.userAvatar.findFirst).not.toHaveBeenCalled();
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it('leaves a name that has not signed in as it was, even when it names a real person', async () => {
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    const body = await enter(PERSON.uuid, { signedIn: false });
    expect(db.userAvatar.findFirst).not.toHaveBeenCalled();
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
    expect(body.status).toBe('ok');
  });

  it('leaves bots as they were', async () => {
    db.user.findFirst.mockResolvedValue({ ...PERSON, uuid: BOT, name: 'Botty' });
    db.userAvatar.findFirst.mockResolvedValue({ worldId: 'world-a', textureIds: ['outfit-a1'] });
    const body = await enter(BOT);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['saved-b']);
    expect(db.userAvatar.findFirst).not.toHaveBeenCalled();
    expect(db.userAvatar.upsert).not.toHaveBeenCalled();
  });
});
