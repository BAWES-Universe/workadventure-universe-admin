// What a person has saved, one outfit per world, newest first (the real query sorts them).
const mockSaved: { worldId: string; textureIds: string[] }[] = [];

// The catalog: `std-*` parts are in a set for the whole platform, `cost-c` only in a world's own set.
const platform = { lifecycle: 'active', scopes: [{ scopeType: 'platform' }] };
const mockLayers = [
  { textureId: 'std-1', url: 'https://cdn.example.com/w/1.png', avatarSet: platform },
  { textureId: 'std-2', url: 'https://cdn.example.com/w/2.png', avatarSet: platform },
  { textureId: 'cost-c', url: 'https://cdn.example.com/w/c.png', avatarSet: { lifecycle: 'active', scopes: [{ scopeType: 'world' }] } },
];

jest.mock('@/lib/db', () => ({
  prisma: {
    userAvatar: { findMany: jest.fn(async () => mockSaved) },
    avatarLayer: {
      findMany: jest.fn(async ({ where }: { where: { textureId: { in: string[] } } }) =>
        mockLayers.filter((layer) => where.textureId.in.includes(layer.textureId)),
      ),
    },
  },
}));

import { prisma } from '@/lib/db';
import { latestEverydayOutfit } from '@/lib/latest-outfit';

const avatars = prisma.userAvatar as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSaved.length = 0;
});

describe('latestEverydayOutfit', () => {
  it("asks for the person's saved outfits, most recently picked first, skipping empty ones", async () => {
    mockSaved.push({ worldId: 'a', textureIds: ['std-1'] });
    expect(await latestEverydayOutfit('u1')).toEqual({ worldId: 'a', textureIds: ['std-1'] });
    expect(avatars.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', NOT: { textureIds: { isEmpty: true } } },
      // A companion change bumps updatedAt, so it must not decide which outfit is newest
      orderBy: [{ outfitUpdatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      select: { worldId: true, textureIds: true },
    });
  });

  it('passes over a newer costume to the newest outfit made only of standard parts', async () => {
    mockSaved.push(
      { worldId: 'c', textureIds: ['cost-c'] }, // newest: a costume from world c
      { worldId: 'a', textureIds: ['std-1'] },
      { worldId: 'd', textureIds: ['std-2'] }, // oldest
    );
    expect(await latestEverydayOutfit('u1')).toEqual({ worldId: 'a', textureIds: ['std-1'] });
  });

  it("counts a standard body with a costume part as a costume, and the game's own list as standard", async () => {
    mockSaved.push(
      { worldId: 'c', textureIds: ['std-1', 'cost-c'] },
      { worldId: 'a', textureIds: ['male1'] },
    );
    expect(await latestEverydayOutfit('u1')).toEqual({ worldId: 'a', textureIds: ['male1'] });
  });

  it('is null for someone who never picked an outfit, or only ever picked costumes', async () => {
    expect(await latestEverydayOutfit('u1')).toBeNull();
    mockSaved.push({ worldId: 'c', textureIds: ['cost-c'] });
    expect(await latestEverydayOutfit('u1')).toBeNull();
  });
});
