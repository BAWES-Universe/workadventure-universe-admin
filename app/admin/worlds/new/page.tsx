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
      // If universeIdParam is set, try to fetch just that universe
      if (universeIdParam) {
        try {
          const universeResponse = await fetch(`/api/admin/universes/${universeIdParam}`, {
            credentials: 'include',
          });
          if (universeResponse.ok) {
            const universe = await universeResponse.json();
            setUniverses([universe]);
          }
        } catch (universeErr) {
          setError('Failed to load universe');
        }
      } else {
        setError('Failed to load universes');
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!formData.universeId) {
      setError('Universe ID is required. Please navigate to this page from a universe.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = {
        ...formData,
        description: formData.description || null,
        thumbnailUrl: formData.thumbnailUrl || null,
      };
      
      console.log('Submitting world:', payload);
      
      const response = await fetch('/api/admin/worlds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        // Show validation details if available
        const errorMessage = data.message || data.error || 'Failed to create world';
        throw new Error(errorMessage);
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

        {!universeIdParam && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-4">
            <p className="text-sm text-yellow-800">
              Universe ID is required. Please navigate to this page from a universe.{' '}
              <Link href="/admin/universes" className="text-yellow-900 underline">
                Go to Universes
              </Link>
            </p>
          </div>
        )}

        {universeIdParam && !selectedUniverse && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-4">
            <p className="text-sm text-yellow-800">
              Loading universe information...
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-8 space-y-6 bg-white shadow rounded-lg p-6">
          {selectedUniverse && (
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Universe
              </label>
              <p className="mt-1 text-sm text-gray-600">
                <Link href={`/admin/universes/${selectedUniverse.id}`} className="text-indigo-600 hover:text-indigo-900">
                  {selectedUniverse.name}
                </Link>
                {' '}({selectedUniverse.slug})
              </p>
              <input type="hidden" name="universeId" value={formData.universeId} />
            </div>
          )}

          <div>
            <label htmlFor="slug" className="block text-sm font-medium text-gray-700">
              Slug <span className="text-red-500">*</span>
            </label>
            <p className="mt-1 text-sm text-gray-500">
              URL identifier (e.g., "office-world"). Must be unique within the universe.
              {selectedUniverse && (
                <span className="block mt-1 text-gray-600">
                  Full path: <code className="bg-gray-100 px-1 rounded">/{selectedUniverse.slug}/[slug]</code>
                </span>
              )}
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
              disabled={loading || !universeIdParam || !selectedUniverse}
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

