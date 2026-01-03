import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { isSuperAdmin } from '@/lib/super-admin';
import ConditionalNav from './components/conditional-nav';
import ConditionalContent from './components/conditional-content';
import { ThemeProvider } from './components/theme-provider';
import ToastWrapper from './components/toast-wrapper';

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
        isSuperAdmin: isSuperAdmin(user.email),
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
    <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      <ToastWrapper>
        <div className="min-h-screen bg-background">
          <ConditionalNav user={user} />
          <ConditionalContent>
            {children}
          </ConditionalContent>
        </div>
      </ToastWrapper>
    </ThemeProvider>
  );
}

