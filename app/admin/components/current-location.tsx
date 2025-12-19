'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useWorkAdventure } from '../workadventure-context';
import { MapPin, Loader2, AlertCircle, Activity, Clock, Star } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

interface CurrentRoom {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
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
}

function formatHourTo12Hour(hour: number): string {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
}

export default function CurrentLocation() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [playUri, setPlayUri] = useState<string | null>(null);
  const [mapURL, setMapURL] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [room, setRoom] = useState<CurrentRoom | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<RoomAnalytics | null>(null);

  useEffect(() => {
    // Check super admin status
    async function checkSuperAdmin() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          setIsSuperAdmin(data.user?.isSuperAdmin || false);
        }
      } catch (err) {
        // Silently fail - not critical for this component
      }
    }

    checkSuperAdmin();
  }, []);

  useEffect(() => {
    if (!isReady || !wa) {
      setLoading(isLoading);
      return;
    }

    async function getRoomInfo() {
      if (!wa) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        await wa.onInit();

        const roomIdValue = wa.room.id as string | undefined;
        const mapURLValue = wa.room.mapURL as string | undefined;

        if (roomIdValue) {
          setPlayUri(roomIdValue);
          // Fetch room details from admin API using the full play URL
          try {
            const { authenticatedFetch } = await import('@/lib/client-auth');
            const response = await authenticatedFetch(
              `/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(roomIdValue)}`,
            );

            if (response.ok) {
              const data = await response.json();
              setRoom(data as CurrentRoom);
              setRoomError(null);
              
              // Fetch analytics for the room
              try {
                const analyticsResponse = await authenticatedFetch(
                  `/api/admin/analytics/rooms/${data.id}`,
                );
                if (analyticsResponse.ok) {
                  const analyticsData = await analyticsResponse.json();
                  
                  // Calculate peak hour from recent activity in local timezone (like detail page)
                  let peakHour = null;
                  if (analyticsData.recentActivity && analyticsData.recentActivity.length > 0) {
                    const hourCounts = new Map<number, number>();
                    analyticsData.recentActivity.forEach((access: any) => {
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
                  if (peakHour === null && Array.isArray(analyticsData.peakTimes) && analyticsData.peakTimes.length > 0) {
                    peakHour = analyticsData.peakTimes[0].hour;
                  }
                  
                  setAnalytics({
                    totalAccesses: analyticsData.totalAccesses || 0,
                    peakHour,
                  });
                }
              } catch (analyticsErr) {
                // Silently fail - analytics are optional
                console.error('[CurrentLocation] Failed to fetch analytics:', analyticsErr);
              }
            } else {
              setRoom(null);
              setRoomError('Unable to resolve current room from play URL.');
            }
          } catch (err) {
            console.error('[CurrentLocation] Failed to resolve room from playUri:', err);
            setRoom(null);
            setRoomError('Unable to resolve current room from play URL.');
          }
        }

        setMapURL(mapURLValue || null);
      } catch (err) {
        console.error('[CurrentLocation] Failed to get room info:', err);
      } finally {
        setLoading(false);
      }
    }

    getRoomInfo();
  }, [wa, isReady, isLoading]);

  if (error || (!isReady && !isLoading)) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Not Available</AlertTitle>
            <AlertDescription>
              Universe API is not available. This feature only works when the admin page is loaded in a Universe iframe.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (loading || isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const favorites = room?._count?.favorites ?? 0;

  const content = (
    <Card className={cn(
      'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
      'hover:-translate-y-1 hover:shadow-lg',
    )}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
      <CardContent className="relative flex h-full flex-col p-5">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
            <MapPin className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="truncate text-base font-semibold leading-tight">
              {room?.name || 'Current room'}
            </h3>
            {room ? (
              <>
                <p className="truncate text-xs text-muted-foreground">
                  {room.world.universe.name} · {room.world.name}
                </p>
              </>
            ) : roomError ? (
              <p className="truncate text-xs text-muted-foreground">
                {roomError}
              </p>
            ) : playUri ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                {playUri}
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground">
                No room information available.
              </p>
            )}
          </div>
        </div>

        {room?.description && (
          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
            {room.description}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
          <div className="flex flex-col gap-1.5">
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
              </>
            ) : room ? (
              <span className="text-muted-foreground">Access data loading...</span>
            ) : null}
          </div>
          {room && (
            <div className="flex items-center gap-1 text-primary">
              <Star className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{favorites}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );

  if (room) {
    return (
      <Link
        href={`/admin/rooms/${room.id}`}
        className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {content}
      </Link>
    );
  }
  return content;
}

