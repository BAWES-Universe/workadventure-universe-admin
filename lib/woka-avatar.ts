import { prisma } from '@/lib/db';
import { getTextureMap, getWokaList } from '@/lib/wokas';

/** Where the game serves its textures; relative texture paths resolve against it. */
function playServiceUrl(): string {
  return (process.env.PLAY_URL || process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
}

/** A texture address as the browser can load it: absolute ones kept whole (signed or versioned queries included). */
function resolve(url: string): string {
  try {
    // Relative paths resolve against the game; spaces and the like are encoded once, existing escapes kept.
    return new URL(url, `${playServiceUrl()}/`).toString();
  } catch {
    return url;
  }
}

/** A stable pick for someone who never chose an outfit: one of the game's default Wokas, the same one every time. */
export function defaultWoka(userId: string): string[] {
  const textures = getWokaList(playServiceUrl()).woka?.collections?.[0]?.textures ?? [];
  if (textures.length === 0) return [];
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  return [resolve(textures[Math.abs(hash) % textures.length].url)];
}

/** Turns lists of texture ids into image URLs (the catalog first, then the game's own list); a list with an id we can't find comes back as null. */
async function layersFromTextureLists(lists: string[][]): Promise<(string[] | null)[]> {
  const textureIds = [...new Set(lists.flat())];
  const catalog = textureIds.length
    ? await prisma.avatarLayer.findMany({ where: { textureId: { in: textureIds }, isActive: true }, select: { textureId: true, url: true } })
    : [];
  const fromCatalog = new Map(catalog.map((layer) => [layer.textureId, layer.url]));
  let fromConfig: Map<string, { url: string }> | null = null;
  return lists.map((list) => {
    const urls: string[] = [];
    for (const textureId of list) {
      let url = fromCatalog.get(textureId);
      if (!url) {
        fromConfig ??= getTextureMap(playServiceUrl());
        url = fromConfig.get(textureId)?.url;
      }
      // A layer we can't find would leave a body without a head (or the reverse).
      if (!url) return null;
      urls.push(resolve(url));
    }
    return urls.length ? urls : null;
  });
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

  const lists = ids.map((id) => latest.get(id) ?? []);
  const layers = await layersFromTextureLists(lists);
  ids.forEach((id, index) => {
    // A layer we can't find would leave a body without a head (or the reverse): show the default Woka instead.
    result.set(id, layers[index] ?? defaultWoka(id));
  });
  return result;
}

/**
 * Each guest's own Woka from the outfit saved with their visit, bottom first, as image URLs; one a guest has none saved
 * for (older visits), or can't be drawn, is left out of the map (callers fall back to the stand-in).
 */
export async function wokaLayersForTextureLists(lists: Map<string, string[]>): Promise<Map<string, string[]>> {
  const keys = [...lists.keys()].filter((key) => (lists.get(key) ?? []).length > 0);
  const layers = await layersFromTextureLists(keys.map((key) => lists.get(key) as string[]));
  const result = new Map<string, string[]>();
  keys.forEach((key, index) => {
    const found = layers[index];
    if (found) result.set(key, found);
  });
  return result;
}

export async function wokaLayersFor(userId: string): Promise<string[]> {
  return (await wokaLayersForMany([userId])).get(userId) ?? [];
}

/**
 * Adds each person's Woka to a list of records that may name them (`userId`). A guest the viewer may see
 * (`isGuest: true`) gets a default Woka picked from `userUuid` or the record's `id`. A record redacted for this viewer
 * (no `userId`, no `isGuest`) is left exactly as it is. Never fails the list: without Wokas it comes back as it was.
 */
export async function withWokas<
  T extends { userId?: string | null; userUuid?: string | null; id?: string | null; isGuest?: boolean | null; textureIds?: string[] | null },
>(
  records: T[],
): Promise<(T & { woka?: string[] })[]> {
  const ids = records.map((record) => record.userId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const wokas = ids.length ? await wokaLayersForMany(ids).catch(() => new Map<string, string[]>()) : new Map<string, string[]>();
  // A guest with an outfit saved on the visit shows as they look; older visits keep the stand-in below.
  const own = new Map<string, string[]>();
  records.forEach((record, index) => {
    if (!record.userId && record.isGuest === true && record.textureIds?.length) own.set(String(index), record.textureIds);
  });
  const guestWokas = own.size ? await wokaLayersForTextureLists(own).catch(() => new Map<string, string[]>()) : new Map<string, string[]>();
  return records.map((record, index) => {
    if (record.userId && wokas.has(record.userId)) return { ...record, woka: wokas.get(record.userId) };
    if (guestWokas.has(String(index))) return { ...record, woka: guestWokas.get(String(index)) };
    const seed = record.isGuest === true ? record.userUuid || record.id : null;
    if (!seed) return record;
    try {
      return { ...record, woka: defaultWoka(seed) };
    } catch {
      return record;
    }
  });
}
