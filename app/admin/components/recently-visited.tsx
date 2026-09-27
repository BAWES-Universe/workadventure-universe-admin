'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { RoomCard, RoomCardSkeleton } from './room-card';
import styles from './room-card.module.css';

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

/**
 * The rooms you were in lately (yours alone, only ones you may still see, not the ones already shown under Where you
 * are), each with its numbers and a Visit.
 */
export default function RecentlyVisited({ limit = 4, excludeRoomIds = [] }: { limit?: number; excludeRoomIds?: string[] }) {
  const [rooms, setRooms] = useState<RecentRoom[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Two extra, in case the rooms shown under Where you are are among them.
    authenticatedFetch(`/api/admin/rooms/recent?limit=${limit + 2}`)
      .then(async (response) => (response.ok ? (((await response.json()).rooms as RecentRoom[]) ?? []) : []))
      .catch(() => [] as RecentRoom[])
      .then((list) => {
        if (!cancelled) setRooms(list);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  const shown = rooms?.filter((room) => !excludeRoomIds.includes(room.roomId)).slice(0, limit) ?? null;

  return (
    <section className={styles.recentSection} data-testid="recently-visited" aria-labelledby="recent-heading">
      <div className={styles.recentHeading}>
        <div>
          <h2 id="recent-heading" className="orbit-display">
            Recently visited
          </h2>
          <p>Rooms you were in lately.</p>
        </div>
        {shown && shown.length > 0 && <span aria-hidden="true">{String(shown.length).padStart(2, '0')}</span>}
      </div>
      {shown === null ? (
        <div className={styles.recentGrid}>
          <RoomCardSkeleton />
          <RoomCardSkeleton />
        </div>
      ) : shown.length === 0 ? (
        <div className={styles.notice}>
          <p>Rooms you visit will show up here.</p>
          <Link href="/admin/discover/rooms" className={styles.detailsLink}>
            Discover rooms
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className={styles.recentGrid}>
          {shown.map((room, index) => (
            <RoomCard
              key={room.roomId}
              kind="trail"
              index={index}
              room={{
                id: room.roomId,
                name: room.roomName,
                slug: room.roomSlug,
                description: room.roomDescription,
                favorites: room.roomFavorites,
                world: { id: room.worldId, name: room.worldName, slug: room.worldSlug },
                universe: { id: room.universeId, name: room.universeName, slug: room.universeSlug },
                accessedAt: room.accessedAt,
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
