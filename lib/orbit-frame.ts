/**
 * Orbit's window inside the game: whether it is one, and how it talks to the game.
 *
 * Orbit always runs inside the game's modal frame. That frame has two sizes, which this file calls views: the
 * compact companion panel (the default) and the full-screen view for bigger tasks. The game owns the size; Orbit
 * asks for a change over the bridge (`orbit-view-request`) and hears about changes back (`orbit-view`).
 */
import { PLAY_ORIGIN, isInsideFrame } from '@/lib/play-origin';
import { ORBIT_BRIDGE_VERSION, type OrbitView, type OrbitViewRequest } from '@/lib/orbit-bridge';

export { isInsideFrame };

/** Send a message to the game, and only the game. A no-op outside the frame (development in a plain tab). */
export function postToGame(message: object): void {
  if (typeof window === 'undefined' || !isInsideFrame()) return;
  window.parent.postMessage(message, PLAY_ORIGIN);
}

/** Ask the game for the compact or the full-screen view. */
export function requestView(view: OrbitView): void {
  const message: OrbitViewRequest = { type: 'orbit-view-request', version: ORBIT_BRIDGE_VERSION, view };
  postToGame(message);
}
