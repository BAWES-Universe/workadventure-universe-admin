import { resolveRoute } from '../../config/routes';

/** Which of Home, Space and You a page belongs to: the root its Back path ends on. */
export function rootOf(pathname: string): string {
  let current = pathname;
  for (let guard = 0; guard < 12; guard += 1) {
    const route = resolveRoute(current);
    if (route.parent === null) return current;
    current = route.parent;
  }
  return '/admin';
}
