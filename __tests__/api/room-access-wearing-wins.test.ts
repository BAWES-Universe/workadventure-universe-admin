/**
 * Wearing wins: a signed-in person's latest outfit (picked in any world) follows them into every world that allows it,
 * and is saved for that world too, replacing a standard outfit saved there. A custom Woka saved for the world they enter
 * (one only a universe's or a world's own set has) stays as saved. Where the latest isn't allowed, the outfit saved for
 * the world they enter (else the one the game sent) is used as before. Guests and bots never get this.
 */
import { NextRequest } from 'next/server';

// What the person has saved, one outfit per world, newest picked first (the real query sorts them).
const mockSaved: { userId: string; worldId: string; textureIds: string[] }[] = [];

// The catalog: `std-*` and `sy`/`sx` parts are in a set for the whole platform; `cost-*`, `ucost-*` and `hat-*` only in a
// world's or a universe's own set; `archived-*` in a set that was archived. ("male1" is in the game's own list.)
const platform = { lifecycle: 'active', scopes: [{ scopeType: 'platform' }] };
const own = (scopeType: string) => ({ lifecycle: 'active', scopes: [{ scopeType }] });
const mockLayers = [
  ...['std-y', 'std-x', 'std-s1', 'std-s2', 'std-old', 'std-body'].map((textureId) => ({ textureId, url: `https://play.test/${textureId}.png`, avatarSet: platform })),
  { textureId: 'cost-c1', url: 'https://play.test/cost-c1.png', avatarSet: own('world') },
  { textureId: 'ucost-c1', url: 'https://play.test/ucost-c1.png', avatarSet: own('universe') },
  { textureId: 'hat-c1', url: 'https://play.test/hat-c1.png', avatarSet: own('world') },
  { textureId: 'archived-c1', url: 'https://play.test/archived-c1.png', avatarSet: { lifecycle: 'archived', scopes: [{ scopeType: 'world' }] } },
];

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn(), update: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn().mockResolvedValue(null) },
    userAvatar: {
      findUnique: jest.fn(async ({ where }: { where: { userId_worldId: { userId: string; worldId: string } } }) => {
        const row = mockSaved.find((saved) => saved.userId === where.userId_worldId.userId && saved.worldId === where.userId_worldId.worldId);
        return row ? { ...row, companionTextureId: null } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { userId: string } }) => mockSaved.filter((saved) => saved.userId === where.userId)),
      upsert: jest.fn(),
    },
    avatarLayer: {
      findMany: jest.fn(async ({ where }: { where: { textureId: { in: string[] } } }) =>
        mockLayers.filter((layer) => where.textureId.in.includes(layer.textureId)),
      ),
    },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn() },
    roomAccess: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  // Ids starting with "no-" or "archived-" are not allowed anywhere; a costume ("cost-c1", "ucost-c1", "hat-c1") only in world-c
  resolveTextureUrls: jest.fn(async (_prisma: unknown, ids: string[], worldId: string) => ({
    valid: ids.length > 0 && ids.every((id) => !id.startsWith('no-') && !id.startsWith('archived-') && (!/^(u?cost|hat)-c1$/.test(id) || worldId === 'world-c')),
    textures: ids.map((id) => ({ id, url: `https://play.test/${id}.png` })),
  })),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: () => false }));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PERSON = { id: 'u1', uuid: 'person-uuid', email: 'p@example.test', name: 'Pat', isGuest: false };
const BOT = 'bot-11111111-2222-4333-8444-555555555555';

const save = (worldId: string, ...textureIds: string[]) => mockSaved.push({ userId: 'u1', worldId, textureIds });

async function enter(who: string, { signedIn = true, sent = ['sent1'], world = 'world-b' } = {}) {
  db.world.findFirst.mockResolvedValue({ id: world, universeId: 'un', isPublic: true, universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'someone' } });
  (authenticateRequest as jest.Mock).mockResolvedValue(
    signedIn ? { isAuthenticated: true, identifier: who, email: PERSON.email } : { isAuthenticated: false },
  );
  const textures = sent.map((id) => `&characterTextureIds[]=${id}`).join('');
  const url = `http://localhost/api/room/access?userIdentifier=${who}${textures}&playUri=${encodeURIComponent(
    `http://play.test/@/uni/${world}/room`,
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
  mockSaved.length = 0;
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
  db.user.findFirst.mockResolvedValue(PERSON);
  db.user.update.mockImplementation(({ data }) => Promise.resolve({ ...PERSON, ...data }));
  db.bot.findFirst.mockResolvedValue({ id: BOT.slice(4) });
  db.userAvatar.upsert.mockResolvedValue({});
});
afterEach(() => {
  // Entering a world never saves anything: only picking a Woka does
  expect(db.userAvatar.upsert).not.toHaveBeenCalled();
});

describe('GET /api/room/access, wearing wins', () => {
  it('wears the latest Woka picked in another world, replacing a standard one saved here', async () => {
    save('world-b', 'std-x'); // picked later
    save('world-a', 'std-y');
    const body = await enter(PERSON.uuid, { world: 'world-a' });
    expect(ids(body)).toEqual(['std-x']);
    expect(body.isCharacterTexturesValid).toBe(true);
    expect(body.characterTextureIds).toEqual(['std-x']);
  });

  it('wears the everyday Woka in a world never visited, checked against that world', async () => {
    save('world-b', 'std-x');
    save('world-a', 'std-y');
    const { resolveTextureUrls } = jest.requireMock('@/lib/avatar-catalog-validator');
    const body = await enter(PERSON.uuid, { world: 'world-d' });
    expect(ids(body)).toEqual(['std-x']);
    expect(resolveTextureUrls).toHaveBeenCalledWith(expect.anything(), ['std-x'], 'world-d', 'un', expect.any(String));
  });

  it('keeps a costume saved for this world, even when a later pick was elsewhere', async () => {
    save('world-b', 'std-x'); // picked later
    save('world-c', 'cost-c1');
    expect(ids(await enter(PERSON.uuid, { world: 'world-c' }))).toEqual(['cost-c1']);
  });

  it("keeps a universe's costume saved for this world", async () => {
    save('world-b', 'std-x');
    save('world-c', 'ucost-c1');
    expect(ids(await enter(PERSON.uuid, { world: 'world-c' }))).toEqual(['ucost-c1']);
  });

  it('keeps a mixed outfit, a standard body with a costume hat, saved for this world', async () => {
    save('world-b', 'std-x');
    save('world-c', 'std-body', 'hat-c1');
    expect(ids(await enter(PERSON.uuid, { world: 'world-c' }))).toEqual(['std-body', 'hat-c1']);
  });

  it('leaves a costume world for the everyday Woka, not the older one saved in the next world and not the costume', async () => {
    save('world-c', 'cost-c1'); // newest pick: a costume
    save('world-a', 'std-s1');
    save('world-d', 'std-old'); // oldest, saved for the world being entered
    const body = await enter(PERSON.uuid, { world: 'world-d' });
    expect(ids(body)).toEqual(['std-s1']);
    expect(body.isCharacterTexturesValid).toBe(true);
  });

  it('gives the everyday Woka, not the costume, to a world with nothing saved', async () => {
    save('world-c', 'cost-c1');
    save('world-a', 'std-s1');
    const body = await enter(PERSON.uuid, { world: 'world-e' });
    expect(ids(body)).toEqual(['std-s1']);
    expect(body.isCharacterTexturesValid).toBe(true);
  });

  it('wears the everyday Woka in a costume world whose costume can no longer be used', async () => {
    save('world-c', 'archived-c1'); // its set was archived
    save('world-a', 'std-s1');
    const body = await enter(PERSON.uuid, { world: 'world-c' });
    expect(ids(body)).toEqual(['std-s1']);
    expect(body.isCharacterTexturesValid).toBe(true);
  });

  it('takes a costume off by picking a standard Woka there: it is then the everyday Woka everywhere', async () => {
    save('world-c', 'std-s2'); // newest: picked over the costume in world c
    save('world-a', 'std-s1');
    expect(ids(await enter(PERSON.uuid, { world: 'world-c' }))).toEqual(['std-s2']);
    expect(ids(await enter(PERSON.uuid, { world: 'world-a' }))).toEqual(['std-s2']);
    expect(ids(await enter(PERSON.uuid, { world: 'world-e' }))).toEqual(['std-s2']);
  });

  it('uses the logic as before for someone who only ever picked costumes', async () => {
    save('world-c', 'cost-c1');
    expect(ids(await enter(PERSON.uuid, { world: 'world-d' }))).toEqual(['sent1']);
    const refused = await enter(PERSON.uuid, { world: 'world-d', sent: ['no-way'] });
    expect(refused.isCharacterTexturesValid).toBe(false);
  });

  it("uses this world's saved outfit as before when the person has nothing but it", async () => {
    save('world-b', 'std-y');
    expect(ids(await enter(PERSON.uuid))).toEqual(['std-y']);
  });

  it('never lets the textures the game sent undo the everyday Woka', async () => {
    save('world-b', 'std-x');
    save('world-a', 'std-y');
    expect(ids(await enter(PERSON.uuid, { world: 'world-a', sent: ['stale-device-pick'] }))).toEqual(['std-x']);
  });

  it('changes nothing for someone who never picked an outfit', async () => {
    expect(ids(await enter(PERSON.uuid))).toEqual(['sent1']);
  });

  it('looks for the everyday Woka among the saved outfits of every world', async () => {
    save('world-a', 'std-y');
    await enter(PERSON.uuid, { world: 'world-e' });
    expect(db.userAvatar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }), orderBy: [{ outfitUpdatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }] }),
    );
  });

  it("still lets them in with this world's outfit when the lookup fails", async () => {
    save('world-a', 'std-x');
    save('world-b', 'std-y');
    db.userAvatar.findMany.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await enter(PERSON.uuid);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['std-y']);
    error.mockRestore();
  });

  it('leaves guests as they were', async () => {
    db.user.findFirst.mockResolvedValue(null);
    save('world-a', 'std-x');
    const body = await enter('guest-uuid', { signedIn: false });
    expect(ids(body)).toEqual(['sent1']);
    expect(db.userAvatar.findMany).not.toHaveBeenCalled();
  });

  it('leaves a name that has not signed in as it was, even when it names a real person', async () => {
    save('world-a', 'std-x');
    const body = await enter(PERSON.uuid, { signedIn: false });
    expect(db.userAvatar.findMany).not.toHaveBeenCalled();
    expect(body.status).toBe('ok');
  });

  it('leaves bots as they were', async () => {
    db.user.findFirst.mockResolvedValue({ ...PERSON, uuid: BOT, name: 'Botty' });
    mockSaved.push({ userId: 'u1', worldId: 'world-a', textureIds: ['std-x'] });
    const body = await enter(BOT);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['sent1']);
    expect(db.userAvatar.findMany).not.toHaveBeenCalled();
  });
});
