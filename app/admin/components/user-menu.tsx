'use client';

import { useUser } from '../hooks/use-user';
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
      <span className="text-sm text-muted-foreground">
        {user.name || user.email || 'User'}
      </span>
    );
  }

  return (
    <Suspense fallback={<span className="text-sm text-primary">Login</span>}>
      <AuthLink
        href="/admin/login"
        className="text-sm text-primary hover:underline"
      >
        Login
      </AuthLink>
    </Suspense>
  );
}

