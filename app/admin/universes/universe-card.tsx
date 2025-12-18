'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  className?: string;
}

export function UniverseCard({
  universe,
  ownedByCurrentUser = false,
  showVisibility = true,
  className,
}: UniverseCardProps) {
  const ownerLabel =
    ownedByCurrentUser
      ? 'Owned by you'
      : universe.owner?.name || universe.owner?.email || 'Unknown owner';

  const worldsCount = universe._count?.worlds ?? 0;

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
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-secondary/20 opacity-0 transition-opacity group-hover:opacity-100" />

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
          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground/80">
                {worldsCount} {worldsCount === 1 ? 'world' : 'worlds'}
              </span>
              <span className="line-clamp-1">
                {ownerLabel}
              </span>
            </div>
            <div className="flex items-center gap-1 text-primary transition-transform group-hover:translate-x-0.5">
              <span className="hidden text-xs font-medium sm:inline">
                View
              </span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}


