import { prisma } from '@/lib/db';
import { getTextureMap } from '@/lib/wokas';

/** Where the game serves its textures; relative texture paths resolve against it. */
function playServiceUrl(): string {
  return (process.env.PLAY_URL || process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
}

function resolve(url: string): string {
  return /^https?:\/\//i.test(url) ? url.split('?')[0] : `${playServiceUrl()}/${url.replace(/^\//, '')}`;
}

/**
 * The layers of someone's Woka (the outfit they last picked in the game), bottom first, as image URLs. Each is a
 * WorkAdventure 96×128 sheet; Orbit draws the standing, front-facing frame. Empty when they never picked one.
 */
export async function wokaLayersFor(userId: string): Promise<string[]> {
  const avatar = await prisma.userAvatar.findFirst({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { textureIds: true },
  });
  const ids = avatar?.textureIds ?? [];
  if (ids.length === 0) return [];
  const catalog = await prisma.avatarLayer.findMany({
    where: { textureId: { in: ids }, isActive: true },
    select: { textureId: true, url: true },
  });
  const fromCatalog = new Map(catalog.map((layer) => [layer.textureId, layer.url]));
  let fromConfig: Map<string, { url: string }> | null = null;
  const urls: string[] = [];
  for (const id of ids) {
    let url = fromCatalog.get(id);
    if (!url) {
      fromConfig ??= getTextureMap(playServiceUrl());
      url = fromConfig.get(id)?.url;
    }
    if (url) urls.push(resolve(url));
  }
  return urls;
}
