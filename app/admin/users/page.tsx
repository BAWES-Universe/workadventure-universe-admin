'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/lib/time-ago';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine, count } from '../components/ds';
import { Pager, SearchBox } from '../discover/discover-ui';
import { WokaAvatar } from '../components/profile-card';
import { usePagedSearch } from '../hooks/use-paged-search';
import { useInitialSearch, useSearchInUrl } from '../hooks/use-search-in-url';

interface User {
  id: string;
  uuid: string;
  name: string | null;
  // Omitted by the API unless the viewer may see email addresses.
  email?: string | null;
  isGuest: boolean;
  createdAt: string;
  totalAccesses?: number;
  woka?: string[];
  lastAccessed?: string | null;
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
  };
}

interface UsersResult {
  users: User[];
  totalPages: number;
  total: number;
}

export default function UsersPage() {
  const router = useRouter();
  // The shell has already checked the session; a 401 below still leads to sign-in.
  const initialQuery = useInitialSearch();


  // One request per {query, page}; typing searches after a short pause, Enter searches now.
  const list = usePagedSearch<UsersResult>(
    async ({ query, page }, signal) => {
      const searchParam = query ? `&search=${encodeURIComponent(query)}` : '';
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users?page=${page}&limit=50${searchParam}`, { signal });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return null;
        }
        throw new Error('Failed to fetch users');
      }

      const data = await response.json();
      const rawUsers: User[] = data.users || [];
      // Hide system user from list
      const visibleUsers = rawUsers.filter(
        (user) => user.email !== 'system@workadventure.local',
      );
      const totalFromApi = data.pagination?.total ?? visibleUsers.length;
      const systemUsersOnPage = rawUsers.length - visibleUsers.length;
      return {
        users: visibleUsers,
        totalPages: data.pagination?.totalPages || 1,
        total: Math.max(0, totalFromApi - systemUsersOnPage),
      };
    },
    { debounceMs: 250, initialQuery },
  );
  useSearchInUrl(list.query);

  const users = list.data?.users ?? [];
  const totalPages = list.data?.totalPages ?? 1;
  const total = list.data?.total ?? 0;
  const { loading, page, query: search } = list;
  const error = list.error;

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="People" />

      <SearchBox
        value={list.input}
        onChange={list.setInput}
        onSubmit={list.submit}
        onClear={list.clear}
        label="Search people"
        placeholder="Search people"
      />

      {error && <LoadError label="people" retry={list.retry} />}

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
              leading={<WokaAvatar layers={user.woka ?? []} name={user.name || ''} size={40} />}
              title={user.name || user.email || 'Someone'}
              context={
                <StatLine
                  items={[
                    user._count.ownedUniverses ? `Owns ${count(user._count.ownedUniverses, 'universe')}` : null,
                    user._count.worldMemberships ? `Member of ${count(user._count.worldMemberships, 'world')}` : null,
                    count(user.totalAccesses, 'access', 'accesses'),
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
        onChange={(next) => list.setPage(Math.max(1, Math.min(totalPages, next)))}
      />
    </div>
  );
}
