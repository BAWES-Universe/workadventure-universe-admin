import { prisma } from '@/lib/db';

/** The outfit someone picked most recently, in whichever world they picked it (null when they never picked one). */
export async function latestOutfitAnywhere(userId: string): Promise<{ worldId: string; textureIds: string[] } | null> {
  return prisma.userAvatar.findFirst({
    where: { userId, NOT: { textureIds: { isEmpty: true } } },
    orderBy: { updatedAt: 'desc' },
    select: { worldId: true, textureIds: true },
  });
}

/** Saves an outfit for a world without touching the companion saved there (a new entry starts with none). */
export async function saveOutfitForWorld(userId: string, worldId: string, textureIds: string[]): Promise<void> {
  await prisma.userAvatar.upsert({
    where: { userId_worldId: { userId, worldId } },
    create: { userId, worldId, textureIds },
    update: { textureIds },
  });
}
