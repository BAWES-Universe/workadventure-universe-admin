import { prisma } from '@/lib/db';
import { getTextureMap, getWokaList } from '@/lib/wokas';

/** Where the game serves its textures; relative texture paths resolve against it. */
function playServiceUrl(): string {
  return (process.env.PLAY_URL || process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
}

function resolve(url: string): string {
  if (/^https?:\/\//i.test(url)) return url.split('?')[0];
  return `${playServiceUrl()}/${url.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')}`;
}

/** A stable pick for someone who never chose an outfit: one of the game's default Wokas, the same one every time. */
function defaultWoka(userId: string): string[] {
  const textures = getWokaList(playServiceUrl()).woka?.collections?.[0]?.textures ?? [];
  if (textures.length === 0) return [];
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  return [resolve(textures[Math.abs(hash) % textures.length].url)];
}

/**
 * The layers of each person's Woka (the outfit they last picked in the game), bottom first, as image URLs, in one
 * pass for a whole list. Each is a WorkAdventure 96×128 sheet; Orbit draws the standing, front-facing frame. Someone
 * who never picked one gets a default Woka, the same one every time.
 */
export async function wokaLayersForMany(userIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return result;
  const avatars = await prisma.userAvatar.findMany({
    where: { userId: { in: ids } },
    orderBy: { updatedAt: 'desc' },
    select: { userId: true, textureIds: true },
  });
  const latest = new Map<string, string[]>();
  for (const avatar of avatars) if (!latest.has(avatar.userId) && avatar.textureIds.length) latest.set(avatar.userId, avatar.textureIds);

  const textureIds = [...new Set([...latest.values()].flat())];
  const catalog = textureIds.length
    ? await prisma.avatarLayer.findMany({ where: { textureId: { in: textureIds }, isActive: true }, select: { textureId: true, url: true } })
    : [];
  const fromCatalog = new Map(catalog.map((layer) => [layer.textureId, layer.url]));
  let fromConfig: Map<string, { url: string }> | null = null;

  for (const id of ids) {
    const urls: string[] = [];
    for (const textureId of latest.get(id) ?? []) {
      let url = fromCatalog.get(textureId);
      if (!url) {
        fromConfig ??= getTextureMap(playServiceUrl());
        url = fromConfig.get(textureId)?.url;
      }
      if (url) urls.push(resolve(url));
    }
    result.set(id, urls.length ? urls : defaultWoka(id));
  }
  return result;
}

export async function wokaLayersFor(userId: string): Promise<string[]> {
  return (await wokaLayersForMany([userId])).get(userId) ?? [];
}
