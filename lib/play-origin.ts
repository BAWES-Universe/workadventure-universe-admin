/** The game's address, the only window Orbit talks to (sign-in handshake and bridge). */
export const PLAY_URL =
  process.env.NEXT_PUBLIC_PLAY_URL ||
  (process.env.NODE_ENV !== 'production'
    ? 'http://play.workadventure.localhost'
    : (() => {
        throw new Error('NEXT_PUBLIC_PLAY_URL is required in production');
      })());

export const PLAY_ORIGIN = new URL(PLAY_URL).origin;

export function isInsideFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
