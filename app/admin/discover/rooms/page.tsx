'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, VisitLine } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { usePagedSearch } from '../../hooks/use-paged-search';
import type { EntitySummary } from '../../hooks/use-room-analytics';

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

interface RoomsResult {
  rooms: Room[];
  totalPages: number;
  total: number;
}

function RoomCard({ room, analytics }: { room: Room; analytics?: EntitySummary }) {
  const favorites = room._count?.favorites ?? 0;
  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
  return (
    <EntityCard
      href={`/admin/rooms/${room.id}`}
      kind="room"
      title={room.name}
      context={<StatLine items={[`${room.world.universe.name} › ${room.world.name}`]} />}
      description={room.description}
      aside={favorites > 0 ? `★ ${favorites}` : undefined}
      meta={
        analytics && (
          <>
            <StatLine items={activityStats(analytics)} />
            <VisitLine you={you} latest={latest} youWereLast={analytics.youWereLast} />
          </>
        )
      }
    />
  );
}

export default function DiscoverRoomsPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Searches in which the hidden default room turned up: the API's total counts it, so those totals drop one.
  const defaultSeenIn = useRef(new Set<string>());

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
  const list = usePagedSearch<RoomsResult>(
    async ({ query, page }, signal) => {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const searchParam = query ? `&search=${encodeURIComponent(query)}` : '';
      const response = await authenticatedFetch(`/api/admin/rooms?scope=discover&page=${page}&limit=12${searchParam}`, { signal });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return null;
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
      if (all.length > filtered.length) defaultSeenIn.current.add(query);
      const apiTotal = data.pagination?.total || 0;
      return {
        rooms: filtered,
        totalPages: data.pagination?.totalPages || 1,
        total: Math.max(0, apiTotal - (defaultSeenIn.current.has(query) ? 1 : 0)),
      };
    },
    { enabled: !checkingAuth },
  );

  const rooms = useMemo(() => list.data?.rooms ?? [], [list.data]);
  const totalPages = list.data?.totalPages ?? 1;
  const total = list.data?.total ?? 0;
  const { loading, page, query: search, error } = list;
  // Rooms are already sorted by accesses from the API (server-side sorting)
  const summaries = useEntitySummaries('rooms', useMemo(() => rooms.map((room) => room.id), [rooms]));

  function handlePageChange(nextPage: number) {
    list.setPage(Math.max(1, Math.min(totalPages || 1, nextPage)));
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Rooms" />

      <SearchBox
        value={list.input}
        onChange={list.setInput}
        onSubmit={list.submit}
        onClear={list.clear}
        showClear={Boolean(search)}
        label="Search rooms"
        placeholder="Search rooms"
      />

      {error && <LoadError label="rooms" retry={list.retry} />}

      {checkingAuth || (loading && rooms.length === 0) ? (
        <LoadingRows label="rooms" rows={3} />
      ) : rooms.length === 0 ? (
        !error &&
        (search ? (
          <p className="text-sm text-muted-foreground" role="status">
            No rooms match “{search}”.
          </p>
        ) : (
          <EmptyCard kind="room" title="No public rooms yet." text="Check back later: public rooms show up here." />
        ))
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3">
            {rooms.map((room) => (
              <RoomCard key={room.id} room={room} analytics={summaries.summary(room.id)} />
            ))}
          </div>

          {summaries.failed.length > 0 && <LoadError label="activity for some rooms" retry={() => summaries.retry()} />}

          <Pager page={page} totalPages={totalPages} total={total} noun={['room', 'rooms']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
