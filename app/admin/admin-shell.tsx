'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { authenticatedFetch, getClientSessionId } from '@/lib/client-auth';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import ConditionalNav from './components/conditional-nav';
import ConditionalContent from './components/conditional-content';
import { AdminBootstrapProvider, type AdminBootstrap } from './admin-bootstrap-context';

function loginRedirect() {
  const redirect = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/admin/login?redirect=${encodeURIComponent(redirect)}`);
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [bootstrap, setBootstrap] = useState<AdminBootstrap | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (pathname === '/admin/login') return;
    setError(null);
    if (!getClientSessionId()) {
      loginRedirect();
      return;
    }

    const endpoint = pathname === '/admin' ? '/api/admin/bootstrap' : '/api/auth/me';
    void authenticatedFetch(endpoint).then(async (response) => {
      if (response.status === 401) return loginRedirect();
      if (!response.ok) throw new Error('Unable to load your Orbit');
      const data = await response.json();
      setBootstrap((current) => endpoint === '/api/admin/bootstrap'
        ? data as AdminBootstrap
        : { version: 1, user: data.user, stats: current?.stats ?? { universes: 0, worlds: 0, rooms: 0, users: 0 } });
      setLoadedPath(pathname);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load your Orbit'));
  }, [attempt, pathname]);

  if (pathname === '/admin/login') return <main>{children}</main>;
  if (error) return <div className="min-h-screen flex flex-col gap-4 items-center justify-center"><p>{error}</p><Button onClick={load}>Try again</Button></div>;
  if (!bootstrap || loadedPath !== pathname) return <div className="min-h-screen flex items-center justify-center"><div className="text-center"><Spinner className="size-8 mx-auto mb-4" /><p>Loading your orbit..</p></div></div>;

  return <AdminBootstrapProvider value={bootstrap}><div className="min-h-screen bg-background"><ConditionalNav user={bootstrap.user} /><ConditionalContent>{children}</ConditionalContent></div></AdminBootstrapProvider>;
}
