'use client';

import { useContext, useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { WorkAdventureContext } from '../workadventure-context';

/** How long the game gets to say which room you are in before the answer is "none" (outside the game it never does). */
const LOOKUP_MS = 3000;

/**
 * The universe of the room you are standing in, inside the game. Undefined while it is being looked up; null outside
 * the game, or when it can't be found.
 */
export function useCurrentUniverseId(): string | null | undefined {
  const context = useContext(WorkAdventureContext);
  const wa = context?.isReady ? context.wa : null;
  const [found, setFound] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const timer = setTimeout(() => setFound((current) => (current === undefined ? null : current)), LOOKUP_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!wa) return;
    let cancelled = false;
    (async () => {
      try {
        await wa.onInit();
        const playUri = wa.room.id as string | undefined;
        if (!playUri) return;
        const response = await authenticatedFetch(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(playUri)}`);
        if (!response.ok) return;
        const room = (await response.json()) as { world?: { universe?: { id?: string } } };
        if (!cancelled) setFound(room.world?.universe?.id ?? null);
      } catch {
        // Without it the sheet opens on your own universes, as it does outside the game.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wa]);

  return found;
}
