'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Activity, Clock, History, MapPin, Navigation, Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time-ago';
import { formatHour, useRoomAnalytics, type RoomVisit } from '../hooks/use-room-analytics';
import { useWorkAdventure } from '../workadventure-context';

export interface RoomCardRoom {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  favorites?: number;
  world: { name: string; slug: string };
  universe: { name: string; slug: string };
}

type Kind = 'here' | 'previous' | 'trail';

const ICONS = { here: MapPin, previous: History, trail: Clock } as const;

function sameVisit(a: RoomVisit | null, b: RoomVisit | null): boolean {
  return Boolean(a && b && a.accessedAt === b.accessedAt);
}

/**
 * A room at a glance: where it is, what it is, how popular it is and who was there last. The card opens the room's
 * page; Visit takes you there in the game (not on the room you are already in).
 */
export function RoomCard({ room, kind, eyebrow }: { room: RoomCardRoom; kind: Kind; eyebrow?: string }) {
  const { analytics, loading } = useRoomAnalytics(room.id);
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [visiting, setVisiting] = useState(false);
  const Icon = ICONS[kind];
  const here = kind === 'here';

  async function visit() {
    setVisiting(true);
    try {
      await navigateToRoom(`/@/${room.universe.slug}/${room.world.slug}/${room.slug}`);
    } catch (cause) {
      console.error('[RoomCard] Could not visit', cause);
    } finally {
      setVisiting(false);
    }
  }

  const you = analytics?.lastVisitedByUser ?? null;
  const latest = analytics?.lastVisitedOverall ?? null;

  return (
    <article
      className={cn(
        'orbit-card orbit-card-interactive group relative flex h-full flex-col p-4',
        here && 'orbit-glow border-primary/40',
      )}
      data-testid={`room-card-${kind}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            here ? 'orbit-brand-fill' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className={cn('text-[11px] font-medium uppercase tracking-wider', here ? 'text-primary' : 'text-muted-foreground')}>
              {eyebrow}
            </p>
          )}
          <h3 className="truncate text-[15px] font-semibold leading-tight">
            {/* The whole card opens the room's page. */}
            <Link
              href={`/admin/rooms/${room.id}`}
              className="after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {room.name}
            </Link>
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {room.universe.name} · {room.world.name}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary" title="Stars">
          <Star className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="tabular-nums">{room.favorites ?? 0}</span>
          <span className="sr-only">stars</span>
        </span>
      </div>

      {room.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{room.description}</p>}

      <div className="mt-auto pt-3">
        {loading ? (
          <div className="space-y-1.5" aria-label="Loading visits">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : analytics ? (
          <dl className="space-y-1 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-medium tabular-nums text-foreground/85">{analytics.totalAccesses.toLocaleString()}</span>
                {analytics.totalAccesses === 1 ? 'visit' : 'visits'}
              </span>
              {analytics.peakHour !== null && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  Busiest around <span className="font-medium text-foreground/85">{formatHour(analytics.peakHour)}</span>
                </span>
              )}
            </div>
            {you || latest ? (
              <>
                {you && !here && (
                  <div>
                    <dt className="inline">You were here </dt>
                    <dd className="inline font-medium text-foreground/85">{timeAgo(new Date(you.accessedAt))}</dd>
                  </div>
                )}
                {latest &&
                  (sameVisit(you, latest) ? (
                    <div className="italic">You were the last visitor</div>
                  ) : (
                    <div>
                      <dt className="inline">Latest visitor </dt>
                      <dd className="inline font-medium text-foreground/85">
                        {latest.userName ? `${latest.userName}, ` : ''}
                        {timeAgo(new Date(latest.accessedAt))}
                      </dd>
                    </div>
                  ))}
              </>
            ) : (
              <div>No visits recorded</div>
            )}
          </dl>
        ) : null}

        {!here && isReady && (
          <button
            type="button"
            onClick={() => void visit()}
            disabled={visiting}
            aria-label={`Visit ${room.name}`}
            className="orbit-press relative z-10 mt-3 inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/70 bg-elevated px-3 text-xs font-medium text-foreground transition-colors hover:border-primary/50 disabled:opacity-60"
          >
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            {visiting ? 'Going…' : 'Visit'}
          </button>
        )}
      </div>
    </article>
  );
}

export function RoomCardSkeleton() {
  return (
    <div className="orbit-card space-y-3 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}
