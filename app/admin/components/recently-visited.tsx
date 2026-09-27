'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import RoomSignalCard from './room-signal-card';
import type { SignalRoom } from './room-signal-data';
import styles from './room-signal-card.module.css';

interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  roomDescription?: string | null;
  roomFavorites?: number;
  worldId: string;
  worldName: string;
  worldSlug: string;
  universeId: string;
  universeName: string;
  universeSlug: string;
  accessedAt: string;
}

type RecentState = { kind: 'loading' | 'error' } | { kind: 'ready'; rooms: RecentRoom[] };

function asSignalRoom(room: RecentRoom): SignalRoom {
  return {
    id: room.roomId,
    name: room.roomName,
    slug: room.roomSlug,
    description: room.roomDescription,
    _count: { favorites: room.roomFavorites },
    accessedAt: room.accessedAt,
    world: {
      id: room.worldId, name: room.worldName, slug: room.worldSlug,
      universe: { id: room.universeId, name: room.universeName, slug: room.universeSlug },
    },
  };
}

/** Personal, access-filtered destinations: keep the visit trail useful even when optional analytics fail. */
export default function RecentlyVisited({ limit = 4 }: { limit?: number }) {
  const [state, setState] = useState<RecentState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    async function load() {
      try {
        const response = await authenticatedFetch(`/api/admin/rooms/recent?limit=${limit}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Recent rooms unavailable');
        const data = await response.json() as { rooms?: RecentRoom[] };
        if (!Array.isArray(data.rooms)) throw new Error('Invalid recent rooms response');
        if (!controller.signal.aborted) setState({ kind: 'ready', rooms: data.rooms });
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    }
    void load();
    return () => controller.abort();
  }, [limit, retry]);

  return (
    <section className={`observatory-recent ${styles.recentSection}`} data-testid="recently-visited" aria-labelledby="recent-rooms-heading">
      <div className={styles.recentHeading}>
        <div><h2 id="recent-rooms-heading">Recently visited</h2><p>A trail of rooms worth returning to.</p></div>
        {state.kind === 'ready' && state.rooms.length > 0 && <span aria-label={`${state.rooms.length} recent rooms`}>{String(state.rooms.length).padStart(2, '0')}</span>}
      </div>
      {state.kind === 'loading' && <div className={styles.recentGrid} role="status" aria-label="Loading recent rooms"><div className={styles.skeleton} /><div className={styles.skeleton} /></div>}
      {state.kind === 'error' && <div className={styles.notice}><p>We couldn&apos;t load your recent rooms.</p><button type="button" className={styles.retry} onClick={() => setRetry((value) => value + 1)}>Try again</button></div>}
      {state.kind === 'ready' && state.rooms.length === 0 && <div className={styles.notice}><p>Your visits will leave a trail here. Step into a room to begin.</p><Link href="/admin/spaces" className={styles.detailsLink}>Explore universes <ArrowUpRight size={15} aria-hidden="true" /></Link></div>}
      {state.kind === 'ready' && state.rooms.length > 0 && <div className={styles.recentGrid}>{state.rooms.map((room, index) => <RoomSignalCard key={room.roomId} room={asSignalRoom(room)} index={index} />)}</div>}
    </section>
  );
}
