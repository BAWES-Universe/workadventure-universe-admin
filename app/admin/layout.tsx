import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import LogoutButton from './logout-button';
import { prisma } from '@/lib/db';
import TokenHandler from './token-handler';
import AuthLink from './auth-link';

async function getSessionUser() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('user_session');
    
    // Return null immediately if no cookie - don't query database
    if (!sessionCookie || !sessionCookie.value || sessionCookie.value.trim() === '') {
      return null;
    }

    let session;
    try {
      session = JSON.parse(sessionCookie.value);
    } catch (e) {
      // Invalid cookie format, return null immediately
      return null;
    }

    // Return null immediately if no userId in session
    if (!session || !session.userId) {
      return null;
    }

    // Only query database if we have a valid session cookie with userId
    try {
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
      // Database query failed, return null to allow page to load
      console.error('[Layout] Error fetching user from database:', error);
      return null;
    }
  } catch (error) {
    // Any other error, return null to allow page to load
    return null;
  }
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Middleware handles authentication redirects, so we can safely get user here
  const user = await getSessionUser();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <AuthLink href="/admin" className="text-xl font-bold text-gray-900">
                  WorkAdventure Admin
                </AuthLink>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <AuthLink
                  href="/admin"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  Dashboard
                </AuthLink>
                <AuthLink
                  href="/admin/universes"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  Universes
                </AuthLink>
                <AuthLink
                  href="/admin/users"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  Users
                </AuthLink>
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
                <AuthLink
                  href="/admin/login"
                  className="text-sm text-indigo-600 hover:text-indigo-900"
                >
                  Login
                </AuthLink>
              )}
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <TokenHandler />
        {children}
      </main>
    </div>
  );
}

