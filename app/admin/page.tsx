import Link from 'next/link';

async function getStats() {
  const token = process.env.ADMIN_API_TOKEN;
  // Use internal URL for server-side requests (avoid Traefik loop)
  // In Docker, use localhost; on host, use localhost:3333
  const baseUrl = process.env.NEXT_PUBLIC_API_URL?.replace('admin.bawes.localhost', 'localhost:3333') || 'http://localhost:3333';
  
  try {
    const [universes, worlds, rooms, users] = await Promise.all([
      fetch(`${baseUrl}/api/admin/universes?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/worlds?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/rooms?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/users?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
    ]);
    
    return {
      universes: universes.pagination?.total || 0,
      worlds: worlds.pagination?.total || 0,
      rooms: rooms.pagination?.total || 0,
      users: users.pagination?.total || 0,
    };
  } catch (error) {
    console.error('Error fetching stats:', error);
    return { universes: 0, worlds: 0, rooms: 0, users: 0 };
  }
}

export default async function AdminDashboard() {
  const stats = await getStats();
  
  return (
    <div>
      <div className="px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-2 text-sm text-gray-700">
          Manage your WorkAdventure universes, worlds, rooms, and users.
        </p>
      </div>
      
      {stats.universes === 0 ? (
        <div className="mt-8 px-4 sm:px-6 lg:px-8">
          <div className="bg-white shadow rounded-lg p-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-gray-900">Get Started</h3>
            <p className="mt-2 text-sm text-gray-500">
              Create your first universe to begin organizing your WorkAdventure worlds and rooms.
            </p>
            <div className="mt-6">
              <Link
                href="/admin/universes/new"
                className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
              >
                Create Your First Universe
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-8 px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Link
              href="/admin/universes"
              className="bg-white overflow-hidden shadow rounded-lg hover:shadow-md transition-shadow"
            >
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">Universes</dt>
                      <dd className="text-lg font-medium text-gray-900">{stats.universes}</dd>
                    </dl>
                  </div>
                </div>
              </div>
            </Link>
            
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                    </svg>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">Worlds</dt>
                      <dd className="text-lg font-medium text-gray-900">{stats.worlds}</dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">Rooms</dt>
                      <dd className="text-lg font-medium text-gray-900">{stats.rooms}</dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
            
            <Link
              href="/admin/users"
              className="bg-white overflow-hidden shadow rounded-lg hover:shadow-md transition-shadow"
            >
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">Users</dt>
                      <dd className="text-lg font-medium text-gray-900">{stats.users}</dd>
                    </dl>
                  </div>
                </div>
              </div>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

