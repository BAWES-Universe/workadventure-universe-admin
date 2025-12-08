'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';

interface WorldMembership {
  id: string;
  tags: string[];
  joinedAt: string;
  world: {
    id: string;
    slug: string;
    name: string;
    universe: {
      id: string;
      slug: string;
      name: string;
    };
  };
}

interface Universe {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
  createdAt: string;
}

interface User {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
  matrixChatId: string | null;
  lastIpAddress: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
  ownedUniverses: Universe[];
  worldMemberships: WorldMembership[];
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
    bans: number;
    favorites: number;
    avatars: number;
  };
}

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
    fetchUser();
  }, [id]);

  async function checkAuth() {
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchUser() {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/users/${id}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/users');
          return;
        }
        throw new Error('Failed to fetch user');
      }

      const data = await response.json();
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading user...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-red-800">User not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8">
      {/* Breadcrumbs */}
      <nav className="flex mb-6" aria-label="Breadcrumb">
        <ol className="flex items-center space-x-4">
          <li>
            <Link href="/admin" className="text-gray-400 hover:text-gray-500">
              Dashboard
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li>
            <Link href="/admin/users" className="text-gray-400 hover:text-gray-500">
              Users
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">{user.name || user.email || 'User'}</li>
        </ol>
      </nav>

      <div className="max-w-4xl">
        <div className="sm:flex sm:items-center sm:justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{user.name || user.email || 'Unknown User'}</h1>
            <p className="mt-2 text-sm text-gray-700">
              UUID: <code className="bg-gray-100 px-1 rounded font-mono text-xs">{user.uuid}</code>
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <div className="bg-white shadow rounded-lg p-6">
          <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-gray-500">Name</dt>
              <dd className="mt-1 text-sm text-gray-900">{user.name || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Email</dt>
              <dd className="mt-1 text-sm text-gray-900">{user.email || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Status</dt>
              <dd className="mt-1">
                {user.isGuest ? (
                  <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
                    Guest
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                    Authenticated
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Matrix Chat ID</dt>
              <dd className="mt-1 text-sm text-gray-900 font-mono text-xs">{user.matrixChatId || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Last IP Address</dt>
              <dd className="mt-1 text-sm text-gray-900 font-mono text-xs">{user.lastIpAddress || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">{new Date(user.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Last Updated</dt>
              <dd className="mt-1 text-sm text-gray-900">{new Date(user.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </div>

        {/* Statistics */}
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-4">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <span className="text-2xl">🌌</span>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Owned Universes</dt>
                    <dd className="text-lg font-medium text-gray-900">{user._count.ownedUniverses}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <span className="text-2xl">🌍</span>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">World Memberships</dt>
                    <dd className="text-lg font-medium text-gray-900">{user._count.worldMemberships}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <span className="text-2xl">⭐</span>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Favorites</dt>
                    <dd className="text-lg font-medium text-gray-900">{user._count.favorites}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <span className="text-2xl">🚫</span>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Bans</dt>
                    <dd className="text-lg font-medium text-gray-900">{user._count.bans}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Owned Universes */}
        {user.ownedUniverses.length > 0 && (
          <div className="mt-6 bg-white shadow rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">Owned Universes</h2>
            </div>
            <ul className="divide-y divide-gray-200">
              {user.ownedUniverses.map((universe) => (
                <li key={universe.id}>
                  <Link
                    href={`/admin/universes/${universe.id}`}
                    className="block hover:bg-gray-50 px-6 py-4"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{universe.name}</p>
                        <p className="text-sm text-gray-500">
                          Slug: <code className="bg-gray-100 px-1 rounded">{universe.slug}</code>
                        </p>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                          universe.isPublic
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {universe.isPublic ? 'Public' : 'Private'}
                        </span>
                        <span className="text-gray-400">→</span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* World Memberships */}
        {user.worldMemberships.length > 0 && (
          <div className="mt-6 bg-white shadow rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">World Memberships</h2>
            </div>
            <ul className="divide-y divide-gray-200">
              {user.worldMemberships.map((membership) => (
                <li key={membership.id}>
                  <Link
                    href={`/admin/worlds/${membership.world.id}`}
                    className="block hover:bg-gray-50 px-6 py-4"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{membership.world.name}</p>
                        <p className="text-sm text-gray-500">
                          {membership.world.universe.name} / {membership.world.name}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          Joined: {new Date(membership.joinedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center space-x-2">
                        {membership.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {membership.tags.map((tag) => (
                              <span
                                key={tag}
                                className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                                  tag === 'admin'
                                    ? 'bg-red-100 text-red-800'
                                    : tag === 'editor'
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-gray-100 text-gray-800'
                                }`}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">No tags</span>
                        )}
                        <span className="text-gray-400">→</span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Empty States */}
        {user.ownedUniverses.length === 0 && user.worldMemberships.length === 0 && (
          <div className="mt-6 bg-white shadow rounded-lg p-6">
            <p className="text-sm text-gray-500 text-center">
              This user doesn't own any universes or have any world memberships.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

