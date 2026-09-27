'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { RoomCard, RoomCardSkeleton } from './room-card';

interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  roomDescription: string | null;
  roomFavorites: number;
  worldName: string;
  worldSlug: string;
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
    <section data-testid="recently-visited" aria-labelledby="recent-heading">
      <div className="mb-3">
        <h2 id="recent-heading" className="text-lg font-semibold tracking-tight">
          Recently visited
        </h2>
        <p className="text-sm text-muted-foreground">Jump back into rooms you were in lately.</p>
      </div>
      {shown === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <RoomCardSkeleton />
          <RoomCardSkeleton />
        </div>
      ) : shown.length === 0 ? (
        <div className="orbit-card p-4 text-sm text-muted-foreground">
          Rooms you visit will show up here.{' '}
          <Link href="/admin/discover/rooms" className="font-medium text-primary hover:underline">
            Discover rooms
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((room) => (
            <RoomCard
              key={room.roomId}
              kind="trail"
              eyebrow={timeAgo(new Date(room.accessedAt))}
              room={{
                id: room.roomId,
                name: room.roomName,
                slug: room.roomSlug,
                description: room.roomDescription,
                favorites: room.roomFavorites,
                world: { name: room.worldName, slug: room.worldSlug },
                universe: { name: room.universeName, slug: room.universeSlug },
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
