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
import { sectionOf } from './components/shell/root-of';
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
/** A page in Orbit's own history, and the section it was lit under. */
interface HistoryEntry {
  path: string;
  section: string;
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [bootstrap, setBootstrap] = useState<AdminBootstrap | null>(null);
  // An error belongs to the request that failed: another page or another try hides it at once.
  const [failure, setFailure] = useState<{ message: string; request: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<OrbitView>('compact');
  const hasBootstrap = bootstrap !== null;

  const request = `${attempt}|${pathname}`;
  const error = failure?.request === request ? failure.message : null;
  // Trying again shows the loader, not the last error, until the answer comes.
  const load = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  // Set when the game says something changed: loads bring fresh numbers wherever you are until one arrives.
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
    void authenticatedFetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) return loginRedirect();
        if (!response.ok) throw new Error('Unable to load your Orbit');
        const data = await response.json();
        if (controller.signal.aborted) return;
        // Only fresh numbers answer the game's ask; a failed or abandoned load leaves it for the next one.
        if (endpoint === '/api/admin/bootstrap') wantBootstrap.current = false;
        setFailure(null);
        setBootstrap((current) =>
          endpoint === '/api/admin/bootstrap'
            ? (data as AdminBootstrap)
            : {
                version: 1,
                user: data.user,
                stats: current?.stats ?? { universes: 0, worlds: 0, rooms: 0, users: 0 },
                mine: current?.mine,
                startRoom: current?.startRoom,
              },
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setFailure({ message: cause instanceof Error ? cause.message : 'Unable to load your Orbit', request });
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

  // Orbit's own history this visit: the pages behind (Back) and ahead (Forward), as addresses, each with the section
  // it was lit under. A popstate is read by comparing the new address with both ends, so Back and Forward (the
  // browser's, or ours) keep the stacks right. A page we don't recognise from either end starts a fresh path. Back
  // goes to the page behind when there is one, named after it; otherwise the page's parent takes the current page's
  // place.
  const behind = useRef<HistoryEntry[]>([]);
  const ahead = useRef<HistoryEntry[]>([]);
  const lastPath = useRef(pathname);
  const popping = useRef(false);
  const replacing = useRef(false);
  const [behindTop, setBehindTop] = useState<string | null>(null);
  // The section lit in the rail and menu (Home, Space or You). A universe, world, room or person is reached from more
  // than one, so it keeps the section you came from; Back and Forward return each visit to the section it had.
  const [lastSection, setLastSection] = useState(() => sectionOf(pathname, null));
  const litSection = useRef(lastSection);
  const section = sectionOf(pathname, lastSection);

  useEffect(() => {
    const onPopState = () => {
      popping.current = true;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const previousPath = lastPath.current;
    if (pathname === previousPath) {
      popping.current = false;
      return;
    }
    lastPath.current = pathname;
    // The replace flag belongs to this page: read it now, so a page still settling can't take it.
    const replaced = replacing.current;
    replacing.current = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // The page before is read at settle time: one still settling has taken its section by now.
      const previous: HistoryEntry = { path: previousPath, section: litSection.current };
      let lit: string | null = null;
      if (popping.current) {
        // Several Back or Forward presses can land before one render: walk as many steps as the browser did.
        const back = behind.current.findLastIndex((entry) => entry.path === pathname);
        const forward = ahead.current.findLastIndex((entry) => entry.path === pathname);
        if (back !== -1) {
          const passed = behind.current.splice(back);
          lit = passed.shift()!.section;
          ahead.current.push(previous, ...passed.reverse());
        } else if (forward !== -1) {
          const passed = ahead.current.splice(forward);
          lit = passed.shift()!.section;
          behind.current.push(previous, ...passed.reverse());
        } else {
          behind.current = [];
          ahead.current = [];
        }
      } else if (!replaced) {
        behind.current.push(previous);
        ahead.current = [];
      }
      lit ??= sectionOf(pathname, previous.section);
      litSection.current = lit;
      setLastSection(lit);
      popping.current = false;
      setBehindTop(behind.current[behind.current.length - 1]?.path ?? null);
    };
    if (popping.current || replaced) {
      settle();
      return;
    }
    // Next can render a Back or Forward before the browser's popstate reaches us, in the same task: a page that looks
    // new waits for the end of that task before it counts as one. Another page before then settles this one first.
    const timer = window.setTimeout(settle);
    return () => {
      window.clearTimeout(timer);
      settle();
    };
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
  // A page sends you on in its own place (a saved form, a deleted thing): the history keeps what was behind it.
  const replacePage = useCallback(
    (path: string) => {
      // The same page with another query never reaches the history above, so it must not leave the flag set.
      if (path.split(/[?#]/)[0] !== lastPath.current) replacing.current = true;
      router.replace(path);
    },
    [router],
  );
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
    () => ({ inFrame, view, route, section, goBack, backLabel, replacePage, closeOrbit, menuOpen, setMenuOpen }),
    [inFrame, view, route, section, goBack, backLabel, replacePage, closeOrbit, menuOpen],
  );

  return (
    <OrbitFrameProvider value={frame}>
      <div className="min-h-dvh bg-background" style={{ ['--sidebar-width' as string]: '5.5rem' }}>
        <div className="orbit-orbs" aria-hidden="true">
          <i />
          <i />
        </div>
        <Sidebar />
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
