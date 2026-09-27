'use client';

import { EntityCard, StatLine, StatusPill, VisitLine, count } from '../components/ds';

export interface UniverseAnalytics {
  totalAccesses: number;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null; userName?: string | null; userEmail?: string | null } | null;
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
  /** Whether this universe is owned by the current user (adjusts the byline). */
  ownedByCurrentUser?: boolean;
  /** Whether to show the public/private pill. Discovery only lists public universes, so it hides it. */
  showVisibility?: boolean;
  /** Whether to show who owns it. */
  showOwner?: boolean;
  /** Visits to the universe. */
  analytics?: UniverseAnalytics;
  className?: string;
}

/** A universe in a list: its own colour, what's in it, how often it's visited. The whole card is the link. */
export function UniverseCard({
  universe,
  ownedByCurrentUser = false,
  showVisibility = true,
  showOwner = true,
  analytics,
}: UniverseCardProps) {
  const ownerLabel = ownedByCurrentUser ? 'Owned by you' : universe.owner?.name ? `by ${universe.owner.name}` : null;
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
              count(universe._count?.worlds ?? 0, 'world'),
              count(universe._count?.rooms ?? 0, 'room'),
              count(universe._count?.members ?? 0, 'member'),
              analytics && count(analytics.totalAccesses, 'visit'),
              showOwner && ownerLabel,
            ]}
          />
          <VisitLine you={youAt} latest={latestAt} youWereLast={!!youAt && youAt === latestAt} />
        </>
      }
    />
  );
}
