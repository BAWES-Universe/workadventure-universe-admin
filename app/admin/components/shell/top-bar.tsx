'use client';

import { ChevronLeft, Menu, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrbitFrame } from '../../orbit-frame-context';
import { ShortcutHint } from './shortcut-hint';

/**
 * The bar at the top of every page, at the frame's top-left beside the game's own close and maximise buttons.
 * On Orbit, Space and You it is the "Orbit Menu" button; on every other page it is Back alone, named after where it
 * goes. The page carries its own heading, so the bar doesn't repeat it. The game's maximise button changes the view; Orbit
 * has none of its own. In the full-screen view the game's buttons sit over Orbit's top-right corner, so the bar
 * leaves that corner free.
 */
export function TopBar({ isSuperAdmin = false }: { isSuperAdmin?: boolean }) {
  const { route, goBack, inFrame, view, menuOpen, setMenuOpen } = useOrbitFrame();
  const isRoot = route.parent === null;
  const full = view === 'full';

  return (
    <header
      className={cn('orbit-glass sticky top-0 z-40 border-b border-border/60', inFrame && full && 'orbit-reserve-game-controls')}
      style={{ height: 'var(--topbar-height)' }}
    >
      <div className="@container/bar relative flex h-full items-center gap-2 px-2 sm:px-3">
        {isRoot ? (
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="orbit-menu"
            aria-keyshortcuts="Control+K Meta+K"
            className="orbit-press inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-foreground/15 pl-3 pr-3.5 text-sm font-semibold transition-colors hover:border-foreground/30 hover:bg-foreground/5 lg:hidden"
            data-testid="orbit-menu-button"
          >
            <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
            Orbit Menu
            <ShortcutHint className="ml-1" />
          </button>
        ) : (
          <button
            type="button"
            onClick={goBack}
            className="orbit-press inline-flex h-10 min-w-0 max-w-full shrink items-center gap-0.5 rounded-full border border-foreground/15 pl-1.5 pr-4 text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5"
            data-testid="orbit-back"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" strokeWidth={2.75} aria-hidden="true" />
            <span className="truncate text-[15px] font-bold">{route.parentTitle ?? 'Back'}</span>
          </button>
        )}

        {isSuperAdmin && (
          // You see admin tools other people don't; kept clear of the game's own buttons in the full-screen view.
          <span
            className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-primary/35 bg-primary/10 px-2 text-[11px] font-semibold text-primary @[22rem]/bar:px-2.5"
            title="Super admin"
            data-testid="super-admin-badge"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {/* On the narrowest bars the shield alone, so it never pushes the menu. */}
            <span className="sr-only @[22rem]/bar:not-sr-only">Super admin</span>
          </span>
        )}
      </div>
    </header>
  );
}
