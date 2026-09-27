'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine, VisitLine, count } from '../components/ds';

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

interface RoomAnalytics {
  totalAccesses: number;
  peakHour: number | null;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
}

/** "4 PM", "12 AM". */
function formatHour(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown} ${suffix}`;
}

function StarredRoomRow({ room, onToggleStar }: { room: StarredRoom; onToggleStar: (roomId: string) => Promise<void> }) {
  const [toggling, setToggling] = useState(false);
  const [analytics, setAnalytics] = useState<RoomAnalytics | null>(null);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/analytics/rooms/${room.id}`);

        if (response.ok) {
          const data = await response.json();

          // Peak hour from recent activity, in local time
          let peakHour = null;
          if (data.recentActivity && data.recentActivity.length > 0) {
            const hourCounts = new Map<number, number>();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.recentActivity.forEach((access: any) => {
              const hour = new Date(access.accessedAt).getHours();
              hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
            });
            const localPeakTimes = Array.from(hourCounts.entries())
              .map(([hour, total]) => ({ hour, total }))
              .sort((a, b) => b.total - a.total);
            if (localPeakTimes.length > 0) {
              peakHour = localPeakTimes[0].hour;
            }
          }

          // Fall back to UTC peakTimes if no recent activity
          if (peakHour === null && Array.isArray(data.peakTimes) && data.peakTimes.length > 0) {
            peakHour = data.peakTimes[0].hour;
          }

          setAnalytics({
            totalAccesses: data.totalAccesses || 0,
            peakHour,
            lastVisitedByUser: data.lastVisitedByUser || null,
            lastVisitedOverall: data.lastVisitedOverall || null,
          });
        }
      } catch (err) {
        console.error('[StarredRoomRow] Failed to fetch analytics:', err);
      }
    }

    fetchAnalytics();
  }, [room.id]);

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
            <StatLine
              items={[
                count(analytics.totalAccesses, 'visit'),
                analytics.peakHour !== null && `busiest at ${formatHour(analytics.peakHour)}`,
              ]}
            />
            <VisitLine you={you} latest={latest} youWereLast={Boolean(you && latest && you === latest)} />
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
              <StarredRoomRow key={room.id} room={room} onToggleStar={handleToggleStar} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
