'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Search, X, MapPin, Star, Activity, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  isPublic: boolean;
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
  _count?: {
    favorites?: number;
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

function RoomCard({ room, analytics }: { room: Room; analytics?: RoomAnalytics }) {
  const favorites = room._count?.favorites ?? 0;

  return (
    <Link
      href={`/admin/rooms/${room.id}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`View room ${room.name} in world ${room.world.name}`}
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
              {analytics ? (
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
            <div className="flex items-center gap-1 text-primary self-end">
              <Star className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{favorites}</span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function DiscoverRoomsPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [analyticsByRoom, setAnalyticsByRoom] = useState<Record<string, RoomAnalytics>>({});
  const [hasAdjustedForDefault, setHasAdjustedForDefault] = useState(false);

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

      setSearchInput('');
      setSearch('');
      setPage(1);

      await fetchRooms(1, '');
    } catch {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchRooms(nextPage?: number, nextSearch?: string) {
    const pageToUse = nextPage ?? page;
    const searchValue = nextSearch ?? search;

    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = searchValue ? `&search=${encodeURIComponent(searchValue)}` : '';
      const response = await authenticatedFetch(
        `/api/admin/rooms?scope=discover&page=${pageToUse}&limit=12${searchParam}`,
      );

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch rooms to discover');
      }

      const data = await response.json();
      const all: Room[] = data.rooms || [];
      // Hide the default/default/default room path from discovery
      const filtered = all.filter(
        (r) =>
          !(
            r.world?.universe?.slug === 'default' &&
            r.world?.slug === 'default' &&
            r.slug === 'default'
          ),
      );

      const defaultRoomFiltered = all.length > filtered.length;
      
      setRooms(filtered);
      setTotalPages(data.pagination?.totalPages || 1);
      
      // Adjust total only once if we detect the default room was filtered
      // The API total includes the default room, so we need to subtract 1
      const apiTotal = data.pagination?.total || 0;
      if (defaultRoomFiltered && !hasAdjustedForDefault) {
        setTotal(Math.max(0, apiTotal - 1));
        setHasAdjustedForDefault(true);
      } else if (!hasAdjustedForDefault) {
        // If we haven't seen the default room yet, use the API total as-is
        // (it might not exist, or it might be on a different page)
        setTotal(apiTotal);
      }
      // If we've already adjusted, keep the current total
      
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    async function fetchAnalyticsForRooms() {
      const missing = rooms.filter((room) => !analyticsByRoom[room.id]);
      if (missing.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          missing.map(async (room) => {
            try {
              const response = await authenticatedFetch(
                `/api/admin/analytics/rooms/${room.id}`,
              );
              if (!response.ok) {
                return null;
              }
              const data = await response.json();
              
              // Calculate peak hour from recent activity in local timezone (like detail page)
              let peakHour = null;
              if (data.recentActivity && data.recentActivity.length > 0) {
                const hourCounts = new Map<number, number>();
                data.recentActivity.forEach((access: any) => {
                  const date = new Date(access.accessedAt);
                  const hour = date.getHours(); // Local timezone
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
              
              return {
                roomId: room.id,
                totalAccesses: data.totalAccesses || 0,
                peakHour,
                lastVisitedByUser: data.lastVisitedByUser || null,
                lastVisitedOverall: data.lastVisitedOverall || null,
              };
            } catch {
              return null;
            }
          }),
        );

        setAnalyticsByRoom((prev) => {
          const updated: Record<string, RoomAnalytics> = { ...prev };
          for (const result of results) {
            if (result) {
              updated[result.roomId] = {
                totalAccesses: result.totalAccesses,
                peakHour: result.peakHour,
                lastVisitedByUser: result.lastVisitedByUser || null,
                lastVisitedOverall: result.lastVisitedOverall || null,
              };
            }
          }
          return updated;
        });
      } catch {
        // Ignore analytics fetch errors; cards will show a placeholder
      }
    }

    if (rooms.length > 0) {
      fetchAnalyticsForRooms();
    }
  }, [rooms, analyticsByRoom]);

  // Rooms are already sorted by accesses from the API (server-side sorting)
  // No need to sort client-side
  const sortedRooms = rooms;

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    setPage(1);
    setSearch(trimmed);
    fetchRooms(1, trimmed);
  }

  function handleClear() {
    setSearchInput('');
    setSearch('');
    setPage(1);
    setHasAdjustedForDefault(false); // Reset adjustment when clearing search
    fetchRooms(1, '');
  }

  function handlePageChange(nextPage: number) {
    const safePage = Math.max(1, Math.min(totalPages || 1, nextPage));
    if (safePage === page) return;
    setPage(safePage);
    fetchRooms(safePage);
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
      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Discover Rooms</h1>
        <p className="text-muted-foreground text-lg">
          Find public rooms across worlds and universes to explore layouts and experiences.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSearchSubmit} className="space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search rooms by name, slug, or description..."
                  className="pl-9"
                />
              </div>
              <Button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Search
                  </>
                )}
              </Button>
              {search && (
                <Button type="button" variant="outline" onClick={handleClear}>
                  <X className="mr-2 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

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
              onClick={() => fetchRooms()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && rooms.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : rooms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no public rooms to discover yet. Check back later!
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sortedRooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                analytics={analyticsByRoom[room.id]}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground">
                Showing page {page} of {totalPages} ({total}{' '}
                {total === 1 ? 'room' : 'rooms'})
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page === 1 || loading}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page === totalPages || loading}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


