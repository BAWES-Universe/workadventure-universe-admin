/**
 * Your Woka stays yours: a signed-in person wears one Woka in every world, the last one they picked themselves. Entering
 * a world never changes it; a world that can't show it says "not valid" and writes nothing. These run the real rules
 * (the wearable check and the outfit history) over an in-memory catalog.
 */
import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
// What a part's picture is, not who may wear it: that is the wearable check's job and is not mocked.
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn(async (_prisma: unknown, ids: string[]) => ({
    valid: ids.length > 0,
    textures: ids.map((id) => ({ id, url: `https://play.test/${id}.png` })),
  })),
  resolveCompanionTexture: jest.fn(async (_prisma: unknown, id: string | null) =>
    id ? { valid: true, texture: { id, url: `https://play.test/${id}.png` } } : { valid: true, texture: null },
  ),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: () => false }));

import { addOutfit, addSet, fakeDb, resetFakeDb, state } from '../helpers/fake-db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';

const PERSON = { id: 'u1', uuid: 'person-uuid', email: 'p@example.test', name: 'Pat', isGuest: false, companionTextureId: null as string | null };
const BOT = 'bot-11111111-2222-4333-8444-555555555555';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function enter(who: string, { signedIn = true, sent = ['sent1'], world = 'world-b', companion = null as string | null } = {}) {
  (authenticateRequest as jest.Mock).mockResolvedValue(
    signedIn ? { isAuthenticated: true, identifier: who, email: PERSON.email } : { isAuthenticated: false },
  );
  const textures = sent.map((id) => `&characterTextureIds[]=${id}`).join('');
  const pet = companion ? `&companionTextureId=${companion}` : '';
  const url = `http://localhost/api/room/access?userIdentifier=${who}${textures}${pet}&playUri=${encodeURIComponent(
    `http://play.test/@/uni/${world}/room`,
  )}${signedIn ? '&accessToken=token' : ''}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

const ids = (body: { characterTextures: { id: string }[] }) => body.characterTextures.map((texture) => texture.id);
const outfitsOf = () => state.outfits.map((row) => row.textureIds.join('|')).sort();

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});

beforeEach(() => {
  jest.clearAllMocks();
  resetFakeDb();
  state.universes.push({ id: 'un', slug: 'uni', name: 'Uni', isPublic: true, ownerId: 'someone' });
  for (const slug of ['world-a', 'world-b', 'world-c', 'world-d', 'world-e']) {
    state.worlds.push({ id: slug, slug, name: slug, universeId: 'un', isPublic: true, universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'someone' } });
  }
  state.users.push({ ...PERSON });
  // The catalog: std-* for the whole platform, cost-c1 only in world-c, ucost-c1 for the whole universe
  addSet({ id: 'std', layers: ['std-x', 'std-y', 'std-s1', 'std-body'].map((textureId) => ({ textureId })), companions: [{ textureId: 'dog1' }] });
  addSet({ id: 'costume-c', layers: [{ textureId: 'cost-c1' }], scopes: [{ scopeType: 'world', scopeId: 'world-c' }], companions: [{ textureId: 'cape-pet' }] });
  addSet({ id: 'costume-uni', layers: [{ textureId: 'ucost-c1' }], scopes: [{ scopeType: 'universe', scopeId: 'un' }] });
  fakeDb.room = { findFirst: jest.fn().mockResolvedValue({ id: 'r', isPublic: true }) };
  fakeDb.ban = { findFirst: jest.fn().mockResolvedValue(null) };
  fakeDb.visitCard = { findUnique: jest.fn().mockResolvedValue(null) };
  fakeDb.bot = { findFirst: jest.fn().mockResolvedValue({ id: BOT.slice(4) }) };
  fakeDb.roomAccess = { create: jest.fn().mockResolvedValue({}) };
});

describe('GET /api/room/access, your Woka stays yours', () => {
  it('wears the last Woka they picked in every world: picked Y in A then X in B, entering A, B or a new world C gives X', async () => {
    addOutfit('u1', ['std-y'], minutesAgo(600));
    addOutfit('u1', ['std-x'], minutesAgo(300));
    for (const world of ['world-a', 'world-b', 'world-d']) {
      const body = await enter(PERSON.uuid, { world });
      expect(ids(body)).toEqual(['std-x']);
      expect(body.isCharacterTexturesValid).toBe(true);
      expect(body.characterTextureIds).toEqual(['std-x']);
    }
    expect(fakeDb.userOutfit.upsert).not.toHaveBeenCalled();
    expect(fakeDb.userAvatar.upsert).not.toHaveBeenCalled();
  });

  it('keeps a costume they picked in World C when they enter World D where it is allowed (the same universe set)', async () => {
    addOutfit('u1', ['std-y'], minutesAgo(900));
    addOutfit('u1', ['ucost-c1'], minutesAgo(60));
    expect(ids(await enter(PERSON.uuid, { world: 'world-d' }))).toEqual(['ucost-c1']);
  });

  it('says not valid, and writes nothing, where the costume is not allowed', async () => {
    addOutfit('u1', ['std-y'], minutesAgo(900));
    addOutfit('u1', ['cost-c1'], minutesAgo(60));
    const body = await enter(PERSON.uuid, { world: 'world-d' });
    expect(body.isCharacterTexturesValid).toBe(false);
    expect(body.characterTextures).toEqual([]);
    expect(outfitsOf()).toEqual(['cost-c1', 'std-y']);
    // …and it is worn again where it is allowed
    expect(ids(await enter(PERSON.uuid, { world: 'world-c' }))).toEqual(['cost-c1']);
    expect(fakeDb.userOutfit.upsert).not.toHaveBeenCalled();
  });

  it('still tells the game which Woka the account wears where it is not allowed, so the device does not keep an old one', async () => {
    addOutfit('u1', ['std-y'], minutesAgo(900));
    addOutfit('u1', ['cost-c1'], minutesAgo(60));
    const refused = await enter(PERSON.uuid, { world: 'world-d', sent: ['std-y'] });
    expect(refused.isCharacterTexturesValid).toBe(false);
    expect(refused.characterTextures).toEqual([]);
    expect(refused.characterTextureIds).toEqual(['cost-c1']);
    // where it is allowed the ids are the ones worn, as before
    expect((await enter(PERSON.uuid, { world: 'world-c', sent: ['std-y'] })).characterTextureIds).toEqual(['cost-c1']);
  });

  it('says not valid, and writes nothing, when the set of their current Woka was archived', async () => {
    addSet({ id: 'gone', lifecycle: 'archived', layers: [{ textureId: 'archived-1' }] });
    addOutfit('u1', ['std-y'], minutesAgo(900));
    addOutfit('u1', ['archived-1'], minutesAgo(5));
    const body = await enter(PERSON.uuid, { world: 'world-a' });
    expect(body.isCharacterTexturesValid).toBe(false);
    expect(outfitsOf()).toEqual(['archived-1', 'std-y']);
  });

  it('says not valid when they lost the tag a restricted set needs, and valid while they have it', async () => {
    addSet({
      id: 'vip',
      visibility: 'restricted',
      layers: [{ textureId: 'vip-1' }],
      policies: [{ subjectType: 'membership_tag', subjectValue: 'vip' }],
    });
    addOutfit('u1', ['vip-1'], minutesAgo(30));
    state.members.push({ userId: 'u1', worldId: 'world-a', tags: ['vip'] });
    expect((await enter(PERSON.uuid, { world: 'world-a' })).isCharacterTexturesValid).toBe(true);
    state.members.length = 0;
    const body = await enter(PERSON.uuid, { world: 'world-a' });
    expect(body.isCharacterTexturesValid).toBe(false);
    expect(outfitsOf()).toEqual(['vip-1']);
  });

  it('never lets the textures the game sent replace the Woka they wear', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(30));
    const body = await enter(PERSON.uuid, { world: 'world-a', sent: ['std-y'] });
    expect(ids(body)).toEqual(['std-x']);
    expect(outfitsOf()).toEqual(['std-x']);
  });

  it('wears the outfit the game sent for someone who never picked, and records it as their first pick', async () => {
    const body = await enter(PERSON.uuid, { sent: ['std-body', 'std-y'] });
    expect(ids(body)).toEqual(['std-body', 'std-y']);
    expect(body.isCharacterTexturesValid).toBe(true);
    expect(outfitsOf()).toEqual(['std-body|std-y']);
    // Entering again wears it from the record, and writes no more
    fakeDb.userOutfit.upsert.mockClear();
    expect(ids(await enter(PERSON.uuid, { sent: ['std-x'] }))).toEqual(['std-body', 'std-y']);
    expect(fakeDb.userOutfit.upsert).not.toHaveBeenCalled();
  });

  it('says not valid for someone who never picked when the outfit the game sent is not allowed here, and records nothing', async () => {
    const body = await enter(PERSON.uuid, { world: 'world-d', sent: ['cost-c1'] });
    expect(body.isCharacterTexturesValid).toBe(false);
    expect(state.outfits).toEqual([]);
    const none = await enter(PERSON.uuid, { sent: [] });
    expect(none.isCharacterTexturesValid).toBe(false);
  });

  it('keeps the companion they wear: valid, none is valid, not allowed here is not valid; what the game sent does not count', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(30));
    // none
    let body = await enter(PERSON.uuid, { world: 'world-a', companion: 'dog1' });
    expect(body.isCompanionTextureValid).toBe(true);
    expect(body.companionTexture).toBeNull();
    // one they wear, allowed here
    state.users[0].companionTextureId = 'dog1';
    body = await enter(PERSON.uuid, { world: 'world-d' });
    expect(body.isCompanionTextureValid).toBe(true);
    expect(body.companionTexture).toEqual({ id: 'dog1', url: 'https://play.test/dog1.png' });
    // one only allowed in world-c
    state.users[0].companionTextureId = 'cape-pet';
    expect((await enter(PERSON.uuid, { world: 'world-c' })).isCompanionTextureValid).toBe(true);
    body = await enter(PERSON.uuid, { world: 'world-d', companion: 'dog1' });
    expect(body.isCompanionTextureValid).toBe(false);
    expect(state.users[0].companionTextureId).toBe('cape-pet');
  });

  it('keeps the companion the game sent on first entry (a guest who just signed up), and saves it on the account', async () => {
    const body = await enter(PERSON.uuid, { sent: ['std-body', 'std-y'], companion: 'dog1' });
    expect(body.isCompanionTextureValid).toBe(true);
    expect(body.companionTexture).toEqual({ id: 'dog1', url: 'https://play.test/dog1.png' });
    expect(state.users[0].companionTextureId).toBe('dog1');
    // Entering another world wears it from the account, whatever the game sends
    const again = await enter(PERSON.uuid, { world: 'world-d', companion: 'cape-pet' });
    expect(again.companionTexture).toEqual({ id: 'dog1', url: 'https://play.test/dog1.png' });
  });

  it('does not keep a first-entry companion this world does not allow, one the person already has replaced, or one after the first entry', async () => {
    // not allowed here (only in world-c)
    let body = await enter(PERSON.uuid, { world: 'world-d', sent: ['std-x'], companion: 'cape-pet' });
    expect(body.companionTexture).toBeNull();
    expect(state.users[0].companionTextureId).toBeNull();
    // after the first entry they have a Woka on record: the game's companion never counts again
    await enter(PERSON.uuid, { sent: ['std-x'] });
    body = await enter(PERSON.uuid, { sent: ['std-x'], companion: 'dog1' });
    expect(body.companionTexture).toBeNull();
    expect(state.users[0].companionTextureId).toBeNull();
  });

  it('never overwrites a companion they already have on first entry', async () => {
    state.users[0].companionTextureId = 'cape-pet';
    const body = await enter(PERSON.uuid, { world: 'world-c', sent: ['std-x'], companion: 'dog1' });
    expect(body.companionTexture).toEqual({ id: 'cape-pet', url: 'https://play.test/cape-pet.png' });
    expect(state.users[0].companionTextureId).toBe('cape-pet');
  });

  it('saves both the Woka and the companion on a normal first entry', async () => {
    const body = await enter(PERSON.uuid, { sent: ['std-body', 'std-y'], companion: 'dog1' });
    expect(body.status).toBe('ok');
    expect(outfitsOf()).toEqual(['std-body|std-y']);
    expect(state.users[0].companionTextureId).toBe('dog1');
  });

  it('records the Woka but does not overwrite a companion they already have on first entry', async () => {
    state.users[0].companionTextureId = 'cape-pet';
    await enter(PERSON.uuid, { world: 'world-c', sent: ['std-x'], companion: 'dog1' });
    expect(outfitsOf()).toEqual(['std-x']);
    expect(state.users[0].companionTextureId).toBe('cape-pet');
    expect(fakeDb.user.updateMany).not.toHaveBeenCalled();
  });

  // Account Woka X, the Woka saved for this world Y, and the one the game sent Z: none of Y or Z may be handed out
  // when the account's own Woka cannot be looked up or checked, because they never passed the members-only and grant checks.
  describe('when the account Woka cannot be looked up or checked', () => {
    let consoleError: jest.SpyInstance;
    beforeEach(() => {
      addOutfit('u1', ['std-x'], minutesAgo(30));
      state.avatars.push({ id: 'a1', userId: 'u1', worldId: 'world-b', textureIds: ['std-y'], companionTextureId: null });
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    const expectRetryScreen = (body: Record<string, unknown>) => {
      expect(body).toEqual({
        status: 'error',
        type: 'retry',
        code: 'WOKA_LOOKUP_FAILED',
        title: expect.any(String),
        subtitle: "We couldn't load your Woka. Trying again.",
        details: expect.any(String),
        buttonTitle: 'Retry',
        timeToRetry: expect.any(Number),
        canRetryManual: true,
      });
      expect(body.timeToRetry as number).toBeGreaterThan(0);
      // no Woka, no companion, no account ids
      expect(JSON.stringify(body)).not.toMatch(/std-|characterTexture|companion|person-uuid|u1/i);
    };
    const nothingWritten = () => {
      expect(outfitsOf()).toEqual(['std-x']);
      expect(state.avatars).toHaveLength(1);
      expect(state.avatars[0]).toMatchObject({ textureIds: ['std-y'] });
      expect(state.users[0].companionTextureId).toBeNull();
      expect(fakeDb.user.updateMany).not.toHaveBeenCalled();
    };

    it('answers the retry screen, not Y or Z, when the outfit lookup fails', async () => {
      fakeDb.userOutfit.findFirst.mockRejectedValueOnce(new Error('db down'));
      const body = await enter(PERSON.uuid, { sent: ['std-z'] });
      expectRetryScreen(body);
      nothingWritten();
    });

    it('answers the retry screen when the wearable check fails', async () => {
      fakeDb.userAvatarGrant.findMany.mockRejectedValueOnce(new Error('db down'));
      const body = await enter(PERSON.uuid, { sent: ['std-z'] });
      expectRetryScreen(body);
      nothingWritten();
    });

    it('answers the retry screen when the companion check fails', async () => {
      state.users[0].companionTextureId = 'dog1';
      // the first check (the Woka) passes, the second (the companion) fails
      fakeDb.userAvatarGrant.findMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('db down'));
      const body = await enter(PERSON.uuid, { sent: ['std-z'] });
      expectRetryScreen(body);
      expect(outfitsOf()).toEqual(['std-x']);
      expect(state.users[0].companionTextureId).toBe('dog1');
    });

    it('answers the retry screen on a first entry whose pick cannot be saved, and nothing is worn', async () => {
      state.outfits.length = 0;
      fakeDb.userOutfit.upsert.mockRejectedValueOnce(new Error('user_outfits does not exist'));
      const body = await enter(PERSON.uuid, { sent: ['std-x'] });
      expectRetryScreen(body);
      expect(state.outfits).toEqual([]);
      expect(state.users[0].companionTextureId).toBeNull();
    });

    it('on a first entry whose companion cannot be saved, answers the retry screen, saves neither, and the next entry saves both', async () => {
      state.outfits.length = 0;
      fakeDb.user.updateMany.mockRejectedValueOnce(new Error('db down'));
      expectRetryScreen(await enter(PERSON.uuid, { sent: ['std-body', 'std-y'], companion: 'dog1' }));
      // the Woka is not left saved without the companion, so the retry is still a first entry
      expect(state.outfits).toEqual([]);
      expect(state.users[0].companionTextureId).toBeNull();
      const body = await enter(PERSON.uuid, { sent: ['std-body', 'std-y'], companion: 'dog1' });
      expect(body.status).toBe('ok');
      expect(ids(body)).toEqual(['std-body', 'std-y']);
      expect(body.companionTexture).toEqual({ id: 'dog1', url: 'https://play.test/dog1.png' });
      expect(outfitsOf()).toEqual(['std-body|std-y']);
      expect(state.users[0].companionTextureId).toBe('dog1');
    });

    it('tells Sentry', async () => {
      fakeDb.userOutfit.findFirst.mockRejectedValueOnce(new Error('db down'));
      await enter(PERSON.uuid);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it('works again on the next entry once the lookup recovers', async () => {
      fakeDb.userOutfit.findFirst.mockRejectedValueOnce(new Error('db down'));
      expectRetryScreen(await enter(PERSON.uuid));
      const body = await enter(PERSON.uuid);
      expect(body.status).toBe('ok');
      expect(ids(body)).toEqual(['std-x']);
    });
  });

  it('lets a guest wear what the game sent when anyone may wear it here, without looking up an account', async () => {
    state.users.length = 0;
    addOutfit('u1', ['std-x'], minutesAgo(30));
    const body = await enter('guest-uuid', { signedIn: false, sent: ['std-y'], companion: 'dog1' });
    expect(ids(body)).toEqual(['std-y']);
    expect(body.isCharacterTexturesValid).toBe(true);
    expect(body.companionTexture?.id).toBe('dog1');
    expect(fakeDb.userOutfit.findFirst).not.toHaveBeenCalled();
  });

  it('leaves a name that has not signed in as a guest, even when it names a real person', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(30));
    const body = await enter(PERSON.uuid, { signedIn: false, sent: ['std-y'] });
    expect(fakeDb.userOutfit.findFirst).not.toHaveBeenCalled();
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['std-y']);
  });

  it('says not valid when a guest sends a part kept for members, granted to someone, or from another world', async () => {
    state.users.length = 0;
    addSet({
      id: 'vip',
      visibility: 'restricted',
      layers: [{ textureId: 'vip-1' }],
      companions: [{ textureId: 'vip-pet' }],
      policies: [{ subjectType: 'membership_tag', subjectValue: 'vip' }],
    });
    addSet({ id: 'gift', visibility: 'assigned_only', layers: [{ textureId: 'gift-1' }] });
    for (const sent of [['vip-1'], ['gift-1'], ['std-y', 'cost-c1']]) {
      const body = await enter('guest-uuid', { signedIn: false, sent, world: 'world-b' });
      expect(body.isCharacterTexturesValid).toBe(false);
      expect(body.characterTextures).toEqual([]);
    }
    const pet = await enter('guest-uuid', { signedIn: false, sent: ['std-y'], companion: 'vip-pet' });
    expect(pet.isCompanionTextureValid).toBe(false);
    expect(pet.companionTexture).toBeNull();
    expect(pet.isCharacterTexturesValid).toBe(true);
  });

  it("lets a guest wear a world's own costume in that world, and a set whose policy is for everyone", async () => {
    state.users.length = 0;
    addSet({ id: 'open', visibility: 'restricted', layers: [{ textureId: 'open-1' }], policies: [{ subjectType: 'everyone' }] });
    expect((await enter('guest-uuid', { signedIn: false, sent: ['cost-c1'], world: 'world-c' })).isCharacterTexturesValid).toBe(true);
    expect((await enter('guest-uuid', { signedIn: false, sent: ['open-1'] })).isCharacterTexturesValid).toBe(true);
  });

  it('never wears a Woka saved for a world when the account could not be verified: it asks instead of silently giving an old or default one', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(30));
    // an old pick saved for this world (the per-world row older versions kept), here the default look
    state.avatars.push({ id: 'a1', userId: 'u1', worldId: 'world-b', textureIds: ['std-body'], companionTextureId: null });
    // the game sent nothing (a signed-in player's device holds no Woka), and the access token could not be checked
    (authenticateRequest as jest.Mock).mockResolvedValue(null);
    const url = `http://localhost/api/room/access?userIdentifier=${PERSON.uuid}&playUri=${encodeURIComponent('http://play.test/@/uni/world-b/room')}&accessToken=expired`;
    const body = await (await roomAccess(new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }))).json();
    expect(body.isCharacterTexturesValid).toBe(false);
    expect(body.characterTextures).toEqual([]);
  });

  it('leaves bots as they were', async () => {
    state.users[0].uuid = BOT;
    addOutfit('u1', ['std-x'], minutesAgo(30));
    const body = await enter(BOT);
    expect(body.status).toBe('ok');
    expect(ids(body)).toEqual(['sent1']);
    expect(fakeDb.userOutfit.findFirst).not.toHaveBeenCalled();
  });
});
