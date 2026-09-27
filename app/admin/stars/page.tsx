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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Stars" />

      <section className="grid min-w-0 gap-3" aria-label="Starred rooms">
        {error && <LoadError label="your starred rooms" retry={fetchStarredRooms} />}

        {checkingAuth || (loading && starredRooms.length === 0) ? (
          <LoadingRows label="your starred rooms" rows={3} />
        ) : starredRooms.length === 0 ? (
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
            {starredRooms.map((room) => (
              <StarredRoomRow key={room.id} room={room} analytics={summaries.summary(room.id)} onToggleStar={handleToggleStar} />
            ))}
          </div>
        )}

        {starredRooms.length > 0 && summaries.failed.length > 0 && (
          <LoadError label="activity for some starred rooms" retry={() => summaries.retry()} />
        )}
      </section>
    </div>
  );
}
