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

type Texture = { id: string; url: string };

/** The pictures of every part we can draw: the layers of active sets, wherever those sets are scoped. */
async function loadActiveLayers(textureIds: string[]): Promise<Map<string, string>> {
  const drawable = new Map<string, string>();
  if (textureIds.length === 0) return drawable;
  const layers = await prisma.avatarLayer.findMany({
    where: { textureId: { in: textureIds }, isActive: true },
    select: { textureId: true, url: true, avatarSet: { select: { lifecycle: true } } },
  });
  for (const layer of layers) {
    // Only a part of an active set is drawn (an archived or draft set's parts are not).
    if (layer.avatarSet?.lifecycle === 'active' && !drawable.has(layer.textureId)) drawable.set(layer.textureId, layer.url);
  }
  return drawable;
}

/** An outfit as { id, url } layers, or null when one of its parts can't be found (a body without a head, or the reverse). */
function drawOutfit(textureIds: string[], catalog: Map<string, string>, config: () => Map<string, { url: string }>): Texture[] | null {
  const layers: Texture[] = [];
  for (const id of textureIds) {
    const url = catalog.get(id) ?? config().get(id)?.url;
    if (!url) return null;
    layers.push({ id, url: resolve(url) });
  }
  return layers.length ? layers : null;
}

/** A texture address as the browser can load it (see `resolve`), for code that builds its own payloads. */
export function textureUrl(url: string): string {
  return resolve(url);
}

/** What we know about texture ids for drawing and naming them: the catalog first (any set, so a removed Woka still has its picture), then the game's own list. */
export async function textureInfo(textureIds: string[]): Promise<Map<string, { url: string; name: string | null; isWoka: boolean }>> {
  const info = new Map<string, { url: string; name: string | null; isWoka: boolean }>();
  const ids = [...new Set(textureIds)];
  if (ids.length === 0) return info;
  const layers = await prisma.avatarLayer.findMany({
    where: { textureId: { in: ids }, isActive: true },
    select: { textureId: true, url: true, name: true, layer: true },
  });
  for (const layer of layers) {
    if (!info.has(layer.textureId)) info.set(layer.textureId, { url: resolve(layer.url), name: layer.name ?? null, isWoka: layer.layer === 'woka' });
  }
  if (ids.some((id) => !info.has(id))) {
    const list = getWokaList(playServiceUrl());
    for (const [part, data] of Object.entries(list)) {
      for (const collection of data?.collections ?? []) {
        for (const texture of collection.textures) {
          if (ids.includes(texture.id) && !info.has(texture.id)) {
            info.set(texture.id, { url: resolve(texture.url), name: texture.name ?? null, isWoka: part === 'woka' });
          }
        }
      }
    }
  }
  return info;
}

/**
 * The one rule for which outfit of a person to draw, for everyone who draws a Woka: the Woka they wear now. A person
 * wears one Woka in every world (the last one they picked), so it is drawn from any active outfit set, wherever that
 * set is scoped, or from the game's own list (config/woka.json). If the current one can't be drawn (a part was removed),
 * the newest of the outfits they wore that can is used. Someone with none is left out of the result; callers draw the
 * default Woka. Only the picture is chosen here: who may wear what, and the check on room entry, are not touched, and
 * nothing is saved.
 * `worldId` is ignored: where the viewer is no longer changes what a person wears. It stays so callers don't change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function wokaOutfitsFor(userIds: string[], _worldId?: string | null): Promise<Map<string, Texture[]>> {
  const result = new Map<string, Texture[]>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return result;
  const outfits = await prisma.userOutfit.findMany({
    where: { userId: { in: ids } },
    orderBy: { lastWornAt: 'desc' },
    select: { userId: true, textureIds: true },
  });
  // Newest first, as asked for.
  const byUser = new Map<string, string[][]>();
  for (const outfit of outfits) {
    if (!outfit.textureIds.length) continue;
    const list = byUser.get(outfit.userId);
    if (list) list.push(outfit.textureIds);
    else byUser.set(outfit.userId, [outfit.textureIds]);
  }
  const catalog = await loadActiveLayers([...new Set(outfits.flatMap((outfit) => outfit.textureIds))]);
  let fromConfig: Map<string, { url: string }> | null = null;
  const config = () => (fromConfig ??= getTextureMap(playServiceUrl()));
  for (const [userId, list] of byUser) {
    for (const textureIds of list) {
      const picked = drawOutfit(textureIds, catalog, config);
      if (picked) {
        result.set(userId, picked);
        break;
      }
    }
  }
  return result;
}

/**
 * The layers of each person's Woka for the place you are looking from (see `wokaOutfitsFor`), bottom first, as image
 * URLs, in one pass for a whole list. Each is a WorkAdventure 96×128 sheet; Orbit draws the standing, front-facing
 * frame. Someone without an outfit to show gets a default Woka, the same one every time.
 */
export async function wokaLayersForMany(userIds: string[], worldId?: string | null): Promise<Map<string, string[]>> {
  const outfits = await wokaOutfitsFor(userIds, worldId);
  const result = new Map<string, string[]>();
  for (const id of new Set(userIds)) {
    const outfit = outfits.get(id);
    result.set(id, outfit ? outfit.map((layer) => layer.url) : defaultWoka(id));
  }
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

/**
 * Each person's Woka as the game takes it ({ id, url } per layer, bottom first), so game pickers can draw it, by the
 * same rule as Orbit's cards (see `wokaOutfitsFor`). Someone without one is left out and the game draws its default Woka.
 */
export async function wokaTexturesForMany(
  userIds: string[],
  worldId?: string | null,
): Promise<Map<string, { id: string; url: string }[]>> {
  return wokaOutfitsFor(userIds, worldId);
}

export async function wokaLayersFor(userId: string, worldId?: string | null): Promise<string[]> {
  return (await wokaLayersForMany([userId], worldId)).get(userId) ?? [];
}

/**
 * Adds each person's Woka to a list of records that may name them (`userId`). A guest the viewer may see
 * (`isGuest: true`) gets a default Woka picked from `userUuid` or the record's `id`. A record redacted for this viewer
 * (no `userId`, no `isGuest`) is left exactly as it is. Never fails the list: without Wokas it comes back as it was.
 * `worldId` is the world the viewer is looking from, when they are inside one (see `wokaOutfitsFor`).
 */
export async function withWokas<
  T extends { userId?: string | null; userUuid?: string | null; id?: string | null; isGuest?: boolean | null; textureIds?: string[] | null },
>(
  records: T[],
  worldId?: string | null,
): Promise<(T & { woka?: string[] })[]> {
  const ids = records.map((record) => record.userId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const wokas = ids.length ? await wokaLayersForMany(ids, worldId).catch(() => new Map<string, string[]>()) : new Map<string, string[]>();
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
