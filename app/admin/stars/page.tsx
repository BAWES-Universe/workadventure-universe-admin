'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { activityStats } from '@/lib/analytics-peak';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine, VisitLine } from '../components/ds';
import { useEntitySummaries } from '../hooks/use-entity-summaries';
import type { EntitySummary } from '../hooks/use-room-analytics';

interface StarredRoom {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  wamUrl: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  isStarred: boolean;
  starCount: number;
  favoritedAt: string;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

/** A universe or world you starred itself. */
interface StarredPlace {
  kind: 'universe' | 'world';
  id: string;
  name: string;
  /** "by Faisal" for a universe, the universe's name for a world. */
  context: string;
  isStarred: boolean;
  starCount: number;
  favoritedAt: string;
}

function StarredPlaceRow({ place, onToggleStar }: { place: StarredPlace; onToggleStar: (place: StarredPlace) => Promise<void> }) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setToggling(true);
    await onToggleStar(place);
    setToggling(false);
  };

  return (
    <EntityRow
      href={`/admin/${place.kind === 'universe' ? 'universes' : 'worlds'}/${place.id}`}
      kind={place.kind}
      title={place.name}
      context={<StatLine items={[place.context]} />}
      trailing={
        <Button
          variant="outline"
          className="h-9 gap-1.5 px-3"
          onClick={handleToggle}
          disabled={toggling}
          aria-pressed={place.isStarred}
          aria-label={place.isStarred ? `Unstar ${place.name}` : `Star ${place.name}`}
        >
          {toggling ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Star className={cn(place.isStarred && 'fill-[var(--kind-star-solid)] text-[var(--kind-star-solid)]')} aria-hidden="true" />
          )}
          {place.starCount || 0}
        </Button>
      }
    />
  );
}

function StarredRoomRow({
  room,
  analytics,
  onToggleStar,
}: {
  room: StarredRoom;
  analytics?: EntitySummary;
  onToggleStar: (roomId: string) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setToggling(true);
    await onToggleStar(room.id);
    setToggling(false);
  };

  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;

  return (
    <EntityRow
      href={`/admin/rooms/${room.id}`}
      kind="star"
      title={room.name}
      context={<StatLine items={[`${room.world.universe.name} › ${room.world.name}`]} />}
      meta={
        analytics && (
          <>
            <StatLine items={activityStats(analytics)} />
            <VisitLine you={you} latest={latest} youWereLast={analytics.youWereLast} />
          </>
        )
      }
      trailing={
        <Button
          variant="outline"
          className="h-9 gap-1.5 px-3"
          onClick={handleToggle}
          disabled={toggling}
          aria-pressed={room.isStarred}
          aria-label={room.isStarred ? `Unstar ${room.name}` : `Star ${room.name}`}
        >
          {toggling ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Star className={cn(room.isStarred && 'fill-[var(--kind-star-solid)] text-[var(--kind-star-solid)]')} aria-hidden="true" />
          )}
          {room.starCount || 0}
        </Button>
      }
    />
  );
}

export default function MyStarsPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [starredRooms, setStarredRooms] = useState<StarredRoom[]>([]);
  const [starredPlaces, setStarredPlaces] = useState<StarredPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Each room's activity, asked for once (starring and unstarring keep the list, so nothing is asked again).
  const roomIds = useMemo(() => starredRooms.map((room) => room.id), [starredRooms]);
  const summaries = useEntitySummaries('rooms', roomIds);

  useEffect(() => {
    checkAuthAndLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAuthAndLoad() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }

      await fetchStarredRooms();
    } catch {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchStarredRooms() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/stars/rooms');

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch starred rooms');
      }

      const data = await response.json();
      setStarredRooms(data.rooms || []);
      setError(null);
      // Universes and worlds you starred themselves sit in the same list; if they can't load, the rooms still show.
      try {
        const placesResponse = await authenticatedFetch('/api/admin/stars/places');
        if (placesResponse.ok) {
          const places = await placesResponse.json();
          setStarredPlaces([
            ...(places.universes ?? []).map((u: { id: string; name: string; ownerName: string | null; isStarred: boolean; starCount: number; favoritedAt: string }) => ({
              kind: 'universe' as const, id: u.id, name: u.name, context: u.ownerName ? `Universe · by ${u.ownerName}` : 'Universe', isStarred: u.isStarred, starCount: u.starCount, favoritedAt: u.favoritedAt,
            })),
            ...(places.worlds ?? []).map((w: { id: string; name: string; universe: { name: string }; isStarred: boolean; starCount: number; favoritedAt: string }) => ({
              kind: 'world' as const, id: w.id, name: w.name, context: `World · in ${w.universe.name}`, isStarred: w.isStarred, starCount: w.starCount, favoritedAt: w.favoritedAt,
            })),
          ]);
        }
      } catch {
        // Rooms only.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleStar(roomId: string) {
    const room = starredRooms.find((r) => r.id === roomId);
    if (!room) return;

    const previousIsStarred = room.isStarred;
    const previousStarCount = room.starCount;

    // Optimistic update: keep the room in the list, so a mistaken unstar can be undone.
    setStarredRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? {
              ...r,
              isStarred: !previousIsStarred,
              starCount: previousIsStarred ? previousStarCount - 1 : previousStarCount + 1,
            }
          : r,
      ),
    );

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${roomId}/favorite`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to toggle star');
      }

      const data = await response.json();

      setStarredRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, isStarred: data.isStarred, starCount: data.starCount } : r)),
      );
    } catch (err) {
      setStarredRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, isStarred: previousIsStarred, starCount: previousStarCount } : r)),
      );
      alert(err instanceof Error ? err.message : 'Failed to toggle star');
    }
  }

  async function handleTogglePlaceStar(place: StarredPlace) {
    const apply = (next: { isStarred: boolean; starCount: number }) =>
      setStarredPlaces((prev) => prev.map((p) => (p.kind === place.kind && p.id === place.id ? { ...p, ...next } : p)));
    const before = { isStarred: place.isStarred, starCount: place.starCount };
    // Kept in the list, so a mistaken unstar can be undone.
    apply({ isStarred: !before.isStarred, starCount: Math.max(0, before.starCount + (before.isStarred ? -1 : 1)) });
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/${place.kind === 'universe' ? 'universes' : 'worlds'}/${place.id}/favorite`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to toggle star');
      const data = await response.json();
      apply({ isStarred: !!data.isStarred, starCount: typeof data.starCount === 'number' ? data.starCount : before.starCount });
    } catch (err) {
      apply(before);
      alert(err instanceof Error ? err.message : 'Failed to toggle star');
    }
  }

  // Rooms, universes and worlds in one list, newest star first.
  const items = [
    ...starredRooms.map((room) => ({ type: 'room' as const, at: room.favoritedAt, room })),
    ...starredPlaces.map((place) => ({ type: 'place' as const, at: place.favoritedAt, place })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Stars" />

      <section className="grid min-w-0 gap-3" aria-label="Starred">
        {error && <LoadError label="your starred rooms" retry={fetchStarredRooms} />}

        {checkingAuth || (loading && items.length === 0) ? (
          <LoadingRows label="your starred rooms" rows={3} />
        ) : items.length === 0 ? (
          !error && (
            <EmptyCard
              kind="star"
              title="Keep a way back to rooms you like."
              text="Star a room from its page and it shows up here, one tap from a visit."
              href="/admin/discover/rooms"
              action="Find rooms"
            />
          )
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {items.map((item) =>
              item.type === 'room' ? (
                <StarredRoomRow key={`room-${item.room.id}`} room={item.room} analytics={summaries.summary(item.room.id)} onToggleStar={handleToggleStar} />
              ) : (
                <StarredPlaceRow key={`${item.place.kind}-${item.place.id}`} place={item.place} onToggleStar={handleTogglePlaceStar} />
              ),
            )}
          </div>
        )}

        {starredRooms.length > 0 && summaries.failed.length > 0 && (
          <LoadError label="activity for some starred rooms" retry={() => summaries.retry()} />
        )}
      </section>
    </div>
  );
}
