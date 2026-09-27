'use client';

import { ChevronLeft, Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrbitFrame } from '../../orbit-frame-context';
import { OrbitWordmark } from './orbit-mark';

/**
 * The bar at the top of every page. On a narrow frame it starts with the Menu, at the frame's top-left corner, next
 * to the game's own close and maximise buttons. Then the wordmark on a root page, or Back (named after where it goes)
 * and the page's short name. The game's maximise button changes the view; Orbit has none of its own. In the
 * full-screen view the game's buttons sit over Orbit's top-right corner, so the bar leaves that corner free.
 */
export function TopBar() {
  const { route, goBack, inFrame, view, menuOpen, setMenuOpen } = useOrbitFrame();
  const isRoot = route.parent === null;
  const full = view === 'full';

  return (
    <header
      className={cn('orbit-glass sticky top-0 z-40 border-b border-border/60', inFrame && full && 'orbit-reserve-game-controls')}
      style={{ height: 'var(--topbar-height)' }}
    >
      <div className="@container/bar relative flex h-full items-center gap-1 px-2 sm:px-3">
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-controls="orbit-menu"
          aria-label="Menu"
          title="Menu"
          className="orbit-press inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-foreground transition-colors hover:bg-accent lg:hidden"
          data-testid="orbit-menu-button"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        {isRoot ? (
          <div className="flex h-10 items-center px-1 lg:hidden">
            <OrbitWordmark />
          </div>
        ) : (
          <button
            type="button"
            onClick={goBack}
            className="orbit-press inline-flex h-10 min-w-0 max-w-full shrink items-center gap-0.5 rounded-xl pl-1 pr-3 text-primary transition-colors hover:bg-accent @[26rem]/bar:max-w-[45%]"
            data-testid="orbit-back"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate text-[15px] font-medium">{route.parentTitle ?? 'Back'}</span>
          </button>
        )}

        {!isRoot && (
          // The page carries its own heading; this is the bar's short name for it, shown when the bar has room beside
          // Back (never over it).
          <p
            className="hidden min-w-0 flex-1 truncate pr-2 text-center text-[15px] font-semibold @[26rem]/bar:block lg:pr-12"
            data-testid="orbit-title"
          >
            {route.title}
          </p>
        )}
        {isRoot && (
          <p className="hidden text-[15px] font-semibold lg:block" data-testid="orbit-title">
            {route.title}
          </p>
        )}
      </div>
    </header>
  );
}
