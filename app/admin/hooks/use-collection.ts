'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';

/** Same name as the bridge's event (components/orbit-bridge.tsx), kept here so lists don't import the bridge. */
const ORBIT_REFRESH_EVENT = 'orbit:refresh';

export type Collection<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A list from the API, read as `data[key]`. A failed or malformed response never becomes an empty list: it says so,
 * and `retry` asks again. `url === null` waits (nothing to fetch yet).
 */
export function useCollection<T>(url: string | null, key: string, isItem: (value: unknown) => value is T) {
  const [result, setResult] = useState<Collection<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const lastUrl = useRef<string | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    // A refresh keeps the list on screen; only a first load (or a new address) shows loading.
    setResult((current) => (current.status === 'ready' && lastUrl.current === url ? current : { status: 'loading' }));
    lastUrl.current = url;
    void (async () => {
      try {
        const response = await authenticatedFetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Collection unavailable');
        const data: unknown = await response.json();
        if (!record(data) || !Array.isArray(data[key])) throw new Error('Invalid collection');
        const items = (data[key] as unknown[]).filter(isItem);
        if (!controller.signal.aborted) setResult({ status: 'ready', items });
      } catch {
        if (!controller.signal.aborted) setResult({ status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [url, key, isItem, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // The game said something changed (the Orbit bridge's refresh hint): read the list again, keeping what's shown
  // until the new answer arrives.
  useEffect(() => {
    const onRefresh = () => setAttempt((value) => value + 1);
    window.addEventListener(ORBIT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ORBIT_REFRESH_EVENT, onRefresh);
  }, []);
  /** Changes the list in place (after accepting an invitation, say) without asking the server again. */
  const update = useCallback((change: (items: T[]) => T[]) => {
    setResult((current) => (current.status === 'ready' ? { status: 'ready', items: change(current.items) } : current));
  }, []);
  return { result, retry, update };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return record(value);
}

export function isNamed(value: unknown): value is Record<string, unknown> & { id: string; name: string } {
  return record(value) && typeof value.id === 'string' && typeof value.name === 'string';
}
