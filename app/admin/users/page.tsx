'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/lib/time-ago';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine, count } from '../components/ds';
import { Pager, SearchBox } from '../discover/discover-ui';

interface User {
  id: string;
  uuid: string;
  name: string | null;
  // Omitted by the API unless the viewer may see email addresses.
  email?: string | null;
  isGuest: boolean;
  createdAt: string;
  totalAccesses?: number;
  lastAccessed?: string | null;
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

  function handleSearch() {
    setPage(1);
    fetchUsers();
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="People" />

      <SearchBox
        value={search}
        onChange={setSearch}
        onSubmit={handleSearch}
        onClear={() => {
          setSearch('');
          setPage(1);
        }}
        label="Search people"
        placeholder="Search people"
      />

      {error && <LoadError label="people" retry={fetchUsers} />}

      {loading && users.length === 0 ? (
        <LoadingRows label="people" rows={4} />
      ) : users.length === 0 ? (
        !error &&
        (search ? (
          <p className="text-sm text-muted-foreground" role="status">
            Nobody matches “{search}”.
          </p>
        ) : (
          <EmptyCard kind="people" title="Nobody here yet." text="People show up here once they sign in." />
        ))
      ) : (
        <div className="grid min-w-0 gap-0.5">
          {users.map((user) => (
            <EntityRow
              key={user.id}
              href={`/admin/users/${user.id}`}
              kind="people"
              title={user.name || user.email || 'Someone'}
              context={
                <StatLine
                  items={[
                    user._count.ownedUniverses ? `Owns ${count(user._count.ownedUniverses, 'universe')}` : null,
                    user._count.worldMemberships ? `Member of ${count(user._count.worldMemberships, 'world')}` : null,
                    count(user.totalAccesses, 'visit'),
                  ]}
                />
              }
              meta={
                <StatLine
                  items={[
                    user.email !== undefined && (user.email || 'No email'),
                    user.lastAccessed && `last seen ${timeAgo(new Date(user.lastAccessed))}`,
                    `joined ${new Date(user.createdAt).toLocaleDateString()}`,
                  ]}
                />
              }
            />
          ))}
        </div>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        total={total}
        noun={['person', 'people']}
        loading={loading}
        onChange={(next) => setPage(Math.max(1, Math.min(totalPages, next)))}
      />
    </div>
  );
}
