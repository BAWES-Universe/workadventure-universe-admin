// What each person has worn, newest first (the real query sorts by when it was last worn).
const mockOutfits: { userId: string; textureIds: string[]; lastWornAt: number }[] = [];
let clock = 0;

// The catalog: `signed` is in a set for the whole platform; `costume` only in the own set of a world; `uni` in the set of
// a universe; `draftpart` is in a platform set that is still a draft; `archivedcostume` in an archived set. A part of an
// active set is drawn wherever the set is scoped; "male1" is in the game's own list.
const active = (...scopes: { scopeType: string; scopeId?: string }[]) => ({ lifecycle: 'active', scopes });
const platform = active({ scopeType: 'platform' });
const mockLayers = [
  { textureId: 'signed', url: 'https://cdn.example.com/w/a.png?sig=abc&v=2', avatarSet: platform },
  { textureId: 'costume', url: 'https://cdn.example.com/w/costume.png', avatarSet: active({ scopeType: 'world', scopeId: 'world-a' }) },
  { textureId: 'uni', url: 'https://cdn.example.com/w/uni.png', avatarSet: active({ scopeType: 'universe', scopeId: 'uni-1' }) },
  { textureId: 'archivedcostume', url: 'https://cdn.example.com/w/archived.png', avatarSet: { lifecycle: 'archived', scopes: [{ scopeType: 'world', scopeId: 'world-b' }] } },
  { textureId: 'draftpart', url: 'https://cdn.example.com/w/draft.png', avatarSet: { lifecycle: 'draft', scopes: [{ scopeType: 'platform' }] } },
  // In a world's set and a platform set under the same id: the first active one found is drawn.
  { textureId: 'both', url: 'https://cdn.example.com/w/both-platform.png', avatarSet: platform },
];

jest.mock('@/lib/db', () => ({
  prisma: {
    userOutfit: {
      findMany: jest.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        mockOutfits.filter((outfit) => where.userId.in.includes(outfit.userId)).sort((a, b) => b.lastWornAt - a.lastWornAt),
      ),
    },
    avatarLayer: {
      findMany: jest.fn(async ({ where }: { where: { textureId: { in: string[] } } }) =>
        mockLayers.filter((layer) => where.textureId.in.includes(layer.textureId)),
      ),
    },
  },
}));

import { defaultWoka, withWokas, wokaLayersFor, wokaLayersForMany, wokaTexturesForMany } from '@/lib/woka-avatar';

const male1 = /Male%2001-1\.png$|Male 01-1\.png$/;

describe('Wokas for avatars', () => {
  const wear = (userId: string, ...textureIds: string[]) => mockOutfits.push({ userId, textureIds, lastWornAt: (clock += 1) });
  const signed = ['https://cdn.example.com/w/a.png?sig=abc&v=2'];
  const costume = ['https://cdn.example.com/w/costume.png'];

  beforeEach(() => {
    mockOutfits.length = 0;
    clock = 0;
    wear('u1', 'male1');
    wear('u3', 'signed');
    wear('u4', 'male1', 'no-such-layer');
  });

  it("uses someone's own outfit, and a stable default Woka for anyone else", async () => {
    const wokas = await wokaLayersForMany(['u1', 'u2']);
    expect(wokas.get('u1')?.[0]).toMatch(male1);
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

  describe('which outfit is drawn: the Woka they wear now, from any viewer’s world', () => {
    beforeEach(() => {
      mockOutfits.length = 0;
    });

    it('draws the Woka they wear now, wherever the viewer is, even one made of parts only another world has', async () => {
      wear('p', 'signed');
      wear('p', 'costume'); // newest: a costume from World A
      for (const world of [undefined, null, 'world-a', 'world-b', 'world-elsewhere']) {
        expect((await wokaLayersForMany(['p'], world)).get('p')).toEqual(costume);
      }
      wear('p', 'signed');
      expect((await wokaLayersForMany(['p'], 'world-a')).get('p')).toEqual(signed);
    });

    it("draws a part of a universe's set too: any active set counts, wherever it is scoped", async () => {
      wear('p', 'uni');
      expect((await wokaLayersForMany(['p'], 'a-world-in-another-universe')).get('p')).toEqual(['https://cdn.example.com/w/uni.png']);
    });

    it('when the Woka they wear now can’t be drawn (a part was removed), uses the newest one they wore that can', async () => {
      wear('p', 'signed');
      wear('p', 'male1');
      wear('p', 'archivedcostume'); // its set was archived
      wear('q', 'costume', 'gone'); // a part that can't be found
      wear('q', 'signed');
      wear('q', 'draftpart'); // a draft set
      expect((await wokaLayersForMany(['p', 'q'])).get('p')?.[0]).toMatch(male1);
      expect((await wokaLayersForMany(['p', 'q'])).get('q')).toEqual(signed);
    });

    it('draws the default Woka for someone whose outfits can’t be drawn at all, or who never wore one', async () => {
      wear('p', 'archivedcostume');
      wear('p', 'draftpart', 'male1');
      expect((await wokaLayersForMany(['p', 'nobody'])).get('p')).toEqual(defaultWoka('p'));
      expect((await wokaLayersForMany(['p', 'nobody'])).get('nobody')).toEqual(defaultWoka('nobody'));
      expect(await wokaLayersFor('p')).toEqual(defaultWoka('p'));
    });

    it('draws a part found in an active set before the game’s list', async () => {
      wear('p', 'both');
      expect((await wokaLayersForMany(['p'])).get('p')).toEqual(['https://cdn.example.com/w/both-platform.png']);
    });

    it('gives the game the same pick as { id, url } layers, and leaves out anyone without one', async () => {
      wear('p', 'signed');
      wear('p', 'costume');
      wear('q', 'costume');
      const wokas = await wokaTexturesForMany(['p', 'q', 'nobody'], 'world-b');
      expect(wokas.get('p')).toEqual([{ id: 'costume', url: costume[0] }]);
      expect(wokas.get('q')).toEqual([{ id: 'costume', url: costume[0] }]);
      expect(wokas.has('nobody')).toBe(false);
    });

    it('draws each person from their own outfits in one pass', async () => {
      wear('a', 'costume');
      wear('b', 'signed');
      const wokas = await wokaLayersForMany(['a', 'b'], 'world-a');
      expect(wokas.get('a')).toEqual(costume);
      expect(wokas.get('b')).toEqual(signed);
    });
  });
});
