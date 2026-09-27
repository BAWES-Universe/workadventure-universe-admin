'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/client-auth';
import { useWorkAdventure } from '../workadventure-context';
import { OrbitalIllustration, RoomCard, RoomCardSkeleton, type RoomCardRoom } from './room-card';
import styles from './room-card.module.css';

interface ApiRoom {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
  _count?: { favorites?: number };
  accessedAt?: string;
}

function toCardRoom(room: ApiRoom): RoomCardRoom {
  return {
    id: room.id,
    name: room.name,
    slug: room.slug,
    description: room.description ?? null,
    favorites: room._count?.favorites ?? 0,
    world: { id: room.world.id, name: room.world.name, slug: room.world.slug },
    universe: { id: room.world.universe.id, name: room.world.universe.name, slug: room.world.universe.slug },
    accessedAt: room.accessedAt,
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

function Notice({ eyebrow, title, children, action }: { eyebrow: string; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.notice} role="status">
      <div className={styles.noticeTop}>
        <span className={styles.eyebrow}>{eyebrow}</span>
        <OrbitalIllustration small />
      </div>
      <h3 className="orbit-display">{title}</h3>
      {children}
      {action}
    </div>
  );
}

/**
 * Where you are and where you were just before: each room with its stars, visits, busiest hour and latest visitor,
 * one tap from its page. On the start map it says so and points at Space. Outside the game it explains why there
 * is nothing to show.
 */
export default function HerePanel({ onShown }: { onShown?: (roomIds: string[]) => void }) {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [located, setLocated] = useState<Located>({ kind: 'loading' });
  const [previous, setPrevious] = useState<{ currentId: string; room: ApiRoom | null; failed?: boolean }>({ currentId: '', room: null });
  // Asking again after a failure (the room lookup, or the room before it).
  const [attempt, setAttempt] = useState(0);
  const unavailable = Boolean(error) || (!isReady && !isLoading);
  // Try again clears the failure at once, so the card shows it is looking again instead of the old notice.
  const retry = () => {
    setLocated((current) => (current.kind === 'failed' ? { kind: 'loading' } : current));
    setPrevious((current) => (current.failed ? { ...current, failed: false } : current));
    setAttempt((value) => value + 1);
  };

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
          // Only "not found" means Orbit doesn't know the room; anything else is a failure worth retrying.
          setLocated(response.status === 404 ? { kind: 'unknown', playUri, start } : { kind: 'failed' });
          return;
        }
        const room = (await response.json()) as ApiRoom;
        if (cancelled) return;
        setLocated({ kind: 'room', room, start });

        const before = await authenticatedFetch(`/api/admin/rooms/previous?currentRoomId=${encodeURIComponent(room.id)}`);
        if (cancelled) return;
        // Keyed by the room it was asked for, so an old answer never shows under a newer room.
        if (before.ok) {
          setPrevious({ currentId: room.id, room: ((await before.json()) as { room: ApiRoom | null }).room ?? null });
        } else {
          setPrevious({ currentId: room.id, room: null, failed: before.status !== 404 });
        }
      } catch (cause) {
        console.error('[Here] Could not resolve the current room', cause);
        if (!cancelled) setLocated({ kind: 'failed' });
      }
    }
    void locate();
    return () => {
      cancelled = true;
    };
  }, [wa, isReady, unavailable, attempt]);

  const roomId = located.kind === 'room' ? located.room.id : null;
  const previousRoom = roomId && previous.currentId === roomId ? previous.room : null;
  const previousId = previousRoom?.id ?? null;
  useEffect(() => {
    onShown?.([roomId, previousId].filter((id): id is string => Boolean(id)));
  }, [roomId, previousId, onShown]);

  let current: React.ReactNode;
  if (unavailable) {
    current = (
      <Notice eyebrow="Where you are" title="Your location shows inside Universe">
        <p>Open Orbit from the game to see the room you&apos;re in and where you were before.</p>
      </Notice>
    );
  } else if (located.kind === 'loading') {
    current = <RoomCardSkeleton />;
  } else if (located.kind === 'failed') {
    current = (
      <Notice eyebrow="Where you are" title="No room information available">
        <p>Orbit couldn&apos;t tell which room you&apos;re in right now.</p>
        <button type="button" className={styles.retry} onClick={retry}>
          Try again
        </button>
      </Notice>
    );
  } else if (located.start) {
    current = (
      <Notice
        eyebrow="You are here"
        title="The start map"
        action={
          <Link href="/admin/space" className={styles.detailsLink}>
            Explore Space
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        }
      >
        <p>Where everyone lands. Pick a universe to visit, or make one of your own.</p>
      </Notice>
    );
  } else if (located.kind === 'unknown') {
    current = (
      <Notice eyebrow="You are here" title="A room Orbit doesn’t know yet">
        <p className={styles.roomUri}>{located.playUri}</p>
      </Notice>
    );
  } else {
    current = <RoomCard room={toCardRoom(located.room)} kind="here" />;
  }

  return (
    <section className={styles.location} aria-labelledby="here-heading" data-testid="here">
      <h2 id="here-heading" className="sr-only">
        Where you are
      </h2>
      <div className={cn(styles.locationGrid, previousRoom && styles.hasPrevious)}>
        {current}
        {previousRoom && (
          <div className={styles.previousStop}>
            <RoomCard room={toCardRoom(previousRoom)} kind="previous" />
          </div>
        )}
        {roomId && previous.currentId === roomId && previous.failed && (
          <p className={styles.activityStatus} role="status">
            Couldn&apos;t load the room before this.{' '}
            <button type="button" className={styles.retry} onClick={retry}>
              Try again
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
