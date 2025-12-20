'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Search, X, Globe, Users as UsersIcon, Activity, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface World {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  universe: {
    id: string;
    name: string;
    slug: string;
  };
  _count?: {
    rooms?: number;
    members?: number;
  };
}

interface WorldAnalytics {
  totalAccesses: number;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null; userName?: string | null; userEmail?: string | null } | null;
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

function WorldCard({ world, analytics }: { world: World; analytics?: WorldAnalytics }) {
  const roomsCount = world._count?.rooms ?? 0;
  const membersCount = world._count?.members ?? 0;

  return (
    <Link
      href={`/admin/worlds/${world.id}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`View world ${world.name} in universe ${world.universe.name}`}
    >
      <Card
        className={cn(
          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
          'hover:-translate-y-1 hover:shadow-lg',
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

        <div className="relative flex h-full flex-col p-5">
          <div className="mb-4 flex items-start gap-3">
            {world.thumbnailUrl ? (
              <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={world.thumbnailUrl}
                  alt={world.name}
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border bg-muted text-lg font-semibold">
                {world.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate text-base font-semibold leading-tight">
                  {world.name}
                </h3>
              </div>
              <p className="truncate text-xs font-mono text-muted-foreground">
                {world.universe.name} · {world.slug}
              </p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {world.featured && <Badge variant="outline">Featured</Badge>}
            </div>
            </div>
          </div>

          {world.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {world.description}
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
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                      {membersCount === 1 ? 'member' : 'members'}
                    </span>
                  </div>
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
              <UsersIcon className="h-4 w-4" aria-hidden="true" />
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function DiscoverWorldsPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [analyticsByWorld, setAnalyticsByWorld] = useState<Record<string, WorldAnalytics>>({});

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

      await fetchWorlds(1, '');
    } catch {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchWorlds(nextPage?: number, nextSearch?: string) {
    const pageToUse = nextPage ?? page;
    const searchValue = nextSearch ?? search;

    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = searchValue ? `&search=${encodeURIComponent(searchValue)}` : '';
      const response = await authenticatedFetch(
        `/api/admin/worlds?scope=discover&page=${pageToUse}&limit=12${searchParam}`,
      );

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch worlds to discover');
      }

      const data = await response.json();
      const all: World[] = data.worlds || [];
      // Hide the default/default/default world path from discovery (universe=default, world=default)
      const filtered = all.filter(
        (w) => !(w.universe?.slug === 'default' && w.slug === 'default'),
      );

      setWorlds(filtered);
      setTotalPages(data.pagination?.totalPages || 1);
      setTotal((data.pagination?.total || filtered.length) - (all.length - filtered.length));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    setPage(1);
    setSearch(trimmed);
    fetchWorlds(1, trimmed);
  }

  function handleClear() {
    setSearchInput('');
    setSearch('');
    setPage(1);
    fetchWorlds(1, '');
  }

  useEffect(() => {
    async function fetchAnalyticsForWorlds() {
      const missing = worlds.filter((world) => !analyticsByWorld[world.id]);
      if (missing.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          missing.map(async (world) => {
            try {
              const response = await authenticatedFetch(
                `/api/admin/analytics/worlds/${world.id}`,
              );
              if (!response.ok) {
                return null;
              }
              const data = await response.json();
              
              return {
                worldId: world.id,
                totalAccesses: data.totalAccesses || 0,
                lastVisitedByUser: data.lastVisitedByUser || null,
                lastVisitedOverall: data.lastVisitedOverall || null,
              };
            } catch {
              return null;
            }
          }),
        );

        setAnalyticsByWorld((prev) => {
          const updated: Record<string, WorldAnalytics> = { ...prev };
          for (const result of results) {
            if (result) {
              updated[result.worldId] = {
                totalAccesses: result.totalAccesses,
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

    if (worlds.length > 0) {
      fetchAnalyticsForWorlds();
    }
  }, [worlds, analyticsByWorld]);

  function handlePageChange(nextPage: number) {
    const safePage = Math.max(1, Math.min(totalPages || 1, nextPage));
    if (safePage === page) return;
    setPage(safePage);
    fetchWorlds(safePage);
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
        <h1 className="text-4xl font-bold tracking-tight">Discover Worlds</h1>
        <p className="text-muted-foreground text-lg">
          Browse public worlds across universes to explore and take inspiration from.
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
                  placeholder="Search worlds by name, slug, or description..."
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
              onClick={() => fetchWorlds()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && worlds.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : worlds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no public worlds to discover yet. Check back later!
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {worlds.map((world) => (
              <WorldCard key={world.id} world={world} analytics={analyticsByWorld[world.id]} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground">
                Showing page {page} of {totalPages} ({total}{' '}
                {total === 1 ? 'world' : 'worlds'})
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


