'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Search, X } from 'lucide-react';

interface User {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
  isGuest: boolean;
  createdAt: string;
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
  };
}

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      fetchUsers();
    }
  }, [page, search]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      fetchUsers();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchUsers() {
    try {
      setLoading(true);
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users?page=${page}&limit=50${searchParam}`);

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch users');
      }

      const data = await response.json();
      const rawUsers: User[] = data.users || [];
      // Hide system user from list
      const visibleUsers = rawUsers.filter(
        (user) => user.email !== 'system@workadventure.local',
      );

      setUsers(visibleUsers);
      setTotalPages(data.pagination?.totalPages || 1);
      const totalFromApi = data.pagination?.total ?? visibleUsers.length;
      const systemUsersOnPage = rawUsers.length - visibleUsers.length;
      const adjustedTotal = Math.max(0, totalFromApi - systemUsersOnPage);
      setTotal(adjustedTotal);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchUsers();
  }

  if (loading && users.length === 0) {
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
      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Users</h1>
        <p className="text-muted-foreground text-lg">
          Manage users and their access to universes and worlds.
        </p>
      </div>

      <div className="border border-border/70 rounded-lg bg-card">
        <div className="p-6">
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, email, or UUID..."
                  className="pl-9"
                />
              </div>
              <Button type="submit" variant="outline" disabled={loading}>
                {loading ? (
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
              {search && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSearch('');
                    setPage(1);
                  }}
                >
                  <X className="mr-2 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-4"
              onClick={fetchUsers}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {users.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No users found.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {users.map((user) => {
            const nameOrEmail = user.name || user.email || 'N/A';
            const initial = (user.name || user.email || '?').charAt(0).toUpperCase();
            const created = new Date(user.createdAt).toLocaleDateString();

            return (
              <Link
                key={user.id}
                href={`/admin/users/${user.id}`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Card className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg">
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-secondary/20 opacity-0 transition-opacity group-hover:opacity-100" />
                  <CardContent className="relative flex h-full flex-col p-5">
                    <div className="mb-4 flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold">
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="truncate text-base font-semibold leading-tight">
                          {nameOrEmail}
                        </h3>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email || 'No email'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                      <div className="flex flex-col gap-0.5">
                        <span>
                          {user._count.ownedUniverses}{' '}
                          {user._count.ownedUniverses === 1 ? 'universe' : 'universes'}
                        </span>
                        <span>
                          {user._count.worldMemberships}{' '}
                          {user._count.worldMemberships === 1 ? 'world membership' : 'world memberships'}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Joined
                        </div>
                        <div className="text-xs font-medium text-foreground/80">{created}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Showing page {page} of {totalPages} ({total} total users)
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1 || loading}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages || loading}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
