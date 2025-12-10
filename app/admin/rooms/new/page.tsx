'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

// Force dynamic rendering to prevent static generation issues with useSearchParams
export const dynamic = 'force-dynamic';

interface World {
  id: string;
  name: string;
  universe: {
    id: string;
    name: string;
  };
}

export default function NewRoomPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const worldIdParam = searchParams.get('worldId');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  
  const [formData, setFormData] = useState({
    worldId: worldIdParam || '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    isPublic: true,
  });

  useEffect(() => {
    checkAuth();
    fetchWorlds();
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchWorlds() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds?limit=100');
      if (response.ok) {
        const data = await response.json();
        setWorlds(data.worlds || []);
      }
    } catch (err) {
      setError('Failed to load worlds');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!formData.worldId) {
      setError('Please select a world');
      return;
    }
    
    if (!formData.mapUrl || formData.mapUrl.trim() === '') {
      setError('Map URL is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          mapUrl: formData.mapUrl.trim(),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || data.error || 'Failed to create room');
      }

      const room = await response.json();
      router.push(`/admin/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setLoading(false);
    }
  }

  const selectedWorld = worlds.find(w => w.id === formData.worldId);

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
            <Link href="/admin/rooms" className="text-gray-400 hover:text-gray-500">
              Rooms
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">New Room</li>
        </ol>
      </nav>

      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold text-gray-900">Create Room</h1>
        <p className="mt-2 text-sm text-gray-700">
          Create a new room. Rooms belong to a world.
        </p>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {worlds.length === 0 && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-4">
            <p className="text-sm text-yellow-800">
              No worlds found. You need to create a world first.{' '}
              <Link href="/admin/worlds/new" className="text-yellow-900 underline">
                Create World
              </Link>
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-8 space-y-6 bg-white shadow rounded-lg p-6">
          <div>
            <label htmlFor="worldId" className="block text-sm font-medium text-gray-700">
              World <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              Select the world this room belongs to.
            </p>
            <select
              id="worldId"
              required
              value={formData.worldId}
              onChange={(e) => setFormData({ ...formData, worldId: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              disabled={!!worldIdParam}
            >
              <option value="">Select a world</option>
              {worlds.map((world) => (
                <option key={world.id} value={world.id}>
                  {world.universe.name} / {world.name}
                </option>
              ))}
            </select>
            {worldIdParam && selectedWorld && (
              <p className="mt-1 text-sm text-gray-500">
                Pre-selected: <Link href={`/admin/worlds/${selectedWorld.id}`} className="text-indigo-600 hover:text-indigo-900">{selectedWorld.universe.name} / {selectedWorld.name}</Link>
              </p>
            )}
            {worlds.length === 0 && (
              <p className="mt-1 text-sm text-red-500">
                No worlds available. <Link href="/admin/worlds/new" className="underline">Create one first</Link>.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="slug" className="block text-sm font-medium text-gray-700">
              Slug <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              URL identifier (e.g., "lobby"). Must be unique within the world.
            </p>
            <input
              type="text"
              id="slug"
              required
              value={formData.slug}
              onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              placeholder="lobby"
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
              placeholder="Lobby"
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
              placeholder="A brief description of this room"
            />
          </div>

          <div>
            <label htmlFor="mapUrl" className="block text-sm font-medium text-gray-700">
              Map URL <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              External TMJ map URL for this room (e.g., https://example.com/map.tmj). Each room must have its own map.
            </p>
            <input
              type="url"
              id="mapUrl"
              required
              value={formData.mapUrl}
              onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              placeholder="https://example.com/room-map.tmj"
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
            <Link
              href={formData.worldId ? `/admin/worlds/${formData.worldId}` : '/admin/rooms'}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || worlds.length === 0}
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

