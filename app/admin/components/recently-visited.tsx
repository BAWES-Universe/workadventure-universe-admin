'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { isRecord, useCollection } from '../hooks/use-collection';
import { LoadError, SectionHeader } from './ds';
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

const isRecentRoom = (value: unknown): value is RecentRoom =>
  isRecord(value) && typeof value.roomId === 'string' && typeof value.roomName === 'string';

/**
 * The rooms you were in lately (yours alone, only ones you may still see, not the ones already shown under Where you
 * are), each with its numbers and a Visit.
 */
export default function RecentlyVisited({ limit = 4, excludeRoomIds = [] }: { limit?: number; excludeRoomIds?: string[] }) {
  // Two extra, in case the rooms shown under Where you are are among them. A failure says so; it never looks like
  // an empty history.
  const { result, retry } = useCollection(`/api/admin/rooms/recent?limit=${limit + 2}`, 'rooms', isRecentRoom);
  const rooms = result.status === 'ready' ? result.items : null;

  const shown = rooms?.filter((room) => !excludeRoomIds.includes(room.roomId)).slice(0, limit) ?? null;

  return (
    <section className={styles.recentSection} data-testid="recently-visited" aria-labelledby="recent-heading">
      <SectionHeader id="recent-heading" title="Recently visited" count={shown?.length} />
      {result.status === 'error' ? (
        <LoadError label="your recent rooms" retry={retry} />
      ) : shown === null ? (
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
