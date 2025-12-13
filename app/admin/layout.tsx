import { ReactNode, Suspense } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import TokenHandler from './token-handler';
import AuthLink from './auth-link';
import WorkAdventureProvider from './workadventure-provider';
import MobileNav from './components/mobile-nav';
import DesktopNav from './components/desktop-nav';
import UserMenu from './components/user-menu';
import { ThemeProvider } from './components/theme-provider';
import { ThemeToggle } from './components/theme-toggle';

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
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <div className="min-h-screen bg-background">
        <nav className="bg-card shadow-sm sticky top-0 z-50 backdrop-blur-sm bg-card/95">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
            <div className="flex justify-between items-center h-16">
              <div className="flex items-center min-w-0 flex-1">
                {/* Mobile Navigation - replaces Orbit title on mobile */}
                <div className="sm:hidden">
                  <MobileNav user={user} />
                </div>
                {/* Desktop: Orbit title */}
                <div className="hidden sm:flex items-center flex-shrink-0">
                  <Suspense fallback={<span className="text-xl font-bold">Orbit</span>}>
                    <AuthLink href="/admin" className="text-xl font-bold truncate">
                      Orbit
                    </AuthLink>
                  </Suspense>
                </div>
                <DesktopNav user={user} />
              </div>
              <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
                {/* Theme Toggle */}
                <ThemeToggle />
                
                {/* Desktop User Info / Login */}
                <div className="hidden sm:flex items-center">
                  <UserMenu user={user} />
                </div>
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Suspense fallback={null}>
            <TokenHandler />
          </Suspense>
          <WorkAdventureProvider>
            {children}
          </WorkAdventureProvider>
        </main>
      </div>
    </ThemeProvider>
  );
}

