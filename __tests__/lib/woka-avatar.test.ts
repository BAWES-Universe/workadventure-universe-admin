jest.mock('@/lib/db', () => ({
  prisma: {
    userAvatar: {
      findMany: jest.fn(async () => [
        { userId: 'u1', textureIds: ['male1'] },
        { userId: 'u3', textureIds: ['signed'] },
        { userId: 'u4', textureIds: ['male1', 'no-such-layer'] },
      ]),
    },
    avatarLayer: {
      findMany: jest.fn(async () => [{ textureId: 'signed', url: 'https://cdn.example.com/w/a.png?sig=abc&v=2' }]),
    },
  },
}));

import { defaultWoka, withWokas, wokaLayersForMany } from '@/lib/woka-avatar';

describe('Wokas for avatars', () => {
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
});
