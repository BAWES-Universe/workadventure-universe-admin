'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, VisitLine } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { usePagedSearch } from '../../hooks/use-paged-search';
import { useInitialSearch, useSearchInUrl } from '../../hooks/use-search-in-url';
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
  // The shell has already checked the session; a 401 below still leads to sign-in.
  const initialQuery = useInitialSearch();


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
      // The server leaves out the built-in default room and anything not discoverable, before paging.
      const rooms: Room[] = data.rooms || [];
      return {
        rooms,
        totalPages: data.pagination?.totalPages || 1,
        total: data.pagination?.total ?? rooms.length,
      };
    },
    { initialQuery },
  );
  useSearchInUrl(list.query);

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

      {(loading && rooms.length === 0) ? (
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
