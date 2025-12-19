'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { MapPin, Activity, Clock, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  worldId: string;
  worldName: string;
  worldSlug: string;
  universeId: string;
  universeName: string;
  universeSlug: string;
  accessedAt: Date;
}

interface RoomAnalytics {
  totalAccesses: number;
  peakHour: number | null;
  favorites: number;
  description: string | null;
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

export default function RecentRoomCard({ room }: { room: RecentRoom }) {
  const [analytics, setAnalytics] = useState<RoomAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const [analyticsResponse, roomResponse] = await Promise.all([
          authenticatedFetch(`/api/admin/analytics/rooms/${room.roomId}`),
          authenticatedFetch(`/api/admin/rooms/${room.roomId}`),
        ]);

        if (analyticsResponse.ok && roomResponse.ok) {
          const analyticsData = await analyticsResponse.json();
          const roomData = await roomResponse.json();
          
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
            favorites: roomData._count?.favorites ?? 0,
            description: roomData.description ?? null,
          });
        }
      } catch (err) {
        console.error('[RecentRoomCard] Failed to fetch analytics:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchAnalytics();
  }, [room.roomId]);

  const timeAgo = formatTimeAgo(new Date(room.accessedAt));
  const lastVisited = new Date(room.accessedAt).toLocaleString();

  return (
    <Link
      href={`/admin/rooms/${room.roomId}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        className={cn(
          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
          'hover:-translate-y-1 hover:shadow-lg',
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

        <div className="relative flex h-full flex-col p-5">
          <div className="mb-3 flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
              <MapPin className="h-5 w-5 text-muted-foreground" />
            </div>

            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="truncate text-base font-semibold leading-tight">
                {room.roomName}
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                {room.universeName} · {room.worldName}
              </p>
            </div>
          </div>

          {analytics?.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {analytics.description}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
            <div className="flex flex-col gap-1.5">
              {loading ? (
                <span className="text-muted-foreground">Loading analytics...</span>
              ) : analytics ? (
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
                  <div className="mt-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Last visited
                    </span>
                    <div className="text-xs font-medium text-foreground/80">
                      {lastVisited} ({timeAgo})
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-0.5">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Last visited
                  </span>
                  <div className="text-xs font-medium text-foreground/80">
                    {lastVisited} ({timeAgo})
                  </div>
                </div>
              )}
            </div>
            {analytics && (
              <div className="flex items-center gap-1 text-primary">
                <Star className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs font-medium">{analytics.favorites}</span>
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

