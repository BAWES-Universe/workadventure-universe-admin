'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, StatusPill, VisitLine, count } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { usePagedSearch } from '../../hooks/use-paged-search';
import type { EntitySummary } from '../../hooks/use-room-analytics';

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

interface WorldResult {
  items: World[];
  totalPages: number;
  total: number;
}

function WorldCard({ world, analytics }: { world: World; analytics?: EntitySummary }) {
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
              ...activityStats(analytics),
            ]}
          />
          <VisitLine you={you} latest={latest} youWereLast={analytics?.youWereLast ?? false} />
        </>
      }
    />
  );
}

export default function DiscoverWorldsPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (!response.ok) {
          router.push('/admin/login');
          return;
        }
        if (!cancelled) setCheckingAuth(false);
      } catch {
        router.push('/admin/login');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once per visit: the router is only used to leave for sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One request per {query, page}: Enter searches, the × clears, a new search starts on page 1.
  const list = usePagedSearch<WorldResult>(
    async ({ query, page }, signal) => {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = query ? `&search=${encodeURIComponent(query)}` : '';
      const response = await authenticatedFetch(`/api/admin/worlds?scope=discover&page=${page}&limit=12${searchParam}`, { signal });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return null;
        }
        throw new Error('Failed to fetch worlds to discover');
      }

      const data = await response.json();
      const all: World[] = data.worlds || [];
      // Hide the default/default/default world path from discovery (universe=default, world=default)
      const filtered = all.filter(
        (w) => !(w.universe?.slug === 'default' && w.slug === 'default'),
      );
      return {
        items: filtered,
        totalPages: data.pagination?.totalPages || 1,
        total: (data.pagination?.total || filtered.length) - (all.length - filtered.length),
      };
    },
    { enabled: !checkingAuth },
  );

  const worlds = useMemo(() => list.data?.items ?? [], [list.data]);
  const totalPages = list.data?.totalPages ?? 1;
  const total = list.data?.total ?? 0;
  const { loading, page, query: search, error } = list;
  const summaries = useEntitySummaries('worlds', useMemo(() => worlds.map((item) => item.id), [worlds]));

  function handlePageChange(nextPage: number) {
    list.setPage(Math.max(1, Math.min(totalPages || 1, nextPage)));
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Worlds" />

      <SearchBox
        value={list.input}
        onChange={list.setInput}
        onSubmit={list.submit}
        onClear={list.clear}
        showClear={Boolean(search)}
        label="Search worlds"
        placeholder="Search worlds"
      />

      {error && <LoadError label="worlds" retry={list.retry} />}

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
              <WorldCard key={world.id} world={world} analytics={summaries.summary(world.id)} />
            ))}
          </div>

          {summaries.failed.length > 0 && <LoadError label="activity for some worlds" retry={() => summaries.retry()} />}

          <Pager page={page} totalPages={totalPages} total={total} noun={['world', 'worlds']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
