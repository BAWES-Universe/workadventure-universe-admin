'use client';

import { Suspense } from 'react';
import NavLink from './nav-link';
import { getNavItems } from '../config/navigation';
import { useUser } from '../hooks/use-user';

interface DesktopNavProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function DesktopNav({ user: initialUser }: DesktopNavProps) {
  const { user } = useUser(initialUser ? {
    id: '',
    name: initialUser.name,
    email: initialUser.email,
  } : null);

  const navItems = getNavItems(user);

  return (
    <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
      {navItems.map((item) => (
        <Suspense key={item.href} fallback={<span className="border-transparent text-muted-foreground inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium">{item.label}</span>}>
          <NavLink href={item.href} className="border-transparent text-muted-foreground hover:border-foreground hover:text-foreground inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors">
            {item.label}
          </NavLink>
        </Suspense>
      ))}
    </div>
  );
}

