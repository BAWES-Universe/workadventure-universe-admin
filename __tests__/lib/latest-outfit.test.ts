jest.mock('@/lib/db', () => ({
  prisma: { userAvatar: { findFirst: jest.fn(), upsert: jest.fn() } },
}));

import { prisma } from '@/lib/db';
import { latestOutfitAnywhere, saveOutfitForWorld } from '@/lib/latest-outfit';

const avatars = prisma.userAvatar as unknown as Record<string, jest.Mock>;

beforeEach(() => jest.clearAllMocks());

describe('latestOutfitAnywhere', () => {
  it("asks for the person's most recently updated outfit across worlds, skipping empty ones", async () => {
    avatars.findFirst.mockResolvedValue({ worldId: 'a', textureIds: ['x'] });
    expect(await latestOutfitAnywhere('u1')).toEqual({ worldId: 'a', textureIds: ['x'] });
    expect(avatars.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', NOT: { textureIds: { isEmpty: true } } },
      orderBy: { updatedAt: 'desc' },
      select: { worldId: true, textureIds: true },
    });
  });

  it('is null for someone who never picked an outfit', async () => {
    avatars.findFirst.mockResolvedValue(null);
    expect(await latestOutfitAnywhere('u1')).toBeNull();
  });
});

describe('saveOutfitForWorld', () => {
  it("saves only the outfit, leaving the world's companion alone", async () => {
    await saveOutfitForWorld('u1', 'b', ['x', 'y']);
    expect(avatars.upsert).toHaveBeenCalledWith({
      where: { userId_worldId: { userId: 'u1', worldId: 'b' } },
      create: { userId: 'u1', worldId: 'b', textureIds: ['x', 'y'] },
      update: { textureIds: ['x', 'y'] },
    });
  });
});
