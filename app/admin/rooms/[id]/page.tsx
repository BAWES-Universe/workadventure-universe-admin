'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useWorkAdventure } from '@/app/admin/workadventure-context';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  wamUrl: string | null;
  isPublic: boolean;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

export default function RoomDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [waNavigating, setWaNavigating] = useState(false);
  
  const { isReady: waReady, navigateToRoom } = useWorkAdventure();
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    isPublic: true,
  });

  useEffect(() => {
    checkAuth();
    fetchRoom();
    fetchAnalytics();
  }, [id]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchRoom() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/rooms');
          return;
        }
        throw new Error('Failed to fetch room');
      }

      const data = await response.json();
      setRoom(data);
      setFormData({
        slug: data.slug,
        name: data.name,
        description: data.description || '',
        mapUrl: data.mapUrl || '',
        isPublic: data.isPublic,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load room');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAnalytics() {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/rooms/${id}`);
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
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          mapUrl: formData.mapUrl || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update room');
      }

      const updated = await response.json();
      setRoom(updated);
      setIsEditing(false);
      await fetchRoom();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update room');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this room?')) {
      return;
    }

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete room');
      }

      router.push(`/admin/worlds/${room?.world.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete room');
    }
  }

  async function handleVisitRoomInUniverse() {
    if (!room) {
      alert('Room data not available');
      return;
    }

    if (!waReady) {
      alert('WorkAdventure API is not available. This feature only works when the admin page is loaded in a WorkAdventure iframe modal.');
      return;
    }

    try {
      setWaNavigating(true);
      
      // Format: /@/universe/world/room
      const roomUrl = `/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`;
      console.log('[RoomDetail] Navigating to room:', roomUrl);
      
      // Navigate to the room using WorkAdventure context
      await navigateToRoom(roomUrl);
      console.log('[RoomDetail] Navigation command sent');
    } catch (err) {
      console.error('[RoomDetail] Failed to navigate to room:', err);
      alert(err instanceof Error ? err.message : 'Failed to navigate to room');
    } finally {
      setWaNavigating(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading room...</p>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-red-800">Room not found</p>
        </div>
      </div>
    );
  }

  const defaultPlayUrl = process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost';

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
          <li>
            <Link href={`/admin/universes/${room.world.universe.id}`} className="text-gray-400 hover:text-gray-500">
              {room.world.universe.name}
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li>
            <Link href={`/admin/worlds/${room.world.id}`} className="text-gray-400 hover:text-gray-500">
              {room.world.name}
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">Rooms</li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">{room.name}</li>
        </ol>
      </nav>

      <div className="max-w-4xl">
        <div className="sm:flex sm:items-center sm:justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{room.name}</h1>
            <p className="mt-2 text-sm text-gray-700">
              In <Link href={`/admin/worlds/${room.world.id}`} className="text-indigo-600 hover:text-indigo-900">{room.world.name}</Link> • Slug: <code className="bg-gray-100 px-1 rounded">{room.slug}</code>
            </p>
          </div>
          <div className="mt-4 sm:mt-0 flex space-x-3">
            {!isEditing && (
              <>
                <a
                  href={`${defaultPlayUrl}/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  Visit Room
                </a>
                <button
                  onClick={handleVisitRoomInUniverse}
                  disabled={waNavigating || !waReady}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!waReady ? 'WorkAdventure API not available (only works in iframe)' : undefined}
                >
                  {waNavigating ? 'Navigating...' : 'Visit Room (within Universe)'}
                </button>
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

            <div>
              <label htmlFor="mapUrl" className="block text-sm font-medium text-gray-700">
                Map URL (Optional)
              </label>
              <p className="mt-1 text-sm text-gray-500">
                Override the world's map URL for this room. Leave empty to use the world's map.
              </p>
              <input
                type="url"
                id="mapUrl"
                value={formData.mapUrl}
                onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

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

            <div className="flex justify-end space-x-3 pt-4">
              <button
                onClick={() => {
                  setIsEditing(false);
                  fetchRoom();
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
          <div className="bg-white shadow rounded-lg p-6">
            <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">Description</dt>
                <dd className="mt-1 text-sm text-gray-900">{room.description || 'No description'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Status</dt>
                <dd className="mt-1">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    room.isPublic
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {room.isPublic ? 'Public' : 'Private'}
                  </span>
                </dd>
              </div>
              {room.mapUrl && (
                <div className="sm:col-span-2">
                  <dt className="text-sm font-medium text-gray-500">Map URL</dt>
                  <dd className="mt-1 text-sm text-gray-900 break-all">
                    <a href={room.mapUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-900">
                      {room.mapUrl}
                    </a>
                  </dd>
                </div>
              )}
              {room.wamUrl && (
                <div className="sm:col-span-2">
                  <dt className="text-sm font-medium text-gray-500">WAM URL</dt>
                  <dd className="mt-1 text-sm text-gray-900 break-all">
                    <a href={room.wamUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-900">
                      {room.wamUrl}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
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
                {(() => {
                  // Calculate peak hour in user's local timezone from recent activity
                  let peakHour = null;
                  let peakCount = 0;
                  
                  if (analytics.recentActivity && analytics.recentActivity.length > 0) {
                    const hourCounts = new Map<number, number>();
                    analytics.recentActivity.forEach((access: any) => {
                      const date = new Date(access.accessedAt);
                      const hour = date.getHours(); // User's local timezone
                      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
                    });
                    const localPeakTimes = Array.from(hourCounts.entries())
                      .map(([hour, count]) => ({ hour, count }))
                      .sort((a, b) => b.count - a.count);
                    if (localPeakTimes.length > 0) {
                      peakHour = localPeakTimes[0].hour;
                      peakCount = localPeakTimes[0].count;
                    }
                  }
                  
                  // Fallback to server-calculated peak time if no recent activity
                  if (peakHour === null && analytics.peakTimes && analytics.peakTimes.length > 0) {
                    peakHour = analytics.peakTimes[0].hour;
                    peakCount = analytics.peakTimes[0].count;
                  }
                  
                  return peakHour !== null ? (
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-sm font-medium text-gray-500">Peak Hour</div>
                      <div className="mt-1 text-lg font-semibold text-gray-900">
                        {String(peakHour).padStart(2, '0')}:00
                      </div>
                      <div className="text-xs text-gray-500">{peakCount} accesses</div>
                    </div>
                  ) : null;
                })()}
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
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">IP Address</th>
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
                            <td className="px-4 py-2 text-sm font-mono text-gray-500">
                              {access.ipAddress}
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

