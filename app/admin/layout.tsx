import Link from 'next/link';
import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import LogoutButton from './logout-button';
import { prisma } from '@/lib/db';

async function getSessionUser() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('user_session');
    
    if (!sessionCookie) {
      return null;
    }

    const session = JSON.parse(sessionCookie.value);
    
    // Verify user still exists
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        uuid: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags: session.tags || [],
    };
  } catch (error) {
    return null;
  }
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <Link href="/admin" className="text-xl font-bold text-gray-900">
                  WorkAdventure Admin
                </Link>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <Link
                  href="/admin"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  Dashboard
                </Link>
                <Link
                  href="/admin/universes"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  My Universes
                </Link>
                <Link
                  href="/admin/worlds"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  My Worlds
                </Link>
                <Link
                  href="/admin/rooms"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  My Rooms
                </Link>
              </div>
            </div>
            <div className="flex items-center">
              {user ? (
                <div className="flex items-center space-x-4">
                  <span className="text-sm text-gray-700">
                    {user.name || user.email || 'User'}
                  </span>
                  <LogoutButton />
                </div>
              ) : (
                <Link
                  href="/admin/login"
                  className="text-sm text-indigo-600 hover:text-indigo-900"
                >
                  Login
                </Link>
              )}
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

