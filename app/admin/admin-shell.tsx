'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { authenticatedFetch, getClientSessionId } from '@/lib/client-auth';
import { Spinner } from '@/components/ui/spinner';
import ConditionalNav from './components/conditional-nav';
import ConditionalContent from './components/conditional-content';

type User = { id: string; name: string | null; email: string | null; isSuperAdmin?: boolean };

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(pathname === '/admin/login');

  useEffect(() => {
    if (pathname === '/admin/login') return;
    if (!getClientSessionId()) {
      const redirect = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/admin/login?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    void authenticatedFetch('/api/auth/me').then(async (response) => {
      if (!response.ok) {
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/admin/login?redirect=${encodeURIComponent(redirect)}`);
        return;
      }
      const data = await response.json();
      setUser(data.user);
      setReady(true);
    }).catch(() => {
      const redirect = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/admin/login?redirect=${encodeURIComponent(redirect)}`);
    });
  }, [pathname]);

  if (pathname === '/admin/login') return <main>{children}</main>;
  if (!ready) return <div className="min-h-screen flex items-center justify-center"><Spinner className="size-8" /></div>;
  return <div className="min-h-screen bg-background"><ConditionalNav user={user} /><ConditionalContent>{children}</ConditionalContent></div>;
}
