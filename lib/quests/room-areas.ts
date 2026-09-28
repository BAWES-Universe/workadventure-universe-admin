import { getWamPath, readWamFile } from '@/lib/map-storage';
import type { QuestContextArea } from './model';

const MAX_AREAS = 100;
const MAX_AREA_NAME = 100;

/** The domain the room's WAM lives under: DEFAULT_DOMAIN, else PLAY_URL's host (as api/admin/rooms/[id] does). */
function mapDomain(playUrl: string): string {
  if (process.env.DEFAULT_DOMAIN) return process.env.DEFAULT_DOMAIN;
  try {
    return new URL(playUrl).hostname;
  } catch {
    return 'workadventure.localhost';
  }
}

/** Restricted areas are closed to a newcomer without the right tags, so the game never sends one there. */
function isRestricted(properties: unknown): boolean {
  return Array.isArray(properties) && properties.some((property) => (property as { type?: unknown } | null)?.type === 'restrictedRightsPropertyData');
}

/**
 * The named areas of a WAM, as the game lists them for quests: a name that isn't blank, a size, not restricted, once
 * per name (the game finds the published area by name).
 */
export function namedAreas(wam: { areas?: unknown }): QuestContextArea[] {
  if (!Array.isArray(wam.areas)) return [];
  const seen = new Set<string>();
  const areas: QuestContextArea[] = [];
  for (const area of wam.areas) {
    if (typeof area !== 'object' || area === null) continue;
    const { id, name, width, height, properties } = area as { id?: unknown; name?: unknown; width?: unknown; height?: unknown; properties?: unknown };
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue;
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) continue;
    if (isRestricted(properties)) continue;
    const trimmed = name.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || trimmed.length > MAX_AREA_NAME || seen.has(key)) continue;
    seen.add(key);
    areas.push({ id, name: trimmed });
    if (areas.length === MAX_AREAS) break;
  }
  return areas.sort((a, b) => a.name.localeCompare(b.name));
}

/** The room's named areas from its WAM in map-storage; `source: 'none'` when there is no WAM to read. */
export async function readRoomAreas(room: {
  slug: string;
  world: { slug: string; universe: { slug: string } };
}): Promise<{ areas: QuestContextArea[]; source: 'wam' | 'none' }> {
  const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL;
  const apiToken = process.env.MAP_STORAGE_API_TOKEN;
  const playUrl = process.env.PLAY_URL;
  if (!publicMapStorageUrl || !apiToken || !playUrl) return { areas: [], source: 'none' };
  const wamPath = getWamPath(mapDomain(playUrl), room.world.universe.slug, room.world.slug, room.slug);
  const wam = await readWamFile(publicMapStorageUrl, wamPath, apiToken);
  return wam ? { areas: namedAreas(wam), source: 'wam' } : { areas: [], source: 'none' };
}
