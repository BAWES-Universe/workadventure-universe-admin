'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine, VisitLine, count } from '../../components/ds';
import { Pager, SearchBox } from '../discover-ui';

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

/** "4 PM", "12 AM". */
function formatHour(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown} ${suffix}`;
}

function RoomCard({ room, analytics }: { room: Room; analytics?: RoomAnalytics }) {
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
            <StatLine
              items={[
                count(analytics.totalAccesses, 'visit'),
                analytics.peakHour !== null && `busiest at ${formatHour(analytics.peakHour)}`,
              ]}
            />
            <VisitLine you={you} latest={latest} youWereLast={Boolean(you && latest && you === latest)} />
          </>
        )
      }
    />
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data.recentActivity.forEach((access: any) => {
                  const date = new Date(access.accessedAt);
                  const hour = date.getHours(); // Local timezone
                  hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
                });
                const localPeakTimes = Array.from(hourCounts.entries())
                  .map(([hour, total]) => ({ hour, total }))
                  .sort((a, b) => b.total - a.total);
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

  function handleSearchSubmit() {
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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Rooms" />

      <SearchBox
        value={searchInput}
        onChange={setSearchInput}
        onSubmit={handleSearchSubmit}
        onClear={handleClear}
        showClear={Boolean(search)}
        label="Search rooms"
        placeholder="Search rooms"
      />

      {error && <LoadError label="rooms" retry={() => fetchRooms()} />}

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
            {sortedRooms.map((room) => (
              <RoomCard key={room.id} room={room} analytics={analyticsByRoom[room.id]} />
            ))}
          </div>

          <Pager page={page} totalPages={totalPages} total={total} noun={['room', 'rooms']} loading={loading} onChange={handlePageChange} />
        </>
      )}
    </div>
  );
}
