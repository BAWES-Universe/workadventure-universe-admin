'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  world: {
    id: string;
    name: string;
    universe: {
      id: string;
      name: string;
    };
  };
  _count: {
    favorites: number;
  };
}

interface World {
  id: string;
  name: string;
  universe: {
    id: string;
    name: string;
  };
}

export default function RoomsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorldId, setSelectedWorldId] = useState<string>(searchParams.get('worldId') || '');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (selectedWorldId) {
      fetchRooms();
    } else {
      fetchRooms();
      fetchWorlds();
    }
  }, [selectedWorldId]);

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

  async function fetchRooms() {
    try {
      setLoading(true);
      const url = selectedWorldId
        ? `/api/admin/rooms?worldId=${selectedWorldId}`
        : '/api/admin/rooms';
      
      const response = await fetch(url, {
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch rooms');
      }

      const data = await response.json();
      setRooms(data.rooms || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
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
      // Ignore errors
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this room?')) {
      return;
    }

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to delete room');
      }

      setRooms(rooms.filter(r => r.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete room');
    }
  }

  function handleWorldFilterChange(worldId: string) {
    setSelectedWorldId(worldId);
    const url = new URL(window.location.href);
    if (worldId) {
      url.searchParams.set('worldId', worldId);
    } else {
      url.searchParams.delete('worldId');
    }
    router.push(url.pathname + url.search);
  }

  if (loading) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading rooms...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-red-800">Error: {error}</p>
          <button
            onClick={fetchRooms}
            className="mt-2 text-sm text-red-600 hover:text-red-800"
          >
            Retry
          </button>
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
          <li className="text-gray-900">Rooms</li>
        </ol>
      </nav>

      <div className="sm:flex sm:items-center sm:justify-between">
        <div className="sm:flex-auto">
          <h1 className="text-3xl font-bold text-gray-900">Rooms</h1>
          <p className="mt-2 text-sm text-gray-700">
            Manage rooms. Rooms belong to worlds.
          </p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <Link
            href={selectedWorldId ? `/admin/rooms/new?worldId=${selectedWorldId}` : '/admin/rooms/new'}
            className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            Create Room
          </Link>
        </div>
      </div>

      {/* Filter */}
      {worlds.length > 0 && (
        <div className="mt-6">
          <label htmlFor="world-filter" className="block text-sm font-medium text-gray-700 mb-2">
            Filter by World
          </label>
          <select
            id="world-filter"
            value={selectedWorldId}
            onChange={(e) => handleWorldFilterChange(e.target.value)}
            className="block w-full sm:w-64 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="">All Worlds</option>
            {worlds.map((world) => (
              <option key={world.id} value={world.id}>
                {world.universe.name} / {world.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-8 flow-root">
        <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table className="min-w-full divide-y divide-gray-300">
              <thead>
                <tr>
                  <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">
                    Name
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    World
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Universe
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Status
                  </th>
                  <th className="relative py-3.5 pl-3 pr-4 sm:pr-0">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {rooms.map((room) => (
                  <tr key={room.id}>
                    <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-0">
                      {room.name}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      <Link
                        href={`/admin/worlds/${room.world.id}`}
                        className="text-indigo-600 hover:text-indigo-900"
                      >
                        {room.world.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      <Link
                        href={`/admin/universes/${room.world.universe.id}`}
                        className="text-indigo-600 hover:text-indigo-900"
                      >
                        {room.world.universe.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                        room.isPublic
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {room.isPublic ? 'Public' : 'Private'}
                      </span>
                    </td>
                    <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-0">
                      <Link
                        href={`/admin/rooms/${room.id}`}
                        className="text-indigo-600 hover:text-indigo-900 mr-4"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => handleDelete(room.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rooms.length === 0 && (
              <div className="text-center py-12">
                <p className="text-gray-500">
                  {selectedWorldId ? 'No rooms found in this world.' : 'No rooms found.'}
                </p>
                <Link
                  href={selectedWorldId ? `/admin/rooms/new?worldId=${selectedWorldId}` : '/admin/rooms/new'}
                  className="mt-4 inline-flex items-center text-indigo-600 hover:text-indigo-900"
                >
                  Create your first room
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

