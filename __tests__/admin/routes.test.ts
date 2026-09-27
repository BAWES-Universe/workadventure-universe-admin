/**
 * Every Orbit page has a way back. Walks every page under app/admin and every route the workflow inventory names,
 * and follows parents until a root (Home, Spaces, You): each step must be a known page, and the walk must end.
 */
import fs from 'fs';
import path from 'path';
import { ROUTES, backPath, isRootRoute, resolveRoute } from '@/app/admin/config/routes';
import { DESTINATIONS, NAV_ITEMS } from '@/app/admin/config/navigation';

const ADMIN_DIR = path.join(process.cwd(), 'app', 'admin');
const INVENTORY = path.join(process.cwd(), 'docs', 'orbit-workflow-inventory.md');

function pagesUnder(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      routes.push(...pagesUnder(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      routes.push(prefix || '/');
    }
  }
  return routes;
}

/** `[id]` becomes a concrete value, so patterns become paths a person could be on. */
function samplePath(pattern: string): string {
  return pattern.replace(/\[([^\]]+)\]/g, (_, name: string) => `${name}-1`);
}

/** The inventory writes `/admin/bots/{a,b}` and `/admin/x/*`: expand the first, skip the second. */
function inventoryRoutes(): string[] {
  const text = fs.readFileSync(INVENTORY, 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/`(\/admin[^`]*)`/g)) {
    // `/admin/x/*` stands for x's pages, each of which the inventory also names on its own.
    if (match[1].endsWith('/*')) continue;
    const raw = match[1];
    const brace = raw.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (brace) {
      for (const option of brace[2].split(',')) found.add(`${brace[1]}${option.trim()}${brace[3]}`);
    } else {
      found.add(raw);
    }
  }
  return [...found];
}

describe('every Orbit page has a back path', () => {
  const pages = pagesUnder(ADMIN_DIR, '/admin').filter((route) => route !== '/admin/login');

  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThan(30);
    expect(pages).toContain('/admin');
    expect(pages).toContain('/admin/bots/[id]/mcp-servers');
  });

  it.each(pages)('%s reaches a root through known pages', (pattern) => {
    const route = resolveRoute(samplePath(pattern));
    expect(route.known).toBe(true);
    const chain = backPath(samplePath(pattern));
    if (route.parent === null) {
      expect(chain).toEqual([]);
      return;
    }
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThan(8);
    for (const step of chain) expect(resolveRoute(step).known).toBe(true);
    expect(isRootRoute(chain[chain.length - 1])).toBe(true);
  });

  it.each(inventoryRoutes().filter((route) => route !== '/admin/login'))('inventory route %s is a known page', (pattern) => {
    expect(resolveRoute(samplePath(pattern)).known).toBe(true);
  });

  it('every route definition names a parent that exists', () => {
    for (const definition of ROUTES) {
      if (definition.parent === null) continue;
      expect(ROUTES.some((candidate) => candidate.pattern === definition.parent)).toBe(true);
    }
  });

  it('the roots are exactly the three destinations', () => {
    const roots = ROUTES.filter((definition) => definition.parent === null && definition.pattern !== '/admin/login').map(
      (definition) => definition.pattern,
    );
    expect(roots.sort()).toEqual(DESTINATIONS.map((item) => item.href).sort());
  });

  it('every menu entry is a known page', () => {
    for (const item of NAV_ITEMS) expect(resolveRoute(item.href).known).toBe(true);
  });

  it('fills a parent from the page it comes from', () => {
    expect(resolveRoute('/admin/avatars/set-9/layers/layer-3').parent).toBe('/admin/avatars/set-9');
    expect(resolveRoute('/admin/bots/bot-2/mcp-servers').parent).toBe('/admin/bots/bot-2');
    expect(resolveRoute('/admin/bots/database').parent).toBe('/admin/bots');
    expect(resolveRoute('/admin/worlds/w-1').parentTitle).toBe('Spaces');
  });

  it('sends an unknown page back to its nearest known ancestor', () => {
    expect(resolveRoute('/admin/bots/bot-2/something-new').parent).toBe('/admin/bots/bot-2');
    expect(resolveRoute('/admin/nowhere').parent).toBe('/admin');
  });
});
