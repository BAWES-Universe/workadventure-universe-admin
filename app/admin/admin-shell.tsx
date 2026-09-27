'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { authenticatedFetch, getClientSessionId } from '@/lib/client-auth';
import { isInsideFrame } from '@/lib/orbit-frame';
import type { OrbitView } from '@/lib/orbit-bridge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
  const hasBootstrap = bootstrap !== null;

  const load = useCallback(() => setAttempt((value) => value + 1), []);
  // Set when the game says something changed: the next load brings fresh numbers wherever you are.
  const wantBootstrap = useRef(false);
  const refreshFromGame = useCallback(() => {
    wantBootstrap.current = true;
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (pathname === '/admin/login') return;
    if (!getClientSessionId()) {
      loginRedirect();
      return;
    }

    const controller = new AbortController();
    // The first load, every visit to Orbit, You or Space, and a change in the game bring the numbers too; elsewhere,
    // only the session is re-checked.
    const rootPage = pathname === '/admin' || pathname === '/admin/you' || pathname === '/admin/space';
    const endpoint = !hasBootstrap || rootPage || wantBootstrap.current ? '/api/admin/bootstrap' : '/api/auth/me';
    wantBootstrap.current = false;
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
        <OrbitBridge onRefresh={refreshFromGame} onView={setView} />
        <ShellChrome view={view} user={bootstrap.user} error={error} retry={load}>
          {children}
        </ShellChrome>
      </WorkAdventureProvider>
    </AdminBootstrapProvider>
  );
}

function ShellChrome({
  children,
  view,
  user,
  error,
  retry,
}: {
  children: React.ReactNode;
  view: OrbitView;
  user: AdminBootstrap['user'];
  error: string | null;
  retry: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { wa } = useWorkAdventure();
  const [menuOpen, setMenuOpen] = useState(false);
  const inFrame = useMemo(() => isInsideFrame(), []);
  const route = useMemo(() => resolveRoute(pathname), [pathname]);

  // Orbit's own history this visit: the pages behind (Back) and ahead (Forward), as addresses. A popstate is read by
  // comparing the new address with both ends, so Back and Forward (the browser's, or ours) keep the stacks right.
  // A page we don't recognise from either end starts a fresh path. Back goes to the page behind when there is one,
  // named after it; otherwise the page's parent takes the current page's place.
  const behind = useRef<string[]>([]);
  const ahead = useRef<string[]>([]);
  const lastPath = useRef(pathname);
  const popping = useRef(false);
  const replacing = useRef(false);
  const [behindTop, setBehindTop] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = () => {
      popping.current = true;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const previous = lastPath.current;
    if (pathname === previous) {
      popping.current = false;
      return;
    }
    if (popping.current) {
      if (behind.current[behind.current.length - 1] === pathname) {
        behind.current.pop();
        ahead.current.push(previous);
      } else if (ahead.current[ahead.current.length - 1] === pathname) {
        ahead.current.pop();
        behind.current.push(previous);
      } else {
        behind.current = [];
        ahead.current = [];
      }
    } else if (!replacing.current) {
      behind.current.push(previous);
      ahead.current = [];
    }
    popping.current = false;
    replacing.current = false;
    lastPath.current = pathname;
    setBehindTop(behind.current[behind.current.length - 1] ?? null);
  }, [pathname]);

  const goBack = useCallback(() => {
    if (behind.current.length > 0) {
      router.back();
      return;
    }
    if (route.parent) {
      // The first page of this visit: its parent takes its place, so the browser's Back still closes Orbit.
      replacing.current = true;
      router.replace(route.parent);
    }
  }, [router, route.parent]);
  // What Back says: the page it really returns to.
  const backLabel = behindTop ? resolveRoute(behindTop).title : route.parentTitle;

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
      // Ctrl+K (Cmd+K on a Mac) opens and closes the menu from anywhere, unless another dialog is open.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        const otherDialog = document.querySelector('[role="dialog"][data-state="open"]:not(#orbit-menu), [role="alertdialog"][data-state="open"]');
        if (otherDialog) return;
        event.preventDefault();
        setMenuOpen(!menuOpen);
        return;
      }
      if (event.key !== 'Escape') return;
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
    () => ({ inFrame, view, route, goBack, backLabel, closeOrbit, menuOpen, setMenuOpen }),
    [inFrame, view, route, goBack, backLabel, closeOrbit, menuOpen],
  );

  return (
    <OrbitFrameProvider value={frame}>
      <div className="min-h-dvh bg-background" style={{ ['--sidebar-width' as string]: '15.5rem' }}>
        <div className="orbit-orbs" aria-hidden="true">
          <i />
          <i />
        </div>
        <Sidebar user={user} />
        <div className="flex min-h-dvh flex-col lg:pl-[var(--sidebar-width)]">
          <TopBar isSuperAdmin={Boolean(user?.isSuperAdmin)} />
          {/* Before the page in the DOM, so that as a strip under the bar (a desktop panel) it sticks there. */}
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
            className={cn('orbit-above-orbs mx-auto w-full max-w-7xl flex-1 px-4 pt-4 sm:px-6 lg:px-8 lg:pt-6', route.parent === null && 'orbit-dock-space')}
            style={{ paddingBottom: route.parent === null ? 'calc(var(--bottombar-height) + var(--safe-bottom) + 1.5rem)' : '2rem' }}
          >
            <PageTransition key={pathname}>{children}</PageTransition>
          </main>
        </div>
        <MenuSheet user={user} />
      </div>
    </OrbitFrameProvider>
  );
}
