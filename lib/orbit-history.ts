/**
 * Orbit's steps in the tab's history, for the game (#1556 in the game repository).
 *
 * Inside the game, Orbit's pages share the tab's history with the game: each page Orbit opens adds a step. When Orbit
 * closes without Back, the game walks back over those steps, so they don't stay behind (on an iPhone, any step left
 * behind takes the screen's left edge from the chat's own swipe back). Only Orbit can count them: the game sees none.
 *
 * Each step Orbit adds is marked with its place above the step the game added when Orbit opened (`orbitStep`), so a
 * Back or Forward lands knowing where it is. A page loaded afresh counts from 0, so the number is never more than the
 * real one: too few steps walked back leaves some behind, too many would leave the room.
 */

const STEP_KEY = 'orbitStep';

function stepOf(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const step = (state as Record<string, unknown>)[STEP_KEY];
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : null;
}

/** The state with its step mark. A state that isn't an object (nothing Orbit or Next writes) stays as it is. */
function marked(state: unknown, step: number): unknown {
  if (state === null || state === undefined) return { [STEP_KEY]: step };
  if (typeof state !== 'object' || Array.isArray(state)) return state;
  return { ...(state as Record<string, unknown>), [STEP_KEY]: step };
}

export interface OrbitHistory {
  /** Where this page's step is, above the game's. */
  readonly step: number;
  /** Hears every change of step. Returns the way to stop. */
  subscribe(listener: (step: number) => void): () => void;
}

let installed: (OrbitHistory & { stop(): void }) | null = null;

/**
 * Starts counting, once per page. Steps added before this (none, today: Orbit signs in with replace) count as
 * nothing. Next.js keeps working: it calls the browser's pushState and replaceState through these, whichever patched
 * them first.
 */
export function trackOrbitHistory(win: Window = window): OrbitHistory {
  if (installed) return installed;
  const history = win.history;
  const push = history.pushState;
  const replace = history.replaceState;
  const listeners = new Set<(step: number) => void>();
  let step = stepOf(history.state) ?? 0;

  const set = (next: number) => {
    if (next === step) return;
    step = next;
    listeners.forEach((listener) => listener(step));
  };

  history.pushState = function pushState(this: History, data: unknown, unused: string, url?: string | URL | null) {
    const next = step + 1;
    push.call(this, marked(data, next), unused, url);
    set(next);
  };
  history.replaceState = function replaceState(
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    // A replaced step keeps its place: its own mark, when it has one, even before a popstate for it is heard.
    replace.call(this, marked(data, stepOf(history.state) ?? step), unused, url);
  };
  const onPopState = (event: PopStateEvent) => set(stepOf(event.state) ?? 0);
  win.addEventListener('popstate', onPopState);

  // This page's own step gets its mark too, so coming back to it knows where it is.
  try {
    replace.call(history, marked(history.state, step), '');
  } catch {
    // A browser that refuses: coming back here counts from 0, which is never too many.
  }

  installed = {
    get step() {
      return step;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      history.pushState = push;
      history.replaceState = replace;
      win.removeEventListener('popstate', onPopState);
      listeners.clear();
      installed = null;
    },
  };
  return installed;
}

/** For tests: puts the browser's history back as it was. */
export function stopTrackingOrbitHistory(): void {
  installed?.stop();
}
