/**
 * Where Orbit was, so that Orbit opened again right after the game reconnected (the phone came back to the app) can
 * land on the same page instead of home. Kept in this tab's sessionStorage, which outlives the frame being rebuilt, and
 * dropped with everything else per account when the account changes (see purgeAccountState).
 */
export const RESUME_PATH_KEY = 'orbit_resume_path';

/** An Orbit page worth coming back to: one of Orbit's own /admin pages, never the sign-in page itself. */
export function isResumablePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/admin')) return false;
  try {
    const target = new URL(value, 'http://orbit.invalid');
    if (target.origin !== 'http://orbit.invalid') return false;
    if (target.pathname === '/admin/login' || target.pathname.startsWith('/admin/login/')) return false;
    return target.pathname === '/admin' || target.pathname.startsWith('/admin/');
  } catch {
    return false;
  }
}

export function rememberResumePath(path: string): void {
  if (typeof window === 'undefined' || !isResumablePath(path)) return;
  try {
    window.sessionStorage.setItem(RESUME_PATH_KEY, path);
  } catch {
    // Storage blocked: Orbit then opens on its home page after a reconnect.
  }
}

export function readResumePath(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(RESUME_PATH_KEY);
    return isResumablePath(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The Orbit page to land on after signing in: the `redirect` the address asks for, else, when the game opens Orbit
 * again after a reconnect (`resume=1`), the page Orbit was on, else home. Only Orbit's own /admin pages are followed.
 */
export function loginDestination(href: string, resumePath: string | null): string {
  const url = new URL(href);
  const requested = url.searchParams.get('redirect') ?? (url.searchParams.get('resume') === '1' ? resumePath : null);
  if (!requested) return '/admin';
  const target = new URL(requested, url.origin);
  if (target.origin !== url.origin || (target.pathname !== '/admin' && !target.pathname.startsWith('/admin/'))) return '/admin';
  return `${target.pathname}${target.search}${target.hash}`;
}
