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

interface PreviousRoom extends CurrentRoom {
  accessedAt: string;
}

interface RoomAnalytics {
  totalAccesses: number;
  peakHour: number | null;
  lastVisitedByUser: { accessedAt: string } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
}

function formatHourTo12Hour(hour: number): string {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
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

export default function CurrentLocation() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [playUri, setPlayUri] = useState<string | null>(null);
  const [mapURL, setMapURL] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [room, setRoom] = useState<CurrentRoom | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<RoomAnalytics | null>(null);
  const [previousRoom, setPreviousRoom] = useState<PreviousRoom | null>(null);
  const [previousAnalytics, setPreviousAnalytics] = useState<RoomAnalytics | null>(null);

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
                    lastVisitedByUser: analyticsData.lastVisitedByUser || null,
                    lastVisitedOverall: analyticsData.lastVisitedOverall || null,
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

  // Fetch previous location when we have current room
  useEffect(() => {
    async function fetchPreviousLocation() {
      if (!room) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(
          `/api/admin/rooms/previous?currentRoomId=${encodeURIComponent(room.id)}`,
        );

        if (response.ok) {
          const data = await response.json();
          if (data.room) {
            setPreviousRoom(data.room);
            
            // Fetch analytics for previous room
            try {
              const analyticsResponse = await authenticatedFetch(
                `/api/admin/analytics/rooms/${data.room.id}`,
              );
              if (analyticsResponse.ok) {
                const analyticsData = await analyticsResponse.json();
                
                // Calculate peak hour from recent activity in local timezone
                let peakHour = null;
                if (analyticsData.recentActivity && analyticsData.recentActivity.length > 0) {
                  const hourCounts = new Map<number, number>();
                  analyticsData.recentActivity.forEach((access: any) => {
                    const date = new Date(access.accessedAt);
                    const hour = date.getHours();
                    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
                  });
                  const localPeakTimes = Array.from(hourCounts.entries())
                    .map(([hour, count]) => ({ hour, count }))
                    .sort((a, b) => b.count - a.count);
                  if (localPeakTimes.length > 0) {
                    peakHour = localPeakTimes[0].hour;
                  }
                }
                
                if (peakHour === null && Array.isArray(analyticsData.peakTimes) && analyticsData.peakTimes.length > 0) {
                  peakHour = analyticsData.peakTimes[0].hour;
                }
                
                setPreviousAnalytics({
                  totalAccesses: analyticsData.totalAccesses || 0,
                  peakHour,
                  lastVisitedByUser: analyticsData.lastVisitedByUser || null,
                  lastVisitedOverall: analyticsData.lastVisitedOverall || null,
                });
              }
            } catch {
              // Silently fail - analytics are optional
            }
          } else {
            setPreviousRoom(null);
            setPreviousAnalytics(null);
          }
        }
      } catch (err) {
        console.error('[CurrentLocation] Failed to fetch previous location:', err);
        setPreviousRoom(null);
        setPreviousAnalytics(null);
      }
    }

    fetchPreviousLocation();
  }, [room]);

  if (error || (!isReady && !isLoading)) {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
          <p className="text-sm text-muted-foreground">
            Your current location in the Universe
          </p>
        </div>
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
      </section>
    );
  }

  if (loading || isLoading) {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
          <p className="text-sm text-muted-foreground">
            Your current location in the Universe
          </p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </section>
    );
  }

  function renderRoomCard(
    roomData: CurrentRoom | PreviousRoom | null,
    roomAnalytics: RoomAnalytics | null,
    title: string,
    isClickable: boolean = true
  ) {
    if (!roomData) return null;

    const favorites = roomData._count?.favorites ?? 0;

    const cardContent = (
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
                {roomData.name}
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                {roomData.world.universe.name} · {roomData.world.name}
              </p>
            </div>
          </div>

          {roomData.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {roomData.description}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
            <div className="flex flex-col gap-1.5 min-h-[3rem]">
              {roomAnalytics ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-foreground/80">
                      {roomAnalytics.totalAccesses.toLocaleString()} accesses
                    </span>
                  </div>
                  {roomAnalytics.peakHour !== null && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        Peak: {formatHourTo12Hour(roomAnalytics.peakHour)}
                      </span>
                    </div>
                  )}
                  {/* Last visited information */}
                  {roomAnalytics.lastVisitedByUser || roomAnalytics.lastVisitedOverall ? (
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      {roomAnalytics.lastVisitedByUser && (
                        <div className="text-[11px]">
                          <span className="text-muted-foreground/70">Last visited by you: </span>
                          <span className="font-medium text-foreground/80">
                            {formatTimeAgo(new Date(roomAnalytics.lastVisitedByUser.accessedAt))}
                          </span>
                        </div>
                      )}
                      {roomAnalytics.lastVisitedOverall && (
                        <div className="text-[11px]">
                          {roomAnalytics.lastVisitedByUser && 
                           roomAnalytics.lastVisitedByUser.accessedAt === roomAnalytics.lastVisitedOverall.accessedAt ? (
                            <span className="text-muted-foreground/70 italic">
                              You were the last visitor
                            </span>
                          ) : (
                            <>
                              <span className="text-muted-foreground/70">Last activity: </span>
                              <span className="font-medium text-foreground/80">
                                {formatTimeAgo(new Date(roomAnalytics.lastVisitedOverall.accessedAt))}
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
            <div className="flex items-center gap-1 text-primary">
              <Star className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{favorites}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    );

    if (isClickable) {
      return (
        <Link
          href={`/admin/rooms/${roomData.id}`}
          className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {cardContent}
        </Link>
      );
    }
    return cardContent;
  }

  // If we have a previous room, show 2 columns with headers
  if (previousRoom) {
    return (
      <section className="space-y-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col space-y-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold tracking-tight">Current Location</h3>
              <p className="text-sm text-muted-foreground">
                Your current location in the Universe
              </p>
            </div>
            <div className="flex-1">
              {renderRoomCard(room, analytics, 'Current Location', !!room)}
            </div>
          </div>
          <div className="flex flex-col space-y-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold tracking-tight">Previous Location</h3>
              <p className="text-sm text-muted-foreground">
                Where you were before this location
              </p>
            </div>
            <div className="flex-1">
              {renderRoomCard(previousRoom, previousAnalytics, 'Previous Location', true)}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Otherwise show single column with header
  if (room) {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
          <p className="text-sm text-muted-foreground">
            Your current location in the Universe
          </p>
        </div>
        {renderRoomCard(room, analytics, 'Current Location', true)}
      </section>
    );
  }

  // Fallback for when room is not available
  if (roomError) {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
          <p className="text-sm text-muted-foreground">
            Your current location in the Universe
          </p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{roomError}</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (playUri) {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
          <p className="text-sm text-muted-foreground">
            Your current location in the Universe
          </p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="truncate font-mono text-[11px] text-muted-foreground/80">
              {playUri}
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Current Location</h2>
        <p className="text-sm text-muted-foreground">
          Your current location in the Universe
        </p>
      </div>
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">
            No room information available.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

