'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, StatusPill, VisitLine, count } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';

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
    favorites?: number;
  };
}

interface WorldAnalytics {
  totalAccesses: number;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null; userName?: string | null; userEmail?: string | null } | null;
}

function WorldCard({ world, analytics }: { world: World; analytics?: WorldAnalytics }) {
  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
  const stars = world._count?.favorites ?? 0;
  return (
    <EntityCard
      href={`/admin/worlds/${world.id}`}
      kind="world"
      title={world.name}
      context={<StatLine items={[world.universe.name]} />}
      pills={world.featured ? <StatusPill status="featured" /> : undefined}
      description={world.description}
      aside={stars > 0 ? `★ ${stars}` : undefined}
      meta={
        <>
          <StatLine
            items={[
              count(world._count?.rooms ?? 0, 'room'),
              count(world._count?.members ?? 0, 'member'),
              analytics && count(analytics.totalAccesses, 'visit'),
            ]}
          />
          <VisitLine you={you} latest={latest} youWereLast={Boolean(you && latest && you === latest)} />
        </>
      }
    />
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

  function handleSearchSubmit() {
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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Worlds" />

      <SearchBox
        value={searchInput}
        onChange={setSearchInput}
        onSubmit={handleSearchSubmit}
        onClear={handleClear}
        showClear={Boolean(search)}
        label="Search worlds"
        placeholder="Search worlds"
      />

      {error && <LoadError label="worlds" retry={() => fetchWorlds()} />}

      {checkingAuth || (loading && worlds.length === 0) ? (
        <LoadingRows label="worlds" rows={3} />
      ) : worlds.length === 0 ? (
        !error &&
        (search ? (
          <p className="text-sm text-muted-foreground" role="status">
            No worlds match “{search}”.
          </p>
        ) : (
          <EmptyCard kind="world" title="No public worlds yet." text="Check back later: public worlds show up here." />
        ))
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3">
            {worlds.map((world) => (
              <WorldCard key={world.id} world={world} analytics={analyticsByWorld[world.id]} />
            ))}
          </div>

          <Pager page={page} totalPages={totalPages} total={total} noun={['world', 'worlds']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
