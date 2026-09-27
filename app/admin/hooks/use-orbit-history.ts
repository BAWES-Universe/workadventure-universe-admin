'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const HISTORY_KEY = '__universeOrbitHistory';

type Entry = { id: number; previous: number | null; href: string };
type Marker = { visit: string; id: number };

function isStateRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOrbitUrl(url: URL): boolean {
  return (
    url.origin === window.location.origin &&
    (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) &&
    url.pathname !== '/admin/login'
  );
}

/**
 * Track browser entries, not renders: a replacement does not add a Back step,
 * and Forward restores an existing entry instead of decreasing a depth counter.
 *
 * The marker is private to this mounted visit. On a reload/direct deep link we
 * cannot prove what is behind us, so Back uses the route's parent. Next owns its
 * history payload; only our namespaced field is added, never its router fields.
 * No extra history entries are created, including in the game's iframe.
 */
export function useOrbitHistory(parent: string | null): { goBack: () => void } {
  const router = useRouter();
  const canGoBack = useRef<() => boolean>(() => false);
  const backPending = useRef(false);

  useEffect(() => {
    const history = window.history;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const visit = crypto.randomUUID();
    const entries = new Map<number, Entry>();
    let nextId = 0;
    let active = true;

    const readEntry = (state: unknown): Entry | undefined => {
      if (!isStateRecord(state)) return;
      const marker = state[HISTORY_KEY];
      if (!isStateRecord(marker) || marker.visit !== visit || typeof marker.id !== 'number') return;
      const entry = entries.get(marker.id);
      return entry?.href === window.location.href ? entry : undefined;
    };

    const mark = (state: unknown, id: number) => ({
      ...(isStateRecord(state) ? state : {}),
      [HISTORY_KEY]: { visit, id } satisfies Marker,
    });

    const initialState: unknown = history.state;
    // Do not reinterpret arbitrary primitive/array states owned by another app.
    if (isOrbitUrl(new URL(window.location.href)) && (initialState == null || isStateRecord(initialState))) {
      const entry: Entry = { id: nextId++, previous: null, href: window.location.href };
      originalReplace.call(history, mark(initialState, entry.id), '');
      entries.set(entry.id, entry);
    }

    const push: History['pushState'] = function (state: unknown, unused, url) {
      const destination = new URL(url ?? window.location.href, window.location.href);
      if (!active || (state != null && !isStateRecord(state)) || !isOrbitUrl(destination)) {
        return originalPush.call(history, state, unused, url);
      }
      const previous = readEntry(history.state);
      const entry: Entry = { id: nextId++, previous: previous?.id ?? null, href: destination.href };
      // Only remember a step after the browser accepts the write.
      originalPush.call(history, mark(state, entry.id), unused, url);
      entries.set(entry.id, entry);
    };

    const replace: History['replaceState'] = function (state: unknown, unused, url) {
      const destination = new URL(url ?? window.location.href, window.location.href);
      if (!active || (state != null && !isStateRecord(state)) || !isOrbitUrl(destination)) {
        const replaced = active ? readEntry(history.state) : undefined;
        originalReplace.call(history, state, unused, url);
        // Forward may return to a child of this entry later. It must no
        // longer treat the replaced page as an internal Orbit destination.
        if (replaced) entries.delete(replaced.id);
        return;
      }
      const current = readEntry(history.state);
      const entry: Entry = {
        id: current?.id ?? nextId++,
        previous: current?.previous ?? null,
        href: destination.href,
      };
      originalReplace.call(history, mark(state, entry.id), unused, url);
      entries.set(entry.id, entry);
    };

    history.pushState = push;
    history.replaceState = replace;
    const onPopState = () => { backPending.current = false; };
    window.addEventListener('popstate', onPopState);
    canGoBack.current = () => {
      if (!isOrbitUrl(new URL(window.location.href))) return false;
      const entry = readEntry(history.state);
      return entry?.previous != null && entries.has(entry.previous);
    };

    return () => {
      active = false;
      canGoBack.current = () => false;
      backPending.current = false;
      window.removeEventListener('popstate', onPopState);
      // Next or another consumer may have wrapped ours after mount. Do not
      // remove its wrapper; an inactive captured wrapper delegates unchanged.
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    };
  }, []);

  const goBack = useCallback(() => {
    // A double tap before popstate must not schedule a second traversal past
    // the first entry (and into the game's history).
    if (backPending.current) return;
    if (canGoBack.current()) {
      backPending.current = true;
      router.back();
    } else if (parent) {
      router.replace(parent);
    }
  }, [parent, router]);

  return { goBack };
}
