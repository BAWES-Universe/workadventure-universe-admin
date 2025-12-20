'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Plus, AlertCircle, Loader2, Search, X } from 'lucide-react';
import { UniverseCard, UniverseAnalytics } from '../../universes/universe-card';

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  owner: {
    id?: string;
    name: string | null;
    email: string | null;
  };
  _count?: {
    worlds?: number;
  };
}

export default function DiscoverUniversesPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [analyticsByUniverse, setAnalyticsByUniverse] = useState<Record<string, UniverseAnalytics>>({});

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

      await fetchUniverses(1, '');
    } catch {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchUniverses(nextPage?: number, nextSearch?: string) {
    const pageToUse = nextPage ?? page;
    const searchValue = nextSearch ?? search;

    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = searchValue ? `&search=${encodeURIComponent(searchValue)}` : '';
      const response = await authenticatedFetch(
        `/api/admin/universes?scope=discover&page=${pageToUse}&limit=12${searchParam}`,
      );

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch universes to discover');
      }

      const data = await response.json();
      const all: Universe[] = data.universes || [];
      // Extra safety: hide default universe client-side as well
      const filtered = all.filter((u) => u.slug !== 'default');

      setUniverses(filtered);
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
    fetchUniverses(1, trimmed);
  }

  function handleClear() {
    setSearchInput('');
    setSearch('');
    setPage(1);
    fetchUniverses(1, '');
  }

  useEffect(() => {
    async function fetchAnalyticsForUniverses() {
      const missing = universes.filter((universe) => !analyticsByUniverse[universe.id]);
      if (missing.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          missing.map(async (universe) => {
            try {
              const response = await authenticatedFetch(
                `/api/admin/analytics/universes/${universe.id}`,
              );
              if (!response.ok) {
                return null;
              }
              const data = await response.json();
              
              return {
                universeId: universe.id,
                totalAccesses: data.totalAccesses || 0,
                lastVisitedByUser: data.lastVisitedByUser || null,
                lastVisitedOverall: data.lastVisitedOverall || null,
              };
            } catch {
              return null;
            }
          }),
        );

        setAnalyticsByUniverse((prev) => {
          const updated: Record<string, UniverseAnalytics> = { ...prev };
          for (const result of results) {
            if (result) {
              updated[result.universeId] = {
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

    if (universes.length > 0) {
      fetchAnalyticsForUniverses();
    }
  }, [universes, analyticsByUniverse]);

  function handlePageChange(nextPage: number) {
    const safePage = Math.max(1, Math.min(totalPages || 1, nextPage));
    if (safePage === page) return;
    setPage(safePage);
    fetchUniverses(safePage);
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
          <h1 className="text-4xl font-bold tracking-tight">Discover Universes</h1>
          <p className="text-muted-foreground text-lg">
            Explore public universes created by other admins.
          </p>
        </div>
        <Button variant="default" asChild>
          <Link href="/admin/universes/new">
            <Plus className="mr-2 h-4 w-4" />
            Create Universe
          </Link>
        </Button>
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
                  placeholder="Search universes by name, slug, or description..."
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
              onClick={() => fetchUniverses()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && universes.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : universes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no public universes to discover yet. Check back later!
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {universes.map((universe) => (
              <UniverseCard
                key={universe.id}
                universe={universe}
                ownedByCurrentUser={false}
                showVisibility={false}
                showOwner={true}
                analytics={analyticsByUniverse[universe.id]}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground">
                Showing page {page} of {totalPages} ({total}{' '}
                {total === 1 ? 'universe' : 'universes'})
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


