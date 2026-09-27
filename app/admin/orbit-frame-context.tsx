'use client';

import { createContext, useContext } from 'react';
import type { OrbitView } from '@/lib/orbit-bridge';
import type { ResolvedRoute } from './config/routes';

/**
 * What the shell knows about Orbit's window and the page it shows, for the bars and the pages that need it.
 */
export interface OrbitFrameState {
  /** Inside the game's frame (false in a plain development tab). */
  inFrame: boolean;
  /** The frame's size right now. */
  view: OrbitView;
  /** Ask the game for the other size. */
  requestView: (view: OrbitView) => void;
  /** The page shown, and where Back goes from it. */
  route: ResolvedRoute;
  /** Back: the previous Orbit page when there is one, else the page's parent. */
  goBack: () => void;
  /** Close Orbit (through the game's own API). */
  closeOrbit: () => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

const OrbitFrameContext = createContext<OrbitFrameState | null>(null);

export function OrbitFrameProvider({ value, children }: { value: OrbitFrameState; children: React.ReactNode }) {
  return <OrbitFrameContext.Provider value={value}>{children}</OrbitFrameContext.Provider>;
}

export function useOrbitFrame(): OrbitFrameState {
  const value = useContext(OrbitFrameContext);
  if (!value) throw new Error('useOrbitFrame must be used inside OrbitFrameProvider');
  return value;
}
