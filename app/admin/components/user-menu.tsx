'use client';

import { useUser } from '../hooks/use-user';
import LogoutButton from '../logout-button';
import AuthLink from '../auth-link';
import { Suspense } from 'react';

interface UserMenuProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function UserMenu({ user: initialUser }: UserMenuProps) {
  const { user } = useUser(initialUser ? {
    id: '',
    name: initialUser.name,
    email: initialUser.email,
  } : null);

  if (user) {
    return (
      <div className="flex items-center space-x-4">
        <span className="text-sm text-gray-700">
          {user.name || user.email || 'User'}
        </span>
        <LogoutButton />
      </div>
    );
  }

  return (
    <Suspense fallback={<span className="text-sm text-indigo-600">Login</span>}>
      <AuthLink
        href="/admin/login"
        className="text-sm text-indigo-600 hover:text-indigo-900"
      >
        Login
      </AuthLink>
    </Suspense>
  );
}

