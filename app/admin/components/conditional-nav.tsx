'use client';

import { usePathname } from 'next/navigation';
import MobileNav from './mobile-nav';
import UserMenu from './user-menu';
import { ThemeToggle } from './theme-toggle';

interface ConditionalNavProps {
  user: {
    name: string | null;
    email: string | null;
    isSuperAdmin?: boolean;
  } | null;
}

export default function ConditionalNav({ user }: ConditionalNavProps) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/admin/login';

  if (isLoginPage) {
    return null;
  }

  return (
    <nav className="bg-card shadow-sm sticky top-0 z-50 backdrop-blur-sm bg-card/95">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center min-w-0 flex-1">
            {/* Orbit Menu - available on all screen sizes */}
            <MobileNav user={user} />
          </div>
          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
            {/* Theme Toggle */}
            <ThemeToggle />
            
            {/* User Info / Login */}
            <div className="flex items-center">
              <UserMenu user={user} />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

