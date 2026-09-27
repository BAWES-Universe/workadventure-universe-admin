'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPin, Map as MapIcon, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkAdventure } from '../workadventure-context';
import { authenticatedFetch } from '@/lib/client-auth';

interface CurrentRoom {
  id: string;
  slug: string;
  name: string;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
}

/** The start map is where everyone lands; it isn't a place of anyone's, so Home stays neutral there. */
export function isStartMap(playUri: string): boolean {
  try {
    const path = new URL(playUri).pathname.split('/').filter(Boolean);
    return path[0] === '@' && path[1] === 'default' && path[2] === 'default' && path[3] === 'default';
  } catch {
    return false;
  }
}

type HereState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'start' }
  | { kind: 'room'; room: CurrentRoom }
  | { kind: 'unknown'; playUri: string };

/**
 * Where you are right now: the room, its world and universe, one tap from the room's page. On the start map it says
 * so, quietly, and points at Places. Outside the game (a plain tab) it shows nothing.
 */
export default function HerePanel() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [located, setLocated] = useState<HereState>({ kind: 'loading' });
  // Outside the game (a plain tab, or its API failed) there is nowhere to be.
  const unavailable = Boolean(error) || (!isReady && !isLoading);
  const state: HereState = unavailable ? { kind: 'unavailable' } : located;

  useEffect(() => {
    if (unavailable || !isReady || !wa) return;
    let cancelled = false;

    async function locate() {
      if (!wa) return;
      try {
        await wa.onInit();
        const playUri = wa.room.id as string | undefined;
        if (!playUri) {
          if (!cancelled) setLocated({ kind: 'unavailable' });
          return;
        }
        if (isStartMap(playUri)) {
          if (!cancelled) setLocated({ kind: 'start' });
          return;
        }
        const response = await authenticatedFetch(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(playUri)}`);
        if (cancelled) return;
        if (response.ok) {
          setLocated({ kind: 'room', room: (await response.json()) as CurrentRoom });
        } else {
          setLocated({ kind: 'unknown', playUri });
        }
      } catch (cause) {
        console.error('[Here] Could not resolve the current room', cause);
        if (!cancelled) setLocated({ kind: 'unavailable' });
      }
    }
    void locate();
    return () => {
      cancelled = true;
    };
  }, [wa, isReady, unavailable]);

  if (state.kind === 'unavailable') return null;

  if (state.kind === 'loading') {
    return (
      <div className="orbit-card flex items-center gap-3 p-4">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
    );
  }

  if (state.kind === 'start') {
    return (
      <div className="orbit-card orbit-glow flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <span className="orbit-brand-fill flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">You&apos;re on the start map</p>
          <p className="text-sm text-muted-foreground">Pick a place to visit, or make one of your own.</p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href="/admin/places">
            <MapIcon className="h-4 w-4" />
            Places
          </Link>
        </Button>
      </div>
    );
  }

  if (state.kind === 'unknown') {
    return (
      <div className="orbit-card flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MapPin className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">You&apos;re in a room Orbit doesn&apos;t know yet</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{state.playUri}</p>
        </div>
      </div>
    );
  }

  const { room } = state;
  return (
    <Link
      href={`/admin/rooms/${room.id}`}
      className="orbit-card orbit-card-interactive flex items-center gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="orbit-brand-fill flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
        <MapPin className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">You&apos;re in</span>
        <span className="block truncate text-[15px] font-semibold">{room.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {room.world.name} · {room.world.universe.name}
        </span>
      </span>
    </Link>
  );
}
