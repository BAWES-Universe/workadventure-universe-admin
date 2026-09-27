/**
 * Orbit's window inside the game: whether it is one, and how it talks to the game.
 *
 * Orbit always runs inside the game's modal frame. The game owns its size (its own maximise button, under the close
 * button) and tells Orbit which view it is in (`orbit-view`), so Orbit can lay itself out.
 */
import { PLAY_ORIGIN, isInsideFrame } from '@/lib/play-origin';

export { isInsideFrame };

/** Send a message to the game, and only the game. A no-op outside the frame (development in a plain tab). */
export function postToGame(message: object): void {
  if (typeof window === 'undefined' || !isInsideFrame()) return;
  window.parent.postMessage(message, PLAY_ORIGIN);
}
