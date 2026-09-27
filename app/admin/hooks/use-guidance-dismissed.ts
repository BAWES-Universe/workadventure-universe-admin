'use client';

import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';

/**
 * Whether a piece of guidance (`guidance.dismissed.<id>`) was hidden on this account, on every device. `null` while
 * reading; a failure to read shows the guidance (it can be hidden again). Hiding holds for this visit even if saving
 * fails.
 */
export function useGuidanceDismissed(id: string): [hidden: boolean | null, hide: () => void] {
  const key = `guidance.dismissed.${id}`;
  const [hidden, setHidden] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/me/preferences?key=${encodeURIComponent(key)}`)
      .then(async (response) => {
        if (!response.ok) return false;
        const data = (await response.json()) as { preferences?: Record<string, unknown> };
        const value = data.preferences?.[key] as { hidden?: unknown } | undefined;
        return value?.hidden === true;
      })
      .catch(() => false)
      .then((value) => {
        if (!cancelled) setHidden(value);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const hide = useCallback(() => {
    setHidden(true);
    void authenticatedFetch('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ key, value: { hidden: true } }),
    }).catch(() => undefined);
  }, [key]);

  return [hidden, hide];
}
