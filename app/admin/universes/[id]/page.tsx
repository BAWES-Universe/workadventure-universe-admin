'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  owner: {
    id: string;
    name: string | null;
    email: string | null;
  };
  worlds: Array<{
    id: string;
    slug: string;
    name: string;
    _count: {
      rooms: number;
      members: number;
    };
  }>;
}

interface User {
  id: string;
  name: string | null;
  email: string | null;
}

export default function UniverseDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [universe, setUniverse] = useState<Universe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    ownerId: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
  });

  useEffect(() => {
    checkAuth();
    fetchUniverse();
    fetchUsers();
    fetchAnalytics();
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

  async function fetchUniverse() {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/universes/${id}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/universes');
          return;
        }
        throw new Error('Failed to fetch universe');
      }

      const data = await response.json();
      setUniverse(data);
      setFormData({
        slug: data.slug,
        name: data.name,
        description: data.description || '',
        ownerId: data.ownerId,
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load universe');
    } finally {
      setLoading(false);
    }
  }

  async function fetchUsers() {
    try {
      const response = await fetch('/api/admin/users?limit=100', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setUsers(data.users || []);
      }
    } catch (err) {
      // Ignore errors
    }
  }

  async function fetchAnalytics() {
    try {
      setAnalyticsLoading(true);
      const response = await fetch(`/api/admin/analytics/universes/${id}`, {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/universes/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          thumbnailUrl: formData.thumbnailUrl || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update universe');
      }

      const updated = await response.json();
      setUniverse(updated);
      setIsEditing(false);
      await fetchUniverse();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update universe');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this universe? This will also delete all worlds and rooms in it.')) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/universes/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to delete universe');
      }

      router.push('/admin/universes');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete universe');
    }
  }

  if (loading) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading universe...</p>
        </div>
      </div>
    );
  }

  if (!universe) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-red-800">Universe not found</p>
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
            <Link href="/admin/universes" className="text-gray-400 hover:text-gray-500">
              Universes
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">{universe.name}</li>
        </ol>
      </nav>

      <div className="max-w-4xl">
        <div className="sm:flex sm:items-center sm:justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{universe.name}</h1>
            <p className="mt-2 text-sm text-gray-700">
              Slug: <code className="bg-gray-100 px-1 rounded">{universe.slug}</code>
            </p>
          </div>
          <div className="mt-4 sm:mt-0 flex space-x-3">
            {!isEditing && (
              <>
                <Link
                  href={`/admin/worlds/new?universeId=${id}`}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  Create World
                </Link>
                <button
                  onClick={() => setIsEditing(true)}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  onClick={handleDelete}
                  className="inline-flex items-center px-4 py-2 border border-red-300 rounded-md shadow-sm text-sm font-medium text-red-700 bg-white hover:bg-red-50"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {isEditing ? (
          <div className="bg-white shadow rounded-lg p-6 space-y-6">
            <div>
              <label htmlFor="slug" className="block text-sm font-medium text-gray-700">
                Slug <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="slug"
                required
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="name"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700">
                Description
              </label>
              <textarea
                id="description"
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            {users.length > 0 && (
              <div>
                <label htmlFor="ownerId" className="block text-sm font-medium text-gray-700">
                  Owner <span className="text-red-500">*</span>
                </label>
                <select
                  id="ownerId"
                  required
                  value={formData.ownerId}
                  onChange={(e) => setFormData({ ...formData, ownerId: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email || u.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="thumbnailUrl" className="block text-sm font-medium text-gray-700">
                Thumbnail URL
              </label>
              <input
                type="url"
                id="thumbnailUrl"
                value={formData.thumbnailUrl}
                onChange={(e) => setFormData({ ...formData, thumbnailUrl: e.target.value })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isPublic"
                  checked={formData.isPublic}
                  onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label htmlFor="isPublic" className="ml-2 block text-sm text-gray-900">
                  Public
                </label>
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="featured"
                  checked={formData.featured}
                  onChange={(e) => setFormData({ ...formData, featured: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label htmlFor="featured" className="ml-2 block text-sm text-gray-900">
                  Featured
                </label>
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                onClick={() => {
                  setIsEditing(false);
                  fetchUniverse();
                }}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6">
              <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-medium text-gray-500">Description</dt>
                  <dd className="mt-1 text-sm text-gray-900">{universe.description || 'No description'}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500">Owner</dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {universe.owner.name || universe.owner.email || 'Unknown'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500">Status</dt>
                  <dd className="mt-1">
                    <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                      universe.isPublic
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {universe.isPublic ? 'Public' : 'Private'}
                    </span>
                    {universe.featured && (
                      <span className="ml-2 inline-flex rounded-full px-2 text-xs font-semibold leading-5 bg-yellow-100 text-yellow-800">
                        Featured
                      </span>
                    )}
                  </dd>
                </div>
                {universe.thumbnailUrl && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Thumbnail</dt>
                    <dd className="mt-1">
                      <img src={universe.thumbnailUrl} alt={universe.name} className="h-20 w-20 object-cover rounded" />
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Worlds Section */}
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-medium text-gray-900">Worlds ({universe.worlds.length})</h2>
                <Link
                  href={`/admin/worlds/new?universeId=${id}`}
                  className="text-sm text-indigo-600 hover:text-indigo-900"
                >
                  + Add World
                </Link>
              </div>
              {universe.worlds.length === 0 ? (
                <p className="text-sm text-gray-500">No worlds yet. Create one to get started.</p>
              ) : (
                <div className="space-y-3">
                  {universe.worlds.map((world) => (
                    <Link
                      key={world.id}
                      href={`/admin/worlds/${world.id}`}
                      className="block p-3 border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-gray-900">{world.name}</h3>
                          <p className="text-sm text-gray-500">
                            {world._count.rooms} rooms • {world._count.members} members
                          </p>
                        </div>
                        <span className="text-sm text-gray-400">→</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Analytics Section */}
        <div className="mt-6 bg-white shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Analytics</h2>
          </div>

          {analyticsLoading ? (
            <div className="p-6 text-center text-gray-500">Loading analytics...</div>
          ) : analytics ? (
            <div className="p-6">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-4 mb-6">
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm font-medium text-gray-500">Total Accesses</div>
                  <div className="mt-1 text-2xl font-semibold text-gray-900">{analytics.totalAccesses}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm font-medium text-gray-500">Unique Users</div>
                  <div className="mt-1 text-2xl font-semibold text-gray-900">{analytics.uniqueUsers}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm font-medium text-gray-500">Unique IPs</div>
                  <div className="mt-1 text-2xl font-semibold text-gray-900">{analytics.uniqueIPs}</div>
                </div>
                {analytics.mostActiveWorld && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-sm font-medium text-gray-500">Most Active World</div>
                    <div className="mt-1 text-lg font-semibold text-gray-900">{analytics.mostActiveWorld.name}</div>
                    <div className="text-xs text-gray-500">{analytics.mostActiveWorld.accessCount} accesses</div>
                  </div>
                )}
              </div>

              {analytics.recentActivity && analytics.recentActivity.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-900 mb-3">Recent Activity</h3>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">World / Room</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {analytics.recentActivity.slice(0, 10).map((access: any) => (
                          <tr key={access.id}>
                            <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                              {new Date(access.accessedAt).toLocaleString()}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-900">
                              {access.userName || access.userEmail || access.userUuid || 'Guest'}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-900">
                              <Link href={`/admin/worlds/${access.world.id}`} className="text-indigo-600 hover:text-indigo-900">
                                {access.world.name}
                              </Link>
                              <span className="text-gray-400 mx-1">/</span>
                              <Link href={`/admin/rooms/${access.room.id}`} className="text-indigo-600 hover:text-indigo-900">
                                {access.room.name}
                              </Link>
                            </td>
                            <td className="px-4 py-2 whitespace-nowrap text-sm">
                              {access.hasMembership && access.membershipTags.length > 0 ? (
                                <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                                  {access.membershipTags.join(', ')}
                                </span>
                              ) : access.isAuthenticated ? (
                                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                                  Authenticated
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                                  Guest
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-6 text-center text-gray-500">No analytics data available.</div>
          )}
        </div>
      </div>
    </div>
  );
}

