'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { AlertCircle, Loader2, Star, MapPin, Activity, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

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

function formatHourTo12Hour(hour: number): string {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
  if (diffWeeks < 4) return `${diffWeeks} ${diffWeeks === 1 ? 'week' : 'weeks'} ago`;
  if (diffMonths < 12) return `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`;
  return `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`;
}

function StarredRoomCard({ 
  room, 
  onToggleStar 
}: { 
  room: StarredRoom; 
  onToggleStar: (roomId: string) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const [analytics, setAnalytics] = useState<RoomAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/analytics/rooms/${room.id}`);

        if (response.ok) {
          const data = await response.json();
          
          // Calculate peak hour from recent activity in local timezone
          let peakHour = null;
          if (data.recentActivity && data.recentActivity.length > 0) {
            const hourCounts = new Map<number, number>();
            data.recentActivity.forEach((access: any) => {
              const date = new Date(access.accessedAt);
              const hour = date.getHours();
              hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
            });
            const localPeakTimes = Array.from(hourCounts.entries())
              .map(([hour, count]) => ({ hour, count }))
              .sort((a, b) => b.count - a.count);
            if (localPeakTimes.length > 0) {
              peakHour = localPeakTimes[0].hour;
            }
          }
          
          // Fallback to UTC peakTimes if no recent activity
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
        console.error('[StarredRoomCard] Failed to fetch analytics:', err);
      } finally {
        setAnalyticsLoading(false);
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

  return (
    <Link
      href={`/admin/rooms/${room.id}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        className={cn(
          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
          'hover:-translate-y-1 hover:shadow-lg',
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

        <div className="relative flex h-full flex-col p-5">
          <div className="mb-3 flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
              <MapPin className="h-5 w-5 text-muted-foreground" />
            </div>

            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="truncate text-base font-semibold leading-tight">
                {room.name}
              </h3>
              <p className="truncate text-xs font-mono text-muted-foreground">
                {room.world.universe.name} · {room.world.name}
              </p>
            </div>
          </div>

          {room.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {room.description}
            </p>
          )}

          <div className="mt-auto flex items-start justify-between pt-3 text-xs text-muted-foreground">
            <div className="flex flex-col gap-1.5 min-h-[3rem]">
              {analyticsLoading ? (
                <span className="text-muted-foreground">Loading analytics...</span>
              ) : analytics ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-foreground/80">
                      {analytics.totalAccesses.toLocaleString()} accesses
                    </span>
                  </div>
                  {analytics.peakHour !== null && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        Peak: {formatHourTo12Hour(analytics.peakHour)}
                      </span>
                    </div>
                  )}
                  {/* Last visited information */}
                  {analytics.lastVisitedByUser || analytics.lastVisitedOverall ? (
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      {analytics.lastVisitedByUser && (
                        <div className="text-[11px]">
                          <span className="text-muted-foreground/70">Last visited by you: </span>
                          <span className="font-medium text-foreground/80">
                            {formatTimeAgo(new Date(analytics.lastVisitedByUser.accessedAt))}
                          </span>
                        </div>
                      )}
                      {analytics.lastVisitedOverall && (
                        <div className="text-[11px]">
                          {analytics.lastVisitedByUser && 
                           analytics.lastVisitedByUser.accessedAt === analytics.lastVisitedOverall.accessedAt ? (
                            <span className="text-muted-foreground/70 italic">
                              You were the last visitor
                            </span>
                          ) : (
                            <>
                              <span className="text-muted-foreground/70">Most recent visitor: </span>
                              <span className="font-medium text-foreground/80">
                                {formatTimeAgo(new Date(analytics.lastVisitedOverall.accessedAt))}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                      No visits recorded
                    </div>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Access data loading...</span>
              )}
            </div>
          </div>
          <div className="absolute bottom-5 right-5">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggle}
              disabled={toggling}
              className="flex items-center gap-1.5"
            >
              {toggling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Star className={cn(
                  "h-3.5 w-3.5",
                  room.isStarred && "fill-yellow-400 text-yellow-400"
                )} />
              )}
              {room.starCount || 0}
            </Button>
          </div>
        </div>
      </Card>
    </Link>
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
    } catch (err) {
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
    // Find the room
    const room = starredRooms.find((r) => r.id === roomId);
    if (!room) return;

    const previousIsStarred = room.isStarred;
    const previousStarCount = room.starCount;

    // Optimistic update - update the room's starred state but keep it in the list
    // This allows users to revert if they made a mistake
    setStarredRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? {
              ...r,
              isStarred: !previousIsStarred,
              starCount: previousIsStarred ? previousStarCount - 1 : previousStarCount + 1,
            }
          : r
      )
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

      // Update with server data
      setStarredRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? { ...r, isStarred: data.isStarred, starCount: data.starCount }
            : r
        )
      );
    } catch (err) {
      // Revert on error
      setStarredRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? { ...r, isStarred: previousIsStarred, starCount: previousStarCount }
            : r
        )
      );
      alert(err instanceof Error ? err.message : 'Failed to toggle star');
    }
  }

  if (checkingAuth) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">My Stars</h1>
          <p className="text-muted-foreground text-lg">
            Your curated collection of favorite rooms.
          </p>
        </div>
      </div>

      <section className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                className="ml-4"
                onClick={fetchStarredRooms}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && starredRooms.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : starredRooms.length === 0 ? (
          <Empty className="border border-border/70">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Star className="h-6 w-6 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No starred rooms yet</EmptyTitle>
              <EmptyDescription>
                Star rooms you like to find them quickly here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="default" asChild>
                <Link href="/admin/discover/rooms">
                  Discover Rooms
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {starredRooms.map((room) => (
              <StarredRoomCard
                key={room.id}
                room={room}
                onToggleStar={handleToggleStar}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

