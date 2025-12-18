'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Plus, AlertCircle, Loader2, Search, X } from 'lucide-react';
import { UniverseCard } from './universe-card';

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
  };
}

export default function UniversesPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);

  const [myUniverses, setMyUniverses] = useState<Universe[]>([]);
  const [myLoading, setMyLoading] = useState(true);
  const [myError, setMyError] = useState<string | null>(null);

  const [discoverUniverses, setDiscoverUniverses] = useState<Universe[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverSearchInput, setDiscoverSearchInput] = useState('');
  const [discoverSearch, setDiscoverSearch] = useState('');
  const [discoverPage, setDiscoverPage] = useState(1);
  const [discoverTotalPages, setDiscoverTotalPages] = useState(1);
  const [discoverTotal, setDiscoverTotal] = useState(0);

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

      // Reset discover controls before initial load
      setDiscoverSearchInput('');
      setDiscoverSearch('');
      setDiscoverPage(1);

      await Promise.all([
        fetchMyUniverses(),
        fetchDiscoverUniverses(1, ''),
      ]);
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

  async function fetchDiscoverUniverses(nextPage?: number, nextSearch?: string) {
    const pageToUse = nextPage ?? discoverPage;
    const searchValue = nextSearch ?? discoverSearch;

    try {
      setDiscoverLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');

      const searchParam = searchValue ? `&search=${encodeURIComponent(searchValue)}` : '';
      const response = await authenticatedFetch(
        `/api/admin/universes?scope=discover&page=${pageToUse}&limit=12${searchParam}`,
      );

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch universes to discover');
      }

      const data = await response.json();
      setDiscoverUniverses(data.universes || []);
      setDiscoverTotalPages(data.pagination?.totalPages || 1);
      setDiscoverTotal(data.pagination?.total || 0);
      setDiscoverError(null);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDiscoverLoading(false);
    }
  }

  function handleDiscoverSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = discoverSearchInput.trim();
    setDiscoverPage(1);
    setDiscoverSearch(trimmed);
    fetchDiscoverUniverses(1, trimmed);
  }

  function handleDiscoverClear() {
    setDiscoverSearchInput('');
    setDiscoverSearch('');
    setDiscoverPage(1);
    fetchDiscoverUniverses(1, '');
  }

  function handleDiscoverPageChange(nextPage: number) {
    const safePage = Math.max(1, Math.min(discoverTotalPages || 1, nextPage));
    if (safePage === discoverPage) return;
    setDiscoverPage(safePage);
    fetchDiscoverUniverses(safePage);
  }

  if (checkingAuth) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Universes</h1>
          <p className="text-muted-foreground text-lg">
            Manage your universes and discover new ones.
          </p>
        </div>
        <Button variant="default" asChild>
          <Link href="/admin/universes/new">
            <Plus className="mr-2 h-4 w-4" />
            Create Universe
          </Link>
        </Button>
      </div>

      {/* My Universes */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">My Universes</h2>
            <p className="text-sm text-muted-foreground">
              Universes you own and manage.
            </p>
          </div>
          {!myLoading && (
            <div className="text-xs text-muted-foreground">
              {myUniverses.length} {myUniverses.length === 1 ? 'universe' : 'universes'}
            </div>
          )}
        </div>

        {myError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {myError}
              <Button
                variant="outline"
                size="sm"
                className="ml-4"
                onClick={fetchMyUniverses}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {myLoading && myUniverses.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : myUniverses.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No universes yet</CardTitle>
              <CardDescription>
                Create your first universe to start building your worlds.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="default" asChild>
                <Link href="/admin/universes/new">
                  <Plus className="mr-2 h-4 w-4" />
                  Create your first universe
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {myUniverses.map((universe) => (
              <UniverseCard
                key={universe.id}
                universe={universe}
                ownedByCurrentUser
              />
            ))}
          </div>
        )}
      </section>

      {/* Discover Universes */}
      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Discover Universes</h2>
            <p className="text-sm text-muted-foreground">
              Explore public universes created by other users.
            </p>
          </div>
          {!discoverLoading && discoverTotal > 0 && (
            <div className="text-xs text-muted-foreground">
              Page {discoverPage} of {discoverTotalPages} &bull; {discoverTotal}{' '}
              {discoverTotal === 1 ? 'universe' : 'universes'}
            </div>
          )}
        </div>

        <Card>
          <CardContent className="pt-6">
            <form
              onSubmit={handleDiscoverSearchSubmit}
              className="flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={discoverSearchInput}
                  onChange={(e) => setDiscoverSearchInput(e.target.value)}
                  placeholder="Search universes by name, slug, or description..."
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={discoverLoading}>
                  {discoverLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 h-4 w-4" />
                      Search
                    </>
                  )}
                </Button>
                {discoverSearch && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleDiscoverClear}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Clear
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {discoverError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {discoverError}
              <Button
                variant="outline"
                size="sm"
                className="ml-4"
                onClick={() => fetchDiscoverUniverses()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {discoverLoading && discoverUniverses.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : discoverUniverses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no public universes to discover yet. Check back later!
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {discoverUniverses.map((universe) => (
                <UniverseCard
                  key={universe.id}
                  universe={universe}
                  ownedByCurrentUser={false}
                />
              ))}
            </div>

            {discoverTotalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <div className="text-xs text-muted-foreground">
                  Showing page {discoverPage} of {discoverTotalPages} ({discoverTotal}{' '}
                  {discoverTotal === 1 ? 'universe' : 'universes'})
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleDiscoverPageChange(discoverPage - 1)}
                    disabled={discoverPage === 1 || discoverLoading}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleDiscoverPageChange(discoverPage + 1)}
                    disabled={discoverPage === discoverTotalPages || discoverLoading}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

