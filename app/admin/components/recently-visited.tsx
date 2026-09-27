'use client';

import { useEffect, useState } from 'react';
import { Clock, Navigation } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { useWorkAdventure } from '../workadventure-context';
import { ListGroup, ListRow, SectionHeading } from './shell/list-row';

interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  worldId: string;
  worldName: string;
  worldSlug: string;
  universeId: string;
  universeName: string;
  universeSlug: string;
  accessedAt: string;
}

/**
 * The rooms you were in most recently (yours alone, and only the ones you may still see), each one tap from its
 * page and one from a visit. Empty for a newcomer, and then it says nothing at all.
 */
export default function RecentlyVisited({ limit = 4 }: { limit?: number }) {
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [rooms, setRooms] = useState<RecentRoom[] | null>(null);
  const [visiting, setVisiting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/admin/rooms/recent?limit=${limit}`)
      .then(async (response) => (response.ok ? (((await response.json()).rooms as RecentRoom[]) ?? []) : []))
      .catch(() => [] as RecentRoom[])
      .then((list) => {
        if (!cancelled) setRooms(list);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  if (rooms === null) {
    return (
      <section>
        <SectionHeading title="Recently visited" />
        <ListGroup>
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </ListGroup>
      </section>
    );
  }

  if (rooms.length === 0) return null;

  async function visit(room: RecentRoom) {
    setVisiting(room.roomId);
    try {
      await navigateToRoom(`/@/${room.universeSlug}/${room.worldSlug}/${room.roomSlug}`);
    } catch (cause) {
      console.error('[RecentlyVisited] Could not visit', cause);
    } finally {
      setVisiting(null);
    }
  }

  return (
    <section data-testid="recently-visited">
      <SectionHeading title="Recently visited" />
      <ListGroup>
        {rooms.map((room) => (
          <ListRow
            key={room.roomId}
            href={`/admin/rooms/${room.roomId}`}
            icon={Clock}
            title={room.roomName}
            subtitle={`${room.worldName} · ${room.universeName} · ${timeAgo(new Date(room.accessedAt))}`}
            trailing={
              isReady ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void visit(room);
                  }}
                  disabled={visiting === room.roomId}
                  aria-label={`Visit ${room.roomName}`}
                  className="orbit-press inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/70 bg-elevated px-3 text-xs font-medium text-foreground hover:border-primary/40 disabled:opacity-60"
                >
                  <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
                  Visit
                </button>
              ) : undefined
            }
          />
        ))}
      </ListGroup>
    </section>
  );
}
