'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import type { LiveView } from '@/lib/live-presence';
import { timeAgo } from '@/lib/time-ago';
import { cn } from '@/lib/utils';
import { useWorkAdventure } from '../workadventure-context';
import { useStartRoom } from '../admin-bootstrap-context';
import { isRecord, useCollection } from '../hooks/use-collection';
import { LoadError } from './ds';
import { ScrollSection } from './orbit/scroll-row';
import { OrbitalIllustration, RoomCard, RoomCardSkeleton, type RoomCardRoom } from './room-card';
import styles from './room-card.module.css';
import timeline from './orbit/timeline.module.css';

interface ApiRoom {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
  _count?: { favorites?: number };
  accessedAt?: string;
  /** One of System's rooms, kept out of every list now that the start room is elsewhere. */
  unlisted?: boolean;
  /** One of System's built-in rooms: when it is also the start room, Home calls it the start map. */
  system?: boolean;
}

/** A room from your visits (the recent rooms list), newest first. */
interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  roomDescription: string | null;
  roomFavorites: number;
  worldId: string;
  worldName: string;
  worldSlug: string;
  universeId: string;
  universeName: string;
  universeSlug: string;
  accessedAt: string;
}

const isRecentRoom = (value: unknown): value is RecentRoom =>
  isRecord(value) && typeof value.roomId === 'string' && typeof value.roomName === 'string';

/** How many rooms the timeline goes back, after the one before this. */
const EARLIER = 10;

function fromRecent(room: RecentRoom): RoomCardRoom {
  return {
    id: room.roomId,
    name: room.roomName,
    slug: room.roomSlug,
    description: room.roomDescription,
    favorites: room.roomFavorites,
    world: { id: room.worldId, name: room.worldName, slug: room.worldSlug },
    universe: { id: room.universeId, name: room.universeName, slug: room.universeSlug },
    accessedAt: room.accessedAt,
  };
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

/**
 * Whether this is the start room (START_ROOM_URL, as `@/universe/world/room`), where everyone lands. It is only "the
 * start map" when it is System's built-in map or a room Orbit doesn't know; a real room keeps its own card.
 */
export function isStartMap(playUri: string, startRoom: string | null = '@/default/default/default'): boolean {
  if (!startRoom) return false;
  try {
    const path = new URL(playUri).pathname.split('/').filter(Boolean);
    return path.length >= 4 && path.slice(0, 4).join('/') === startRoom;
  } catch {
    return false;
  }
}

type Located =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'room'; room: ApiRoom; playUri: string; start: boolean }
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

/** When you were there, on the line above a room. */
function When({ at }: { at?: string }) {
  if (!at) return <span className={timeline.when} />;
  return (
    <time className={timeline.when} dateTime={at} title={new Date(at).toLocaleString()}>
      {timeAgo(new Date(at))}
    </time>
  );
}

/**
 * Your timeline: where you are, the room before it and the rooms you were in lately, newest first, in one row that
 * scrolls sideways with when you were there on the line above each. Where you are keeps its full card; every earlier
 * room has the same card at one size: its stars, visits, busiest hour and latest visitor, and how many people are
 * there now. On the start map (System's built-in one, or a start room Orbit doesn't know) it says so and points at
 * Space. Outside the game it explains why there is nothing to show, and your rooms still follow.
 */
export default function HerePanel({ live }: { live?: LiveView | null }) {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const startRoom = useStartRoom();
  const [located, setLocated] = useState<Located>({ kind: 'loading' });
  // Keyed by the play link it was asked for, so an old answer never shows under a newer room.
  const [previous, setPrevious] = useState<{ playUri: string; room: ApiRoom | null; failed?: boolean }>({ playUri: '', room: null });
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
        const start = isStartMap(playUri, startRoom);
        const response = await authenticatedFetch(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(playUri)}`);
        if (cancelled) return;
        let room: ApiRoom | null = null;
        if (response.ok) {
          room = (await response.json()) as ApiRoom;
          if (cancelled) return;
          setLocated({ kind: 'room', room, playUri, start });
        } else if (response.status === 404) {
          setLocated({ kind: 'unknown', playUri, start });
        } else {
          // Only "not found" means Orbit doesn't know the room; anything else is a failure worth retrying.
          setLocated({ kind: 'failed' });
          return;
        }

        // Asked even where Orbit doesn't know the room (often the start map): the room you just left still shows.
        const query = `playUri=${encodeURIComponent(playUri)}${room ? `&currentRoomId=${encodeURIComponent(room.id)}` : ''}`;
        const before = await authenticatedFetch(`/api/admin/rooms/previous?${query}`);
        if (cancelled) return;
        if (before.ok) {
          setPrevious({ playUri, room: ((await before.json()) as { room: ApiRoom | null }).room ?? null });
        } else {
          setPrevious({ playUri, room: null, failed: before.status !== 404 });
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
  }, [wa, isReady, unavailable, attempt, startRoom]);

  const roomId = located.kind === 'room' ? located.room.id : null;
  const herePlayUri = located.kind === 'room' || located.kind === 'unknown' ? located.playUri : null;
  const previousFor = herePlayUri !== null && previous.playUri === herePlayUri ? previous : null;
  const previousRoom = previousFor?.room ?? null;
  const previousId = previousRoom?.id ?? null;

  // Rooms you were in lately: two more than shown, in case where you are and the room before it are among them.
  const recent = useCollection(`/api/admin/rooms/recent?limit=${EARLIER + 2}`, 'rooms', isRecentRoom);
  const earlier =
    recent.result.status === 'ready'
      ? recent.result.items.filter((room) => room.roomId !== roomId && room.roomId !== previousId).slice(0, EARLIER).map(fromRecent)
      : null;

  // People there now, as Live now counts them: you are counted in the room you're in, so its card leaves you out.
  const places = new Map((live?.places ?? []).map((place) => [place.roomId, place]));
  const peopleIn = (id: string) => {
    const place = places.get(id);
    return place ? place.count - (place.here ? 1 : 0) : 0;
  };

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
  } else if (located.start && (located.kind === 'unknown' || located.room.system)) {
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
  } else if (located.kind === 'room' && located.room.unlisted) {
    current = (
      <Notice
        eyebrow="You are here"
        title="A room that isn't listed"
        action={
          <Link href="/admin/space" className={styles.detailsLink}>
            Explore Space
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        }
      >
        <p>This room isn&apos;t listed anywhere in Orbit.</p>
      </Notice>
    );
  } else if (located.kind === 'unknown') {
    current = (
      <Notice eyebrow="You are here" title="A room Orbit doesn’t know yet">
        <p className={styles.roomUri}>{located.playUri}</p>
      </Notice>
    );
  } else {
    current = <RoomCard room={toCardRoom(located.room)} kind="here" people={peopleIn(located.room.id)} />;
  }

  const stops: React.ReactNode[] = [];
  if (previousRoom) {
    stops.push(
      <div key="previous" className={timeline.stop}>
        <When at={previousRoom.accessedAt} />
        <div className={timeline.card}>
          <RoomCard room={toCardRoom(previousRoom)} kind="previous" people={peopleIn(previousRoom.id)} even />
        </div>
      </div>,
    );
  }
  if (previousFor?.failed) {
    stops.push(
      <div key="previous-failed" className={timeline.stop}>
        <When />
        <div className={cn(styles.notice, timeline.note)}>
          <p role="status">
            Couldn&apos;t load the room before this.{' '}
            <button type="button" className={styles.retry} onClick={retry}>
              Try again
            </button>
          </p>
        </div>
      </div>,
    );
  }
  for (const room of earlier ?? []) {
    stops.push(
      <div key={room.id} className={timeline.stop}>
        <When at={room.accessedAt} />
        <div className={timeline.card}>
          <RoomCard room={room} kind="previous" eyebrow="" people={peopleIn(room.id)} even />
        </div>
      </div>,
    );
  }
  if (recent.result.status === 'error') {
    stops.push(
      <div key="recent-failed" className={timeline.stop}>
        <When />
        <div className={timeline.card}>
          <LoadError label="your recent rooms" retry={recent.retry} />
        </div>
      </div>,
    );
  } else if (earlier === null) {
    stops.push(
      <div key="recent-loading" className={timeline.stop}>
        <When />
        <div className={timeline.card}>
          <RoomCardSkeleton />
        </div>
      </div>,
    );
  } else if (stops.length === 0) {
    // Someone who hasn't been anywhere yet: the line shows where their rooms will go.
    stops.push(
      <div key="hint" className={cn(timeline.stop, timeline.hintStop)}>
        <When />
        <div className={timeline.hint}>
          <p>Rooms you visit will show up here.</p>
          <Link href="/admin/discover/rooms" className={styles.detailsLink}>
            Discover rooms
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </div>,
    );
  }

  return (
    <ScrollSection id="here-heading" title="Your timeline" label="your timeline" testId="here" className={cn(styles.location, timeline.timeline)}>
      <div className={cn(timeline.stop, timeline.now)}>
        <span className={timeline.when}>
          <i className={timeline.nowDot} aria-hidden="true" />
          Now
        </span>
        <div className={timeline.card}>{current}</div>
      </div>
      {stops}
    </ScrollSection>
  );
}
