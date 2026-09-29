'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { readPublishedQuest, writePublishedQuest, type PublishedQuest } from '@/lib/quests/model';

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string; value: PublishedQuest | null }>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab publishing or pausing shows here too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The same object while the stored record is unchanged, as useSyncExternalStore needs. */
function snapshot(roomId: string): PublishedQuest | null {
  const value = readPublishedQuest(roomId);
  const raw = JSON.stringify(value);
  const cached = cache.get(roomId);
  if (cached && cached.raw === raw) return cached.value;
  cache.set(roomId, { raw, value });
  return value;
}

/**
 * A room's published Welcome chapter in this browser: undefined until the page is in the browser (the server render
 * has no record), then the record or null.
 */
export function usePublishedQuest(roomId: string): PublishedQuest | null | undefined {
  const getSnapshot = useCallback(() => snapshot(roomId), [roomId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Saves the record and updates every page showing it. False when this browser won't keep it. */
export function savePublishedQuest(roomId: string, quest: PublishedQuest): boolean {
  if (!writePublishedQuest(roomId, quest)) return false;
  listeners.forEach((listener) => listener());
  return true;
}
