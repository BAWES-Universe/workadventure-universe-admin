'use client';

import { ChevronLeft, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrbitFrame } from '../../orbit-frame-context';
import { OrbitWordmark } from './orbit-mark';

/**
 * The bar at the top of every page. On a root it carries the wordmark; everywhere else, Back (named after where it
 * goes) and the page's short name. The view toggle lives on the right, with room left for the game's own controls,
 * which sit over Orbit's corner in the full-screen view.
 */
export function TopBar() {
  const { route, goBack, inFrame, view, requestView } = useOrbitFrame();
  const isRoot = route.parent === null;
  const full = view === 'full';

  return (
    <header
      className={cn(
        'orbit-glass sticky top-0 z-40 border-b border-border/60',
        inFrame && full && 'orbit-reserve-game-controls',
      )}
      style={{ height: 'var(--topbar-height)' }}
    >
      <div className="relative flex h-full items-center gap-1 px-2 sm:px-3">
        {isRoot ? (
          <div className="flex h-10 items-center px-2 lg:hidden">
            <OrbitWordmark />
          </div>
        ) : (
          <button
            type="button"
            onClick={goBack}
            className="orbit-press inline-flex h-10 max-w-[45%] items-center gap-0.5 rounded-xl pl-1 pr-3 text-primary transition-colors hover:bg-accent"
            data-testid="orbit-back"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate text-[15px] font-medium">{route.parentTitle ?? 'Back'}</span>
          </button>
        )}

        {!isRoot && (
          <h1
            className="pointer-events-none absolute left-1/2 max-w-[50%] -translate-x-1/2 truncate text-[15px] font-semibold"
            data-testid="orbit-title"
          >
            {route.title}
          </h1>
        )}
        {isRoot && (
          <h1 className="hidden text-[15px] font-semibold lg:block" data-testid="orbit-title">
            {route.title}
          </h1>
        )}

        <div className="ml-auto flex items-center gap-1">
          {inFrame && (
            <button
              type="button"
              onClick={() => requestView(full ? 'compact' : 'full')}
              aria-label={full ? 'Back to the compact view' : 'Open in full screen'}
              title={full ? 'Compact view' : 'Full screen'}
              className="orbit-press inline-flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              data-testid="orbit-view-toggle"
            >
              {full ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
