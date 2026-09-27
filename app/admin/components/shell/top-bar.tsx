'use client';

import { ChevronLeft, SlidersHorizontal } from 'lucide-react';
import { useOrbitFrame } from '../../orbit-frame-context';
import { OrbitWordmark } from './orbit-mark';

/** Space for the game's top-right buttons is reserved only when it confirms full view. */
export function TopBar() {
  const { route, goBack, inFrame, view, menuOpen, setMenuOpen } = useOrbitFrame();
  const isRoot = route.parent === null;
  return (
    <header className={`observatory-header ${inFrame ? 'observatory-in-frame' : ''} ${inFrame && view === 'full' ? 'observatory-host-full' : ''}`}>
      <div className="observatory-header-context">
        {isRoot ? <OrbitWordmark /> : (
          <>
            <button type="button" onClick={goBack} className="observatory-icon-button" aria-label="Back" title={`Back · ${route.parentTitle ?? 'Home'}`} data-testid="orbit-back">
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <div className="observatory-route-name">
              <span className="observatory-eyebrow">Orbit / {route.parentTitle}</span>
              <h1 data-testid="orbit-title">{route.title}</h1>
            </div>
          </>
        )}
        {isRoot && <span className="observatory-header-caption">Your Universe, within reach.</span>}
      </div>
      <button type="button" className="observatory-menu-trigger" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open Orbit menu" aria-expanded={menuOpen} aria-controls="orbit-menu">
        <SlidersHorizontal size={17} aria-hidden="true" /><span>Menu</span>
      </button>
    </header>
  );
}
