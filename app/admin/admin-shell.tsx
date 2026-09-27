'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useOrbitHistory } from './hooks/use-orbit-history';
import { authenticatedFetch, getClientSessionId } from '@/lib/client-auth';
import { isInsideFrame, requestView as requestFrameView } from '@/lib/orbit-frame';
import type { OrbitView } from '@/lib/orbit-bridge';
import { Button } from '@/components/ui/button';
import OrbitBridge from './components/orbit-bridge';
import { AdminBootstrapProvider, type AdminBootstrap } from './admin-bootstrap-context';
import { OrbitFrameProvider, type OrbitFrameState } from './orbit-frame-context';
import { resolveRoute } from './config/routes';
import WorkAdventureProvider from './workadventure-provider';
import { useWorkAdventure } from './workadventure-context';
import { OrbitLoader } from './components/shell/orbit-loader';
import { TopBar } from './components/shell/top-bar';
import { BottomNav } from './components/shell/bottom-nav';
import { Sidebar } from './components/shell/sidebar';
import { MenuSheet } from './components/shell/menu-sheet';
import { PageTransition } from './components/shell/page-transition';

function loginRedirect() {
  const redirect = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/admin/login?redirect=${encodeURIComponent(redirect)}`);
}

/**
 * Orbit's shell: one steady frame around every page.
 *
 * It loads the session once and keeps the bars in place from then on. Going from page to page never shows a
 * loader over everything: the page arrives inside the frame, and fetches what it needs itself. Each page visit
 * re-checks the session in the background (Home also refreshes its numbers); only a session that is gone sends
 * you to sign in.
 */
export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [bootstrap, setBootstrap] = useState<AdminBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<OrbitView>('compact');
  const [canRequestView, setCanRequestView] = useState(false);
  const confirmView = useCallback((next: OrbitView) => {
    setView(next);
    setCanRequestView(true);
  }, []);
  const hasBootstrap = bootstrap !== null;

  const load = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (pathname === '/admin/login') return;
    if (!getClientSessionId()) {
      loginRedirect();
      return;
    }

    const controller = new AbortController();
    // The first load, and every visit to Home, brings the numbers too; elsewhere, only the session is re-checked.
    const endpoint = !hasBootstrap || pathname === '/admin' ? '/api/admin/bootstrap' : '/api/auth/me';
    void authenticatedFetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) return loginRedirect();
        if (!response.ok) throw new Error('Unable to load your Orbit');
        const data = await response.json();
        if (controller.signal.aborted) return;
        setError(null);
        setBootstrap((current) =>
          endpoint === '/api/admin/bootstrap'
            ? (data as AdminBootstrap)
            : {
                version: 1,
                user: data.user,
                stats: current?.stats ?? { universes: 0, worlds: 0, rooms: 0, users: 0 },
                mine: current?.mine,
              },
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unable to load your Orbit');
        }
      });

    return () => controller.abort();
    // `hasBootstrap` only decides the endpoint; a change of it must not start another request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, pathname]);

  const requestView = useCallback((next: OrbitView) => {
    // The host owns the actual size. Wait for its bridge confirmation.
    requestFrameView(next);
  }, []);

  if (pathname === '/admin/login') return <main>{children}</main>;

  if (!bootstrap) {
    if (error) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button onClick={load}>Try again</Button>
        </div>
      );
    }
    return <OrbitLoader className="min-h-dvh" />;
  }

  return (
    <AdminBootstrapProvider value={bootstrap}>
      <WorkAdventureProvider>
        <OrbitBridge onRefresh={load} onView={confirmView} />
        <ShellChrome canRequestView={canRequestView} view={view} requestView={requestView} user={bootstrap.user} error={error} retry={load}>
          {children}
        </ShellChrome>
      </WorkAdventureProvider>
    </AdminBootstrapProvider>
  );
}

function ShellChrome({
  children,
  canRequestView,
  view,
  requestView,
  user,
  error,
  retry,
}: {
  children: React.ReactNode;
  canRequestView: boolean;
  view: OrbitView;
  requestView: (view: OrbitView) => void;
  user: AdminBootstrap['user'];
  error: string | null;
  retry: () => void;
}) {
  const pathname = usePathname();
  const { wa } = useWorkAdventure();
  const [menuOpen, setMenuOpen] = useState(false);
  const inFrame = useMemo(() => isInsideFrame(), []);
  const route = useMemo(() => resolveRoute(pathname), [pathname]);

  const { goBack } = useOrbitHistory(route.parent);

  const closeOrbit = useCallback(() => {
    if (!inFrame) return;
    try {
      wa?.ui.modal.closeModal();
    } catch (cause) {
      console.warn('[Orbit] Could not close through the game', cause);
    }
  }, [inFrame, wa]);

  // Escape closes only the top layer: a dialog or menu handles it itself (and says so), an edited field lets go of
  // focus, and with nothing above the page, Orbit closes. Keys pressed here never reach the game.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
        event.preventDefault();
        setMenuOpen(true);
        return;
      }
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.matches('input, textarea, select, [contenteditable="true"]')
      ) {
        active.blur();
        return;
      }
      closeOrbit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeOrbit]);

  const frame: OrbitFrameState = useMemo(
    () => ({ inFrame, canRequestView, view, requestView, route, goBack, closeOrbit, menuOpen, setMenuOpen }),
    [inFrame, canRequestView, view, requestView, route, goBack, closeOrbit, menuOpen],
  );

  return (
    <OrbitFrameProvider value={frame}>
      <div className="observatory-shell">
        <Sidebar user={user} />
        <div className="observatory-shell-body">
          <a href="#orbit-main" className="observatory-skip-link">Skip to content</a>
          <TopBar />
          <BottomNav />
          {error && (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm sm:mx-6">
              <span>{error}</span>
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          <main
            id="orbit-main"
            className="observatory-main"
            tabIndex={-1}
          >
            <PageTransition key={pathname}>{children}</PageTransition>
          </main>
        </div>
        <MenuSheet user={user} />
      </div>
    </OrbitFrameProvider>
  );
}
