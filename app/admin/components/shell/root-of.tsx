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

/**
 * Pages you reach from more than one of Home, Space and You: a universe, world, room or person, and the forms that
 * make one. They stay under the section you opened them from (a universe opened in Space keeps Space lit, the same one
 * opened from Your universes keeps You lit). Opened first thing, with nothing before, each takes the section of
 * the page given here: a universe, world, room or person sits under Space (the places and people out there), a
 * new universe or world under You (making your own), and a new room under Space (it follows its world).
 */
const SHARED: Record<string, string> = {
  '/admin/universes/[id]': '/admin/space',
  '/admin/worlds/[id]': '/admin/space',
  '/admin/rooms/[id]': '/admin/space',
  '/admin/users/[id]': '/admin/space',
  '/admin/universes/new': '/admin/universes',
  '/admin/worlds/new': '/admin/universes',
  '/admin/rooms/new': '/admin/space',
};

/**
 * The section (Home, Space or You) lit for a page: its own root, or for a shared page the section you came from.
 * `previous` is the section lit before this page, or null when it is the first page of the visit.
 */
export function sectionOf(pathname: string, previous: string | null): string {
  const route = resolveRoute(pathname);
  const fallback = SHARED[route.pattern];
  if (fallback === undefined) return rootOf(pathname);
  return previous ?? rootOf(fallback);
}
