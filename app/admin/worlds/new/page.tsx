'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface Universe {
  id: string;
  name: string;
  slug: string;
}

export default function NewWorldPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const universeIdParam = searchParams.get('universeId');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [universes, setUniverses] = useState<Universe[]>([]);
  
  const [formData, setFormData] = useState({
    universeId: universeIdParam || '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    wamUrl: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
  });

  useEffect(() => {
    checkAuth();
    fetchUniverses();
  }, []);

  async function checkAuth() {
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchUniverses() {
    try {
      const response = await fetch('/api/admin/universes?limit=100', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setUniverses(data.universes || []);
      }
    } catch (err) {
      setError('Failed to load universes');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!formData.universeId) {
      setError('Please select a universe');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/worlds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          mapUrl: formData.mapUrl || null,
          wamUrl: formData.wamUrl || null,
          thumbnailUrl: formData.thumbnailUrl || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create world');
      }

      const world = await response.json();
      router.push(`/admin/worlds/${world.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create world');
    } finally {
      setLoading(false);
    }
  }

  const selectedUniverse = universes.find(u => u.id === formData.universeId);

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
            <Link href="/admin/worlds" className="text-gray-400 hover:text-gray-500">
              Worlds
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">New World</li>
        </ol>
      </nav>

      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold text-gray-900">Create World</h1>
        <p className="mt-2 text-sm text-gray-700">
          Create a new world. Worlds belong to a universe and contain rooms.
        </p>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {universes.length === 0 && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-4">
            <p className="text-sm text-yellow-800">
              No universes found. You need to create a universe first.{' '}
              <Link href="/admin/universes/new" className="text-yellow-900 underline">
                Create Universe
              </Link>
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-8 space-y-6 bg-white shadow rounded-lg p-6">
          <div>
            <label htmlFor="universeId" className="block text-sm font-medium text-gray-700">
              Universe <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              Select the universe this world belongs to.
            </p>
            <select
              id="universeId"
              required
              value={formData.universeId}
              onChange={(e) => setFormData({ ...formData, universeId: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              disabled={!!universeIdParam}
            >
              <option value="">Select a universe</option>
              {universes.map((universe) => (
                <option key={universe.id} value={universe.id}>
                  {universe.name} ({universe.slug})
                </option>
              ))}
            </select>
            {universeIdParam && selectedUniverse && (
              <p className="mt-1 text-sm text-gray-500">
                Pre-selected: <Link href={`/admin/universes/${selectedUniverse.id}`} className="text-indigo-600 hover:text-indigo-900">{selectedUniverse.name}</Link>
              </p>
            )}
            {universes.length === 0 && (
              <p className="mt-1 text-sm text-red-500">
                No universes available. <Link href="/admin/universes/new" className="underline">Create one first</Link>.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="slug" className="block text-sm font-medium text-gray-700">
              Slug <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              URL identifier (e.g., "office-world"). Must be unique within the universe.
            </p>
            <input
              type="text"
              id="slug"
              required
              value={formData.slug}
              onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              placeholder="office-world"
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
              placeholder="Office Building"
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
              placeholder="A brief description of this world"
            />
          </div>

          <div>
            <label htmlFor="mapUrl" className="block text-sm font-medium text-gray-700">
              Map URL
            </label>
            <p className="mt-1 text-sm text-gray-500">
              Tiled map JSON URL for this world.
            </p>
            <input
              type="url"
              id="mapUrl"
              value={formData.mapUrl}
              onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              placeholder="https://example.com/map.json"
            />
          </div>

          <div>
            <label htmlFor="wamUrl" className="block text-sm font-medium text-gray-700">
              WAM URL
            </label>
            <p className="mt-1 text-sm text-gray-500">
              WAM file URL for this world.
            </p>
            <input
              type="url"
              id="wamUrl"
              value={formData.wamUrl}
              onChange={(e) => setFormData({ ...formData, wamUrl: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              placeholder="https://example.com/world.wam"
            />
          </div>

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
              placeholder="https://example.com/thumbnail.jpg"
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
            <Link
              href={formData.universeId ? `/admin/universes/${formData.universeId}` : '/admin/worlds'}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || universes.length === 0}
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create World'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

