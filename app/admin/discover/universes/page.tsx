'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, StatusPill, VisitLine, count } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';

interface UniverseAnalytics {
  totalAccesses: number;
  lastVisitedByUser: { accessedAt: string } | null;
  lastVisitedOverall: { accessedAt: string } | null;
}

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

  function handleSearchSubmit() {
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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Universes" />

      <SearchBox
        value={searchInput}
        onChange={setSearchInput}
        onSubmit={handleSearchSubmit}
        onClear={handleClear}
        showClear={Boolean(search)}
        label="Search universes"
        placeholder="Search universes"
      />

      {error && <LoadError label="universes" retry={() => fetchUniverses()} />}

      {checkingAuth || (loading && universes.length === 0) ? (
        <LoadingRows label="universes" rows={3} />
      ) : universes.length === 0 ? (
        !error &&
        (search ? (
          <p className="text-sm text-muted-foreground" role="status">
            No universes match “{search}”.
          </p>
        ) : (
          <EmptyCard kind="universe" title="No public universes yet." text="Check back later, or make yours public on You." />
        ))
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3">
            {universes.map((universe) => {
              const analytics = analyticsByUniverse[universe.id];
              const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
              const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
              return (
                <EntityCard
                  key={universe.id}
                  href={`/admin/universes/${universe.id}`}
                  kind="universe"
                  universeId={universe.id}
                  title={universe.name}
                  pills={universe.featured ? <StatusPill status="featured" /> : undefined}
                  description={universe.description}
                  meta={
                    <>
                      <StatLine
                        items={[
                          count(universe._count?.worlds, 'world'),
                          analytics && count(analytics.totalAccesses, 'visit'),
                          universe.owner?.name && `by ${universe.owner.name}`,
                        ]}
                      />
                      <VisitLine you={you} latest={latest} youWereLast={Boolean(you && latest && you === latest)} />
                    </>
                  }
                />
              );
            })}
          </div>

          <Pager page={page} totalPages={totalPages} total={total} noun={['universe', 'universes']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
