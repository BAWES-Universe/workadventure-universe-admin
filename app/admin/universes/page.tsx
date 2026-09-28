'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { EmptyCard, LoadError, LoadingRows, PageHeader } from '../components/ds';
import { UniverseCard } from './universe-card';
import { useEntitySummaries } from '../hooks/use-entity-summaries';
import { usePagedSearch } from '../hooks/use-paged-search';
import { Pager } from '../discover/discover-ui';

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  owner: {
    id: string;
    name: string | null;
    email: string | null;
  };
  _count?: {
    worlds?: number;
    rooms?: number;
    members?: number;
  };
}

/** Universes per page; a super admin can own many. */
const PAGE_SIZE = 24;

interface UniversePage {
  items: Universe[];
  total: number;
  totalPages: number;
}

export default function UniversesPage() {
  const router = useRouter();

  // One request per page, abortable; the shell has already checked the session (a 401 still leads to sign-in).
  const list = usePagedSearch<UniversePage>(async ({ page }, signal) => {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(`/api/admin/universes?scope=my&page=${page}&limit=${PAGE_SIZE}`, { signal });
    if (!response.ok) {
      if (response.status === 401) {
        router.push('/admin/login');
        return null;
      }
      throw new Error('Failed to fetch universes');
    }
    const data = await response.json();
    const items: Universe[] = data.universes || [];
    return { items, total: data.pagination?.total ?? items.length, totalPages: data.pagination?.totalPages || 1 };
  });
  const myUniverses = useMemo(() => list.data?.items ?? [], [list.data]);
  const myLoading = list.loading;
  const myError = list.error;
  const fetchMyUniverses = list.retry;

  // Each universe's activity, asked for once; failures offer a retry instead of asking forever.
  const universeIds = useMemo(() => myUniverses.map((universe) => universe.id), [myUniverses]);
  const summaries = useEntitySummaries('universes', universeIds);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your universes"
        actions={
          <Button variant="default" asChild>
            <Link href="/admin/universes/new">
              <Plus className="mr-2 h-4 w-4" />
              Create universe
            </Link>
          </Button>
        }
      />

      <section className="space-y-4">
        {myError && <LoadError label="your universes" retry={fetchMyUniverses} />}

        {myLoading && myUniverses.length === 0 ? (
          <LoadingRows label="your universes" />
        ) : myUniverses.length === 0 ? (
          !myError && (
            <EmptyCard
              kind="universe"
              title="No universes yet."
              text="A universe holds your worlds, and worlds hold rooms."
              href="/admin/universes/new"
              action="Create your first universe"
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {myUniverses.map((universe) => (
              <UniverseCard
                key={universe.id}
                universe={universe}
                ownedByCurrentUser
                showOwner={false}
                analytics={summaries.summary(universe.id)}
              />
            ))}
          </div>
        )}

        {myUniverses.length > 0 && summaries.failed.length > 0 && (
          <LoadError label="activity for some universes" retry={() => summaries.retry()} />
        )}

        <Pager
          page={list.page}
          totalPages={list.data?.totalPages ?? 1}
          total={list.data?.total ?? 0}
          noun={['universe', 'universes']}
          loading={myLoading}
          onChange={(page) => list.setPage(Math.max(1, Math.min(list.data?.totalPages ?? 1, page)))}
        />
      </section>
    </div>
  );
}
