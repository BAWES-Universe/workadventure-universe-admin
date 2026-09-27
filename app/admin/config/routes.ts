/**
 * Every Orbit page, where Back goes from it, and what to call it.
 *
 * Orbit is a stack of pages inside the game's window, so Back must always have somewhere to go: a page's parent is
 * the place it belongs to (a world's page belongs to Spaces; a bot's page to Bots). The three roots, Home, Spaces and
 * You, have no parent: on a root, the last Back closes Orbit and never leaves the room (the game handles that step).
 *
 * `__tests__/admin/routes.test.ts` walks every page in `app/admin` and every route in the workflow inventory and
 * asserts each one reaches a root by following parents. Add a page here when you add one to `app/admin`.
 */

export interface RouteDefinition {
  /** The path pattern, with `[param]` segments. */
  pattern: string;
  /** A short name for the page (the Back button says where it goes; the page keeps its own heading). */
  title: string;
  /** The parent's pattern (its params are filled from the current path), or null for a root. */
  parent: string | null;
}

export const ROUTES: RouteDefinition[] = [
  // The three roots
  { pattern: '/admin', title: 'Home', parent: null },
  { pattern: '/admin/spaces', title: 'Spaces', parent: null },
  { pattern: '/admin/places', title: 'Spaces', parent: '/admin/spaces' },
  { pattern: '/admin/you', title: 'You', parent: null },

  // Spaces: mine
  { pattern: '/admin/universes', title: 'My Universes', parent: '/admin/spaces' },
  { pattern: '/admin/universes/new', title: 'New universe', parent: '/admin/universes' },
  { pattern: '/admin/universes/[id]', title: 'Universe', parent: '/admin/universes' },
  { pattern: '/admin/worlds/new', title: 'New world', parent: '/admin/universes' },
  { pattern: '/admin/worlds/[id]', title: 'World', parent: '/admin/spaces' },
  { pattern: '/admin/rooms/new', title: 'New room', parent: '/admin/spaces' },
  { pattern: '/admin/rooms/[id]', title: 'Room', parent: '/admin/spaces' },
  { pattern: '/admin/stars', title: 'My Stars', parent: '/admin/spaces' },
  { pattern: '/admin/memberships', title: 'My Memberships', parent: '/admin/spaces' },

  // Spaces: explore
  { pattern: '/admin/discover/universes', title: 'Discover Universes', parent: '/admin/spaces' },
  { pattern: '/admin/discover/worlds', title: 'Discover Worlds', parent: '/admin/spaces' },
  { pattern: '/admin/discover/rooms', title: 'Discover Rooms', parent: '/admin/spaces' },
  { pattern: '/admin/users', title: 'Users', parent: '/admin/spaces' },
  { pattern: '/admin/users/[id]', title: 'User', parent: '/admin/users' },
  { pattern: '/admin/templates', title: 'Room Templates', parent: '/admin/spaces' },
  { pattern: '/admin/templates/categories/new', title: 'New category', parent: '/admin/templates' },
  { pattern: '/admin/templates/categories/[id]', title: 'Category', parent: '/admin/templates' },
  { pattern: '/admin/templates/templates/new', title: 'New template', parent: '/admin/templates' },
  { pattern: '/admin/templates/templates/[id]', title: 'Template', parent: '/admin/templates' },
  { pattern: '/admin/templates/maps/new', title: 'New map', parent: '/admin/templates' },
  { pattern: '/admin/templates/maps/[id]', title: 'Map', parent: '/admin/templates' },

  // You
  { pattern: '/admin/profile', title: 'My Visit Card', parent: '/admin/you' },

  // Admin (super admin)
  { pattern: '/admin/avatars', title: 'Avatar Sets', parent: '/admin' },
  { pattern: '/admin/avatars/new', title: 'New avatar set', parent: '/admin/avatars' },
  { pattern: '/admin/avatars/[id]', title: 'Avatar set', parent: '/admin/avatars' },
  { pattern: '/admin/avatars/[id]/layers/[layerId]', title: 'Layer', parent: '/admin/avatars/[id]' },
  { pattern: '/admin/avatars/[id]/companions/[companionId]', title: 'Companion', parent: '/admin/avatars/[id]' },
  { pattern: '/admin/bots', title: 'Bots', parent: '/admin' },
  { pattern: '/admin/bots/conversations', title: 'Conversations', parent: '/admin/bots' },
  { pattern: '/admin/bots/memory', title: 'Memory', parent: '/admin/bots' },
  { pattern: '/admin/bots/metrics', title: 'Metrics', parent: '/admin/bots' },
  { pattern: '/admin/bots/test-results', title: 'Test results', parent: '/admin/bots' },
  { pattern: '/admin/bots/database', title: 'Bot Database', parent: '/admin/bots' },
  { pattern: '/admin/bots/mcp-servers', title: 'MCP Servers', parent: '/admin/bots' },
  { pattern: '/admin/bots/[id]', title: 'Bot', parent: '/admin/bots' },
  { pattern: '/admin/bots/[id]/mcp-servers', title: 'Bot MCP servers', parent: '/admin/bots/[id]' },
  { pattern: '/admin/ai-providers', title: 'AI Providers', parent: '/admin' },
  { pattern: '/admin/ai-providers/new', title: 'New provider', parent: '/admin/ai-providers' },
  { pattern: '/admin/ai-providers/usage', title: 'AI Usage', parent: '/admin/ai-providers' },
  { pattern: '/admin/ai-providers/[id]', title: 'Provider', parent: '/admin/ai-providers' },
  { pattern: '/admin/ai-providers/[id]/edit', title: 'Edit provider', parent: '/admin/ai-providers/[id]' },

  { pattern: '/admin/login', title: 'Sign in', parent: null },
];

export interface ResolvedRoute {
  pattern: string;
  title: string;
  /** Where Back goes: a concrete path, or null on a root. */
  parent: string | null;
  /** The parent's short name, for the Back button. */
  parentTitle: string | null;
  params: Record<string, string>;
  /** Whether this path matched a known page (unknown ones fall back to the nearest known ancestor's parent). */
  known: boolean;
}

function segments(path: string): string[] {
  return path.split('?')[0].split('#')[0].split('/').filter(Boolean);
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = segments(pattern);
  const pathParts = segments(path);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith('[') && expected.endsWith(']')) {
      params[expected.slice(1, -1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function fillPattern(pattern: string, params: Record<string, string>): string {
  return (
    '/' +
    segments(pattern)
      .map((part) => (part.startsWith('[') && part.endsWith(']') ? params[part.slice(1, -1)] ?? part : part))
      .join('/')
  );
}

function definitionFor(path: string): { definition: RouteDefinition; params: Record<string, string> } | null {
  // Static patterns win over parameterised ones (`/admin/bots/database` before `/admin/bots/[id]`).
  const candidates = ROUTES.map((definition) => ({ definition, params: matchPattern(definition.pattern, path) })).filter(
    (candidate): candidate is { definition: RouteDefinition; params: Record<string, string> } => candidate.params !== null,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);
  return candidates[0];
}

/** The page at `pathname`, and where Back goes from it. Unknown paths go back to the nearest known ancestor. */
export function resolveRoute(pathname: string): ResolvedRoute {
  const direct = definitionFor(pathname);
  if (direct) {
    const parent = direct.definition.parent ? fillPattern(direct.definition.parent, direct.params) : null;
    const parentDefinition = direct.definition.parent ? definitionFor(direct.definition.parent) : null;
    return {
      pattern: direct.definition.pattern,
      title: direct.definition.title,
      parent,
      parentTitle: parentDefinition?.definition.title ?? null,
      params: direct.params,
      known: true,
    };
  }
  // Walk up until something is known; that ancestor is the parent.
  const parts = segments(pathname);
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const ancestor = '/' + parts.slice(0, length).join('/');
    const found = definitionFor(ancestor);
    if (found) {
      return {
        pattern: pathname,
        title: found.definition.title,
        parent: ancestor,
        parentTitle: found.definition.title,
        params: found.params,
        known: false,
      };
    }
  }
  return { pattern: pathname, title: 'Orbit', parent: '/admin', parentTitle: 'Home', params: {}, known: false };
}

/** Home, Spaces and You: the pages the bottom bar and the sidebar lead to, with no parent of their own. */
export function isRootRoute(pathname: string): boolean {
  return resolveRoute(pathname).parent === null;
}

/**
 * The chain of parents from `pathname` up to a root (excluding the page itself). Every page must reach a root in a
 * bounded number of steps; the route test relies on this.
 */
export function backPath(pathname: string): string[] {
  const chain: string[] = [];
  let current: string | null = pathname;
  for (let guard = 0; guard < 12 && current !== null; guard += 1) {
    const resolved: ResolvedRoute = resolveRoute(current);
    current = resolved.parent;
    if (current !== null) chain.push(current);
  }
  return chain;
}
