'use client';

import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { authenticatedFetch } from '@/lib/client-auth';
import { HIDE_LOCATION_KEY } from '@/lib/user-preferences';

/**
 * "Hide where I am": on, you drop out of Live now and its counts for everyone else, on every device. Shown as one of
 * the You page's setting rows; `rowClassName` is that page's row.
 */
export function HideLocationSetting({ rowClassName }: { rowClassName?: string }) {
  const [hidden, setHidden] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/me/preferences?key=${encodeURIComponent(HIDE_LOCATION_KEY)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preferences answered ${response.status}`);
        const data = (await response.json()) as { preferences?: Record<string, unknown> };
        if (!cancelled) setHidden(data.preferences?.[HIDE_LOCATION_KEY] === true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (next: boolean) => {
    const before = hidden;
    setHidden(next);
    setFailed(false);
    try {
      const response = await authenticatedFetch('/api/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({ key: HIDE_LOCATION_KEY, value: next }),
      });
      if (!response.ok) throw new Error(`Preferences answered ${response.status}`);
    } catch {
      setHidden(before);
      setFailed(true);
    }
  };

  return (
    <div className={rowClassName} id="live-settings">
      <span>
        <strong id="hide-location-label">Hide where I am</strong>
        <span id="hide-location-hint">
          {failed
            ? 'Couldn’t save that. Try again.'
            : hidden
              ? 'Nobody sees which room you’re in, and you’re left out of Live now’s counts.'
              : 'People who can enter your room see you there in Live now.'}
        </span>
      </span>
      <Switch
        checked={hidden === true}
        onCheckedChange={change}
        disabled={hidden === null && !failed}
        aria-labelledby="hide-location-label"
        aria-describedby="hide-location-hint"
        data-testid="hide-location"
      />
    </div>
  );
}
