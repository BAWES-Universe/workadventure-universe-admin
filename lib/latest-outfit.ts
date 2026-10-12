import { prisma } from '@/lib/db';
import { outfitsAllowedEverywhere } from '@/lib/woka-avatar';

/**
 * The outfit someone picked most recently, in whichever world they picked it, that is made only of standard parts (null
 * when they never picked one). A costume, an outfit with a part only a universe's or a world's own set has, never counts:
 * it stays in the world where it was picked.
 */
export async function latestEverydayOutfit(userId: string): Promise<{ worldId: string; textureIds: string[] } | null> {
  const saved = await prisma.userAvatar.findMany({
    where: { userId, NOT: { textureIds: { isEmpty: true } } },
    // outfitUpdatedAt, not updatedAt: a companion change bumps updatedAt without changing the outfit
    orderBy: [{ outfitUpdatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
    select: { worldId: true, textureIds: true },
  });
  if (saved.length === 0) return null;
  const standard = await outfitsAllowedEverywhere(saved.map((outfit) => outfit.textureIds));
  return saved.find((_outfit, index) => standard[index]) ?? null;
}
