jest.mock('@/lib/db', () => ({
  prisma: {
    userAvatar: { findMany: jest.fn(async () => [{ userId: 'u1', textureIds: ['male1'] }]) },
    avatarLayer: { findMany: jest.fn(async () => []) },
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
});
