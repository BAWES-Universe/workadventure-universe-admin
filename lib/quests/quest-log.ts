import { orbitQuestStateSchema, type OrbitQuestEntry } from '@/lib/orbit-bridge';

/**
 * The player's quest log as the game last sent it (`orbit-quest-state`). Kept in memory, with a copy in this tab's
 * sessionStorage so You still shows it after Orbit reloads inside the same game tab. Never sent anywhere.
 */
const CACHE_KEY = 'orbit.quests.log';

let entries: readonly OrbitQuestEntry[] | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readCache(): readonly OrbitQuestEntry[] | null {
  try {
    const raw = session()?.getItem(CACHE_KEY);
    if (!raw || raw.length > 20000) return null;
    const parsed = orbitQuestStateSchema.shape.entries.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function getQuestLog(): readonly OrbitQuestEntry[] | null {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true;
    entries = readCache();
  }
  return entries;
}

export function getServerQuestLog(): readonly OrbitQuestEntry[] | null {
  return null;
}

export function subscribeQuestLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A validated snapshot from the bridge replaces the last one. */
export function setQuestLog(next: readonly OrbitQuestEntry[]): void {
  loaded = true;
  entries = next;
  try {
    session()?.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the log still shows until Orbit reloads.
  }
  listeners.forEach((listener) => listener());
}

/** For tests: forget the snapshot and the cache. */
export function resetQuestLog(): void {
  entries = null;
  loaded = false;
  try {
    session()?.removeItem(CACHE_KEY);
  } catch {
    // Nothing to clear.
  }
  listeners.forEach((listener) => listener());
}
