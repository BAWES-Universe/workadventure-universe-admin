'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Activity, Globe, Users, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface UniverseAnalytics {
  totalAccesses: number;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null; userName?: string | null; userEmail?: string | null } | null;
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

export interface UniverseCardProps {
  universe: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    isPublic: boolean;
    featured: boolean;
    thumbnailUrl?: string | null;
    owner: {
      name: string | null;
      email: string | null;
    };
    _count?: {
      worlds?: number;
      rooms?: number;
      members?: number;
      favorites?: number;
    };
  };
  /**
   * Whether this universe is owned by the current user.
   * Used to adjust the byline copy.
   */
  ownedByCurrentUser?: boolean;
  /**
   * Whether to show the public/private visibility badge.
   * In discovery views we only surface public universes, so this can be hidden.
   */
  showVisibility?: boolean;
  /**
   * Whether to show the owner name.
   * On discover page, show owner. On user detail page, don't show.
   */
  showOwner?: boolean;
  /**
   * Analytics data for the universe (accesses, last visited, etc.)
   */
  analytics?: UniverseAnalytics;
  className?: string;
}

export function UniverseCard({
  universe,
  ownedByCurrentUser = false,
  showVisibility = true,
  showOwner = true,
  analytics,
  className,
}: UniverseCardProps) {
  const ownerLabel =
    ownedByCurrentUser
      ? 'Owned by you'
      : universe.owner?.name || universe.owner?.email || 'Unknown owner';

  const worldsCount = universe._count?.worlds ?? 0;
  const roomsCount = universe._count?.rooms ?? 0;
  const membersCount = universe._count?.members ?? 0;

  return (
    <Link
      href={`/admin/universes/${universe.id}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`View universe ${universe.name}`}
    >
      <Card
        className={cn(
          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
          'hover:-translate-y-1 hover:shadow-lg',
          className,
        )}
      >
        {/* Accent gradient overlay */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

        <div className="relative flex flex-col h-full p-5">
          {/* Thumbnail / initial */}
          <div className="mb-4 flex items-start gap-3">
            {universe.thumbnailUrl ? (
              <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
                {/* Using plain img to keep things simple in the admin UI */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={universe.thumbnailUrl}
                  alt={universe.name}
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border bg-muted text-lg font-semibold">
                {universe.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate text-base font-semibold leading-tight">
                  {universe.name}
                </h3>
              </div>
              <p className="truncate text-xs font-mono text-muted-foreground">
                {universe.slug}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {showVisibility && (
                  <Badge variant={universe.isPublic ? 'default' : 'secondary'}>
                    {universe.isPublic ? 'Public' : 'Private'}
                  </Badge>
                )}
                {universe.featured && (
                  <Badge variant="outline">
                    Featured
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Description */}
          {universe.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {universe.description}
            </p>
          )}

          {/* Footer */}
          <div className="mt-auto flex items-start justify-between pt-3 text-xs text-muted-foreground">
            <div className="flex flex-col gap-1.5 min-h-[3rem]">
              {analytics ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-foreground/80">
                      {analytics.totalAccesses.toLocaleString()} accesses
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {worldsCount} {worldsCount === 1 ? 'world' : 'worlds'} · {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                      {membersCount === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                  {showOwner && (
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {ownerLabel}
                      </span>
                    </div>
                  )}
                  {/* Last visited information */}
                  {analytics.lastVisitedByUser || analytics.lastVisitedOverall ? (
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      {analytics.lastVisitedByUser && (
                        <div className="text-[11px]">
                          <span className="text-muted-foreground/70">Last visited by you: </span>
                          <span className="font-medium text-foreground/80">
                            {formatTimeAgo(new Date(analytics.lastVisitedByUser.accessedAt))}
                          </span>
                        </div>
                      )}
                      {analytics.lastVisitedOverall && (
                        <div className="text-[11px]">
                          {analytics.lastVisitedByUser && 
                           analytics.lastVisitedByUser.accessedAt === analytics.lastVisitedOverall.accessedAt ? (
                            <span className="text-muted-foreground/70 italic">
                              You were the last visitor
                            </span>
                          ) : (
                            <>
                              <span className="text-muted-foreground/70">Most recent visitor: </span>
                              <span className="font-medium text-foreground/80">
                                {formatTimeAgo(new Date(analytics.lastVisitedOverall.accessedAt))}
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
                <>
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {worldsCount} {worldsCount === 1 ? 'world' : 'worlds'} · {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                      {membersCount === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                  {showOwner && (
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {ownerLabel}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-1 text-primary self-end">
              <Star className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{universe._count?.favorites ?? 0}</span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}


