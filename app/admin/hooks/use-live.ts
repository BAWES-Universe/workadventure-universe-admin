'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import type { LiveView } from '@/lib/live-presence';

const REFRESH_MS = 15_000;

/**
 * Who is where right now, as you may see it, refreshed while the page is in view. `undefined` while the first answer
 * is on its way; `null` when the game can't say (Live now is left out rather than claiming nobody is online).
 */
export function useLive(): LiveView | null | undefined {
  const [view, setView] = useState<LiveView | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await authenticatedFetch('/api/live');
        const data = response.ok ? ((await response.json()) as LiveView | { available: false }) : null;
        if (!cancelled) setView(data && data.available ? data : null);
      } catch {
        // A failed refresh keeps what was shown; the first one shows nothing.
        if (!cancelled) setView((current) => (current === undefined ? null : current));
      }
      if (!cancelled && document.visibilityState === 'visible') timer = setTimeout(load, REFRESH_MS);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      void load();
    };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return view;
}
