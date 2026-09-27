'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { EmptyCard, LoadError, LoadingRows, PageHeader } from '../components/ds';
import { UniverseCard, UniverseAnalytics } from './universe-card';

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

export default function UniversesPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);

  const [myUniverses, setMyUniverses] = useState<Universe[]>([]);
  const [myLoading, setMyLoading] = useState(true);
  const [myError, setMyError] = useState<string | null>(null);
  const [analyticsByUniverse, setAnalyticsByUniverse] = useState<Record<string, UniverseAnalytics>>({});

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
      
      await fetchMyUniverses();
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchMyUniverses() {
    try {
      setMyLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/universes?scope=my&limit=50');

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch universes');
      }

      const data = await response.json();
      setMyUniverses(data.universes || []);
      setMyError(null);
    } catch (err) {
      setMyError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setMyLoading(false);
    }
  }

  useEffect(() => {
    async function fetchAnalyticsForUniverses() {
      const missing = myUniverses.filter((universe) => !analyticsByUniverse[universe.id]);
      if (missing.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          missing.map(async (universe) => {
            try {
              const response = await authenticatedFetch(
                `/api/admin/analytics/universes/${universe.id}`,
              );
              if (!response.ok) {
                return null;
              }
              const data = await response.json();
              
              return {
                universeId: universe.id,
                totalAccesses: data.totalAccesses || 0,
                lastVisitedByUser: data.lastVisitedByUser || null,
                lastVisitedOverall: data.lastVisitedOverall || null,
              };
            } catch {
              return null;
            }
          }),
        );

        setAnalyticsByUniverse((prev) => {
          const updated: Record<string, UniverseAnalytics> = { ...prev };
          for (const result of results) {
            if (result) {
              updated[result.universeId] = {
                totalAccesses: result.totalAccesses,
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

    if (myUniverses.length > 0) {
      fetchAnalyticsForUniverses();
    }
  }, [myUniverses, analyticsByUniverse]);

  if (checkingAuth) {
    return <LoadingRows label="your universes" />;
  }

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
                analytics={analyticsByUniverse[universe.id]}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
