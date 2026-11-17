'use client';

import { activityStats } from '@/lib/analytics-peak';
import { EntityCard, StatLine, StatusPill, VisitLine, countPlace } from '../components/ds';
import type { EntitySummary } from '../hooks/use-room-analytics';

/** A universe's activity (accesses, peak, last visits), from the shared analytics loader. */
export type UniverseAnalytics = EntitySummary;

export interface UniverseCardProps {
  universe: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    isPublic: boolean;
    featured: boolean;
    thumbnailUrl?: string | null;
    owner?: {
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
  /** Whether to show the public/private pill. Discovery only lists public universes, so it hides it. */
  showVisibility?: boolean;
  /** Accesses to the universe. */
  analytics?: UniverseAnalytics;
  className?: string;
}

/** A universe in a list: its own colour, what's in it, how often it's accessed. No owner line or badge: the card is the universe. The whole card is the link. */
export function UniverseCard({
  universe,
  showVisibility = true,
  analytics,
}: UniverseCardProps) {
  const stars = universe._count?.favorites ?? 0;
  const youAt = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latestAt = analytics?.lastVisitedOverall?.accessedAt ?? null;

  return (
    <EntityCard
      href={`/admin/universes/${universe.id}`}
      kind="universe"
      universeId={universe.id}
      title={universe.name}
      pills={
        (showVisibility || universe.featured) && (
          <>
            {showVisibility && <StatusPill status={universe.isPublic ? 'public' : 'private'} />}
            {universe.featured && <StatusPill status="featured" />}
          </>
        )
      }
      description={universe.description}
      aside={stars > 0 ? `★ ${stars}` : undefined}
      meta={
        <>
          <StatLine
            items={[
              countPlace('world', universe._count?.worlds ?? 0, 'world'),
              countPlace('room', universe._count?.rooms ?? 0, 'room'),
              countPlace('people', universe._count?.members ?? 0, 'member'),
              ...activityStats(analytics),
            ]}
          />
          <VisitLine you={youAt} latest={latestAt} youWereLast={analytics?.youWereLast ?? false} />
        </>
      }
    />
  );
}
