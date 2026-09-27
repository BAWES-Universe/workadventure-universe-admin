'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, MapPin, Orbit as OrbitIcon, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { useWorkAdventure } from '../workadventure-context';
import { RoomCard, RoomCardSkeleton, type RoomCardRoom } from './room-card';

interface ApiRoom {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
  _count?: { favorites?: number };
}

function toCardRoom(room: ApiRoom): RoomCardRoom {
  return {
    id: room.id,
    name: room.name,
    slug: room.slug,
    description: room.description ?? null,
    favorites: room._count?.favorites ?? 0,
    world: { name: room.world.name, slug: room.world.slug },
    universe: { name: room.world.universe.name, slug: room.world.universe.slug },
  };
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

type Located =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'room'; room: ApiRoom; start: boolean }
  | { kind: 'unknown'; playUri: string; start: boolean };

/**
 * Where you are and where you were just before: each room with its stars, visits, busiest hour and latest visitor,
 * one tap from its page. On the start map it says so and points at Spaces. Outside the game it explains why there
 * is nothing to show.
 */
export default function HerePanel({ onShown }: { onShown?: (roomIds: string[]) => void }) {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [located, setLocated] = useState<Located>({ kind: 'loading' });
  const [previous, setPrevious] = useState<ApiRoom | null>(null);
  const unavailable = Boolean(error) || (!isReady && !isLoading);

  useEffect(() => {
    if (unavailable || !isReady || !wa) return;
    let cancelled = false;

    async function locate() {
      if (!wa) return;
      try {
        await wa.onInit();
        const playUri = wa.room.id as string | undefined;
        if (!playUri) {
          if (!cancelled) setLocated({ kind: 'failed' });
          return;
        }
        const start = isStartMap(playUri);
        const response = await authenticatedFetch(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(playUri)}`);
        if (cancelled) return;
        if (!response.ok) {
          setLocated({ kind: 'unknown', playUri, start });
          return;
        }
        const room = (await response.json()) as ApiRoom;
        if (cancelled) return;
        setLocated({ kind: 'room', room, start });

        const before = await authenticatedFetch(`/api/admin/rooms/previous?currentRoomId=${encodeURIComponent(room.id)}`);
        if (!cancelled && before.ok) setPrevious(((await before.json()) as { room: ApiRoom | null }).room ?? null);
      } catch (cause) {
        console.error('[Here] Could not resolve the current room', cause);
        if (!cancelled) setLocated({ kind: 'failed' });
      }
    }
    void locate();
    return () => {
      cancelled = true;
    };
  }, [wa, isReady, unavailable]);

  // The rooms shown here (where you are, where you were before), so Home doesn't list them again.
  const roomId = located.kind === 'room' ? located.room.id : null;
  const previousId = previous?.id ?? null;
  useEffect(() => {
    onShown?.([roomId, previousId].filter((id): id is string => Boolean(id)));
  }, [roomId, previousId, onShown]);

  if (unavailable) {
    return (
      <section aria-labelledby="here-heading">
        <h2 id="here-heading" className="sr-only">
          Where you are
        </h2>
        <div className="orbit-card flex items-start gap-3 p-4" role="status">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-medium">Your location shows inside Universe</p>
            <p className="text-sm text-muted-foreground">
              Open Orbit from the game to see the room you&apos;re in and where you were before.
            </p>
          </div>
        </div>
      </section>
    );
  }

  let current: React.ReactNode;
  if (located.kind === 'loading') {
    current = <RoomCardSkeleton />;
  } else if (located.kind === 'failed') {
    current = (
      <div className="orbit-card flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MapPin className="h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-sm text-muted-foreground">No room information available.</p>
      </div>
    );
  } else if (located.start) {
    current = (
      <div className="orbit-card orbit-glow flex h-full flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="orbit-brand-fill flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-primary">You&apos;re here</p>
            <p className="text-[15px] font-semibold">The start map</p>
            <p className="text-sm text-muted-foreground">Where everyone lands. Pick a universe to visit, or make one of your own.</p>
          </div>
        </div>
        <Button asChild size="sm" className="self-start">
          <Link href="/admin/spaces?tab=explore">
            <OrbitIcon className="h-4 w-4" />
            Explore spaces
          </Link>
        </Button>
      </div>
    );
  } else if (located.kind === 'unknown') {
    current = (
      <div className="orbit-card flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MapPin className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">You&apos;re in a room Orbit doesn&apos;t know yet</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{located.playUri}</p>
        </div>
      </div>
    );
  } else {
    current = <RoomCard room={toCardRoom(located.room)} kind="here" eyebrow="You're here" />;
  }

  return (
    <section aria-labelledby="here-heading" data-testid="here">
      <h2 id="here-heading" className="mb-3 text-lg font-semibold tracking-tight">
        Where you are
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {current}
        {previous && <RoomCard room={toCardRoom(previous)} kind="previous" eyebrow="Before this" />}
      </div>
    </section>
  );
}
