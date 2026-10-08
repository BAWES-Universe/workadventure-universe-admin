'use client';

import { createContext, useCallback, useContext } from 'react';
import { useRouter } from 'next/navigation';
import type { OrbitView } from '@/lib/orbit-bridge';
import type { ResolvedRoute } from './config/routes';

/**
 * What the shell knows about Orbit's window and the page it shows, for the bars and the pages that need it.
 */
export interface OrbitFrameState {
  /** Inside the game's frame (false in a plain development tab). */
  inFrame: boolean;
  /** The frame's size right now (the game's own maximise button changes it). */
  view: OrbitView;
  /** The page shown, and where Back goes from it. */
  route: ResolvedRoute;
  /** The section lit in the rail and menu: `/admin`, `/admin/space` or `/admin/you`. */
  section: string;
  /** Back: the previous Orbit page when there is one, else the page's parent. */
  goBack: () => void;
  /** Where Back goes, by name: the page behind, or the page's parent. */
  backLabel: string | null;
  /** Show another page in this page's place: Back then skips this one (a finished form, a deleted thing, a page you may not see). */
  replacePage: (path: string) => void;
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

/**
 * Leave this page for another in its place, so Back never returns to it: after a form is saved, a thing is deleted, or
 * a page turns out not to be yours to see. Outside the shell (a test), a plain replace.
 */
export function useReplacePage(): (path: string) => void {
  const frame = useContext(OrbitFrameContext);
  const router = useRouter();
  const replacePage = frame?.replacePage;
  return useCallback((path: string) => (replacePage ? replacePage(path) : router.replace(path)), [replacePage, router]);
}
