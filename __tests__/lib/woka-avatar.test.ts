const WORLD_A = 'world-a';
const WORLD_B = 'world-b';

// What each person has saved, newest first (the real query sorts by update time).
const mockAvatars: { userId: string; worldId: string; textureIds: string[] }[] = [];

const UNIVERSE = 'uni-1';
const inWorlds = (...worldIds: string[]) => ({ lifecycle: 'active', scopes: worldIds.map((scopeId) => ({ scopeType: 'world', scopeId })) });

// The catalog: `signed` is in a set for the whole platform; `costume` only in the own sets of worlds A and B; `draftpart`
// is in a platform set that is still a draft; `uni` is in the set of the universe both worlds belong to; `otheruni` in
// another universe's; `unlinked` in an active set that is scoped to a world that is neither A nor B.
const platform = { lifecycle: 'active', scopes: [{ scopeType: 'platform' }] };
const mockLayers = [
  { textureId: 'signed', url: 'https://cdn.example.com/w/a.png?sig=abc&v=2', avatarSet: platform },
  { textureId: 'costume', url: 'https://cdn.example.com/w/costume.png', avatarSet: inWorlds(WORLD_A, WORLD_B) },
  { textureId: 'uni', url: 'https://cdn.example.com/w/uni.png', avatarSet: { lifecycle: 'active', scopes: [{ scopeType: 'universe', scopeId: UNIVERSE }] } },
  { textureId: 'otheruni', url: 'https://cdn.example.com/w/otheruni.png', avatarSet: { lifecycle: 'active', scopes: [{ scopeType: 'universe', scopeId: 'uni-2' }] } },
  { textureId: 'unlinked', url: 'https://cdn.example.com/w/unlinked.png', avatarSet: inWorlds('world-z') },
  { textureId: 'archivedcostume', url: 'https://cdn.example.com/w/archived.png', avatarSet: { lifecycle: 'archived', scopes: [{ scopeType: 'world', scopeId: WORLD_B }] } },
  { textureId: 'draftpart', url: 'https://cdn.example.com/w/draft.png', avatarSet: { lifecycle: 'draft', scopes: [{ scopeType: 'platform' }] } },
  // In a world's set and a platform set under the same id: the platform picture is the one for everyone.
  { textureId: 'both', url: 'https://cdn.example.com/w/both-world.png', avatarSet: inWorlds(WORLD_A) },
  { textureId: 'both', url: 'https://cdn.example.com/w/both-platform.png', avatarSet: platform },
];

jest.mock('@/lib/db', () => ({
  prisma: {
    userAvatar: {
      findMany: jest.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        mockAvatars.filter((avatar) => where.userId.in.includes(avatar.userId)),
      ),
    },
    avatarLayer: {
      findMany: jest.fn(async ({ where }: { where: { textureId: { in: string[] } } }) =>
        mockLayers.filter((layer) => where.textureId.in.includes(layer.textureId)),
      ),
    },
    world: { findUnique: jest.fn(async () => ({ universeId: 'uni-1' })) },
  },
}));

import { prisma } from '@/lib/db';
import { defaultWoka, outfitAllowedEverywhere, outfitsAllowedEverywhere, withWokas, wokaLayersFor, wokaLayersForMany, wokaTexturesForMany } from '@/lib/woka-avatar';

describe('Wokas for avatars', () => {
  beforeEach(() => {
    mockAvatars.length = 0;
    mockAvatars.push(
      { userId: 'u1', worldId: WORLD_A, textureIds: ['male1'] },
      { userId: 'u3', worldId: WORLD_A, textureIds: ['signed'] },
      { userId: 'u4', worldId: WORLD_A, textureIds: ['male1', 'no-such-layer'] },
    );
  });

  it("uses someone's own outfit, and a stable default Woka for anyone else", async () => {
    const wokas = await wokaLayersForMany(['u1', 'u2']);
    expect(wokas.get('u1')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
    expect(wokas.get('u2')).toEqual(defaultWoka('u2'));
    expect(defaultWoka('u2')).toEqual(defaultWoka('u2'));
    expect(defaultWoka('u2').length).toBe(1);
  });

  it('gives a guest a default Woka that says nothing about who they are', async () => {
    const [guest, member, redacted] = await withWokas([
      { id: 'visit-1', userId: null, userUuid: 'guest-uuid', isGuest: true },
      { id: 'visit-2', userId: 'u1' },
      { id: 'visit-3' },
    ]);
    expect(guest.woka).toEqual(defaultWoka('guest-uuid'));
    expect(member.woka?.length).toBe(1);
    // A record stripped for this viewer stays exactly as it was.
    expect(redacted).toEqual({ id: 'visit-3' });
  });

  it("gives a guest the outfit saved with their visit, and the stand-in when it is missing or can't be drawn", async () => {
    const [own, none, broken] = await withWokas([
      { id: 'v1', userId: null, userUuid: 'g1', isGuest: true, textureIds: ['signed'] },
      { id: 'v2', userId: null, userUuid: 'g2', isGuest: true, textureIds: [] },
      { id: 'v3', userId: null, userUuid: 'g3', isGuest: true, textureIds: ['signed', 'no-such-layer'] },
    ]);
    expect(own.woka).toEqual(['https://cdn.example.com/w/a.png?sig=abc&v=2']);
    expect(none.woka).toEqual(defaultWoka('g2'));
    expect(broken.woka).toEqual(defaultWoka('g3'));
  });

  it('keeps signed addresses whole, and uses the default Woka when a layer is missing', async () => {
    const wokas = await wokaLayersForMany(['u3', 'u4']);
    expect(wokas.get('u3')).toEqual(['https://cdn.example.com/w/a.png?sig=abc&v=2']);
    expect(wokas.get('u4')).toEqual(defaultWoka('u4'));
  });

  describe('which outfit is drawn for where you are looking from', () => {
    const save = (userId: string, worldId: string, ...textureIds: string[]) => mockAvatars.push({ userId, worldId, textureIds });
    const signed = ['https://cdn.example.com/w/a.png?sig=abc&v=2'];
    const costume = ['https://cdn.example.com/w/costume.png'];

    beforeEach(() => {
      mockAvatars.length = 0;
    });

    it('inside a world, draws the outfit they saved for that world, even one made of parts only that world has', async () => {
      save('p', WORLD_A, 'costume'); // newest
      save('p', WORLD_B, 'signed');
      expect((await wokaLayersForMany(['p'], WORLD_A)).get('p')).toEqual(costume);
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')).toEqual(signed);
    });

    it('inside a world they have no outfit for, draws their everywhere outfit and never another world\'s costume', async () => {
      save('p', WORLD_B, 'costume'); // newest, but only for another world
      save('p', 'world-old', 'signed', 'hat1');
      const found = (await wokaLayersForMany(['p'], 'world-c')).get('p');
      expect(found).toHaveLength(2);
      expect(found?.[0]).toBe(signed[0]);
      expect(found).not.toContain(costume[0]);
    });

    it('outside any world, draws their latest outfit made only of parts allowed in every world', async () => {
      save('p', WORLD_A, 'costume'); // newest: a world-only costume
      save('p', WORLD_B, 'male1'); // the game's own list is allowed everywhere
      save('p', 'world-old', 'signed');
      expect((await wokaLayersForMany(['p'])).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
      expect((await wokaLayersForMany(['p'], null)).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
    });

    it('only counts a part as allowed everywhere in an active set scoped to the whole platform', async () => {
      save('p', WORLD_A, 'draftpart', 'male1'); // a platform set that is still a draft
      save('q', WORLD_A, 'uni'); // a universe\'s set
      save('r', WORLD_A, 'male1', 'costume'); // one world-only part spoils the outfit
      const wokas = await wokaLayersForMany(['p', 'q', 'r']);
      for (const id of ['p', 'q', 'r']) expect(wokas.get(id)).toEqual(defaultWoka(id));
    });

    it('inside a world, draws their everyday outfit, not an older standard one saved there; a costume saved there stays', async () => {
      save('p', WORLD_A, 'male1'); // newest, standard
      save('p', WORLD_B, 'signed'); // older, standard, saved for the world looked from
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
      expect((await wokaLayersForMany(['p'])).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
      mockAvatars.length = 0;
      save('p', WORLD_A, 'male1'); // newest, standard
      save('p', WORLD_B, 'costume'); // a costume saved for the world looked from
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')).toEqual(costume);
      expect((await wokaLayersForMany(['p'], WORLD_A)).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
    });

    it('does not draw a costume whose set was archived: the everyday outfit, as the game puts on them', async () => {
      save('p', WORLD_A, 'male1'); // newest, standard
      save('p', WORLD_B, 'archivedcostume'); // saved for the world looked from, but its set was archived
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
    });

    it('does not draw a costume whose active set is no longer scoped to the world looked from: the everyday outfit', async () => {
      save('p', WORLD_A, 'male1'); // newest, standard
      save('p', WORLD_B, 'unlinked'); // saved for the world looked from, but its set belongs to another world
      save('q', WORLD_B, 'otheruni', 'male1'); // another universe's set
      save('r', WORLD_B, 'male1', 'unlinked'); // a standard body with a part that is no longer there
      save('r', WORLD_A, 'male1');
      const wokas = await wokaLayersForMany(['p', 'q', 'r'], WORLD_B);
      expect(wokas.get('p')?.[0]).toMatch(/Male%2001-1\.png$|Male 01-1\.png$/);
      expect(wokas.get('p')).toHaveLength(1);
      expect(wokas.get('q')).toEqual(defaultWoka('q'));
      expect(wokas.get('r')).toHaveLength(1);
      expect(wokas.get('r')).not.toContain('https://cdn.example.com/w/unlinked.png');
    });

    it("draws a costume from the world's universe, and not the same costume looked at from a world outside it", async () => {
      save('p', WORLD_B, 'uni');
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')).toEqual(['https://cdn.example.com/w/uni.png']);
      (prisma.world.findUnique as jest.Mock).mockResolvedValueOnce({ universeId: 'uni-2' });
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')).toEqual(defaultWoka('p'));
    });

    it('still draws a costume scoped to the world itself when the universe can\'t be looked up', async () => {
      save('p', WORLD_A, 'costume');
      save('q', WORLD_A, 'uni');
      (prisma.world.findUnique as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      expect((await wokaLayersForMany(['p'], WORLD_A)).get('p')).toEqual(costume);
      (prisma.world.findUnique as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      expect((await wokaLayersForMany(['q'], WORLD_A)).get('q')).toEqual(defaultWoka('q'));
    });

    it('draws the platform picture of a part that is also in a world\'s own set', async () => {
      save('p', WORLD_A, 'both');
      expect((await wokaLayersForMany(['p'])).get('p')).toEqual(['https://cdn.example.com/w/both-platform.png']);
    });

    it('draws the default Woka for someone with no outfit allowed there, outside or inside a world', async () => {
      save('p', WORLD_A, 'costume');
      expect((await wokaLayersForMany(['p', 'nobody'])).get('p')).toEqual(defaultWoka('p'));
      expect((await wokaLayersForMany(['p', 'nobody'])).get('nobody')).toEqual(defaultWoka('nobody'));
      expect((await wokaLayersForMany(['p'], WORLD_B)).get('p')).toEqual(defaultWoka('p'));
      expect(await wokaLayersFor('p')).toEqual(defaultWoka('p'));
    });

    it('falls back to the everywhere outfit when the world outfit has a part that can\'t be found', async () => {
      save('p', WORLD_A, 'costume', 'gone');
      save('p', WORLD_B, 'signed');
      expect((await wokaLayersForMany(['p'], WORLD_A)).get('p')).toEqual(signed);
    });

    it('gives the game the same pick as { id, url } layers, and leaves out anyone without one', async () => {
      save('p', WORLD_A, 'costume');
      save('p', WORLD_B, 'signed');
      save('q', WORLD_A, 'costume');
      const inWorld = await wokaTexturesForMany(['p', 'q', 'nobody'], WORLD_A);
      expect(inWorld.get('p')).toEqual([{ id: 'costume', url: costume[0] }]);
      expect(inWorld.get('q')).toEqual([{ id: 'costume', url: costume[0] }]);
      expect(inWorld.has('nobody')).toBe(false);
      const outside = await wokaTexturesForMany(['p', 'q']);
      expect(outside.get('p')).toEqual([{ id: 'signed', url: signed[0] }]);
      expect(outside.has('q')).toBe(false);
    });

    it('draws each person from their own outfits in one pass', async () => {
      save('a', WORLD_A, 'costume');
      save('b', WORLD_A, 'signed');
      const wokas = await wokaLayersForMany(['a', 'b'], WORLD_A);
      expect(wokas.get('a')).toEqual(costume);
      expect(wokas.get('b')).toEqual(signed);
    });
  });

  describe('outfitAllowedEverywhere', () => {
    it('answers for several outfits in one pass', async () => {
      expect(await outfitsAllowedEverywhere([['signed'], ['costume'], ['signed', 'costume'], ['male1']])).toEqual([true, false, false, true]);
    });

    it('is true for parts of a platform set and of the game\'s own list, mixed or alone', async () => {
      expect(await outfitAllowedEverywhere(['signed'])).toBe(true);
      expect(await outfitAllowedEverywhere(['male1'])).toBe(true);
      expect(await outfitAllowedEverywhere(['signed', 'male1'])).toBe(true);
      expect(await outfitAllowedEverywhere(['both'])).toBe(true);
      expect(await outfitAllowedEverywhere([])).toBe(true);
    });

    it('is false when any part is only in a world\'s or a universe\'s own set, a draft set, or unknown', async () => {
      expect(await outfitAllowedEverywhere(['costume'])).toBe(false);
      expect(await outfitAllowedEverywhere(['uni'])).toBe(false);
      expect(await outfitAllowedEverywhere(['signed', 'costume'])).toBe(false);
      expect(await outfitAllowedEverywhere(['draftpart'])).toBe(false);
      expect(await outfitAllowedEverywhere(['no-such-layer'])).toBe(false);
    });
  });
});
