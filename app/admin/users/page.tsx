'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

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
      setUsers(data.users || []);
      setTotalPages(data.pagination?.totalPages || 1);
      setTotal(data.pagination?.total || 0);
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
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-3xl font-bold text-gray-900">Users</h1>
          <p className="mt-2 text-sm text-gray-700">
            Manage users and their access to universes and worlds.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <form onSubmit={handleSearch} className="mb-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or UUID..."
              className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
            >
              Search
            </button>
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setPage(1);
                }}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              >
                Clear
              </button>
            )}
          </div>
        </form>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
            <p className="text-red-800">Error: {error}</p>
            <button
              onClick={fetchUsers}
              className="mt-2 text-sm text-red-600 hover:text-red-800"
            >
              Retry
            </button>
          </div>
        )}

        <div className="flow-root">
          <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
            <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
              <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg">
                <table className="min-w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                        Name
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        Email
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        UUID
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        Status
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        Universes
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        Worlds
                      </th>
                      <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {users.map((user) => (
                      <tr key={user.id} className={user.isGuest ? 'bg-gray-50' : ''}>
                        <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                          <Link
                            href={`/admin/users/${user.id}`}
                            className="text-indigo-600 hover:text-indigo-900"
                          >
                            {user.name || user.email || 'N/A'}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          {user.email || 'N/A'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500 font-mono text-xs">
                          {user.uuid}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm">
                          {user.isGuest ? (
                            <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
                              Guest
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                              Authenticated
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          {user._count.ownedUniverses}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          {user._count.worldMemberships}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {users.length === 0 && !loading && (
                  <div className="text-center py-12">
                    <p className="text-gray-500">No users found.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-gray-700">
              Showing page {page} of {totalPages} ({total} total users)
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

