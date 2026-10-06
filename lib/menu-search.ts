import { z } from 'zod';
import { authenticatedFetch } from './client-auth';

export type MenuSearchScope = 'all' | 'people' | 'places' | 'tools';
export type SearchKind = 'people' | 'room' | 'world' | 'universe';
export interface MenuSearchItem {
  id: string;
  href: string;
  label: string;
  context: string;
  kind: SearchKind;
}
export interface MenuSearchGroup {
  key: string;
  label: string;
  href: string;
  items: MenuSearchItem[];
  failed: boolean;
}

const entity = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  slug: z.string().optional(),
  description: z.string().nullable().optional(),
  universe: z.object({ name: z.string(), slug: z.string().optional() }).optional(),
  world: z.object({ name: z.string(), universe: z.object({ name: z.string() }) }).optional(),
});

const sources = [
  { key: 'users', label: 'People', kind: 'people', href: '/admin/users' },
  { key: 'rooms', label: 'Rooms', kind: 'room', href: '/admin/discover/rooms' },
  {
    key: 'worlds',
    label: 'Worlds',
    kind: 'world',
    href: '/admin/discover/worlds',
  },
  {
    key: 'universes',
    label: 'Universes',
    kind: 'universe',
    href: '/admin/discover/universes',
  },
] as const;

/** Reuse the directory APIs and their access checks; no separate index or inferred presence/ownership. */
export async function searchMenu(query: string, scope: MenuSearchScope, signal: AbortSignal): Promise<MenuSearchGroup[]> {
  const selected = sources.filter(
    (source) => scope === 'all' || (scope === 'people' && source.kind === 'people') || (scope === 'places' && source.kind !== 'people'),
  );
  return Promise.all(
    selected.map(async (source) => {
      const group: MenuSearchGroup = {
        key: source.key,
        label: source.label,
        href: `${source.href}?q=${encodeURIComponent(query)}`,
        items: [],
        failed: false,
      };
      try {
        const params = new URLSearchParams({
          page: '1',
          limit: '5',
          search: query,
        });
        if (source.kind !== 'people') params.set('scope', 'discover');
        const response = await authenticatedFetch(`/api/admin/${source.key}?${params}`, { signal });
        if (!response.ok) throw new Error('Search unavailable');
        const data = await response.json();
        const rows = z.array(entity).parse(data[source.key]);
        group.items = rows
          .filter((row) => !(source.key === 'worlds' && row.slug === 'default' && row.universe?.slug === 'default'))
          .map((row) => ({
            id: `${source.key}:${row.id}`,
            href: `/admin/${source.key}/${encodeURIComponent(row.id)}`,
            label: row.name || (source.kind === 'people' ? 'Someone' : source.label),
            context:
              source.kind === 'people'
                ? 'View profile'
                : row.world
                ? `${row.world.universe.name} / ${row.world.name}`
                : row.universe?.name || row.description || 'View details',
            kind: source.kind,
          }));
      } catch (error) {
        if (signal.aborted) throw error;
        group.failed = true;
      }
      return group;
    }),
  );
}
