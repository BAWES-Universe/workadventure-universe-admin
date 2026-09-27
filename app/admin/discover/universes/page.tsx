'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, StatusPill, VisitLine, count } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { usePagedSearch } from '../../hooks/use-paged-search';

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

interface UniverseResult {
  items: Universe[];
  totalPages: number;
  total: number;
}

export default function DiscoverUniversesPage() {
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
  const list = usePagedSearch<UniverseResult>(
    async ({ query, page }, signal) => {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = query ? `&search=${encodeURIComponent(query)}` : '';
      const response = await authenticatedFetch(`/api/admin/universes?scope=discover&page=${page}&limit=12${searchParam}`, { signal });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return null;
        }
        throw new Error('Failed to fetch universes to discover');
      }

      const data = await response.json();
      const all: Universe[] = data.universes || [];
      // Extra safety: hide default universe client-side as well
      const filtered = all.filter((u) => u.slug !== 'default');
      return {
        items: filtered,
        totalPages: data.pagination?.totalPages || 1,
        total: (data.pagination?.total || filtered.length) - (all.length - filtered.length),
      };
    },
    { enabled: !checkingAuth },
  );

  const universes = useMemo(() => list.data?.items ?? [], [list.data]);
  const totalPages = list.data?.totalPages ?? 1;
  const total = list.data?.total ?? 0;
  const { loading, page, query: search, error } = list;
  const summaries = useEntitySummaries('universes', useMemo(() => universes.map((item) => item.id), [universes]));

  function handlePageChange(nextPage: number) {
    list.setPage(Math.max(1, Math.min(totalPages || 1, nextPage)));
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Universes" />

      <SearchBox
        value={list.input}
        onChange={list.setInput}
        onSubmit={list.submit}
        onClear={list.clear}
        showClear={Boolean(search)}
        label="Search universes"
        placeholder="Search universes"
      />

      {error && <LoadError label="universes" retry={list.retry} />}

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
              const analytics = summaries.summary(universe.id);
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
                          ...activityStats(analytics),
                          universe.owner?.name && `by ${universe.owner.name}`,
                        ]}
                      />
                      <VisitLine you={you} latest={latest} youWereLast={analytics?.youWereLast ?? false} />
                    </>
                  }
                />
              );
            })}
          </div>

          {summaries.failed.length > 0 && <LoadError label="activity for some universes" retry={() => summaries.retry()} />}

          <Pager page={page} totalPages={totalPages} total={total} noun={['universe', 'universes']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
