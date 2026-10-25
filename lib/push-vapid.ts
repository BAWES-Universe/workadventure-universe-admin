/**
 * The server's Web Push key pair (game #863). The public half is what a browser subscribes with; the private half signs
 * every notification Orbit sends. Without VAPID_PUBLIC_KEY notifications are simply not offered.
 */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{86,88}$/;

export function vapidPublicKey(): string | null {
  const key = process.env.VAPID_PUBLIC_KEY?.trim();
  return key && PUBLIC_KEY.test(key) ? key : null;
}
