'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { KindIcon } from '../../components/ds';
import { SearchBox } from '../../discover/discover-ui';

export type PlaceType = 'universe' | 'world';

interface Place {
  id: string;
  name: string;
  slug: string;
  universe?: { name: string } | null;
}

/**
 * Find a universe or world by name. Searches yours and the public ones (what the list endpoints offer); anything
 * else can still be added by its ID under Advanced.
 */
export function PlaceSearch({
  type,
  value,
  onPick,
}: {
  type: PlaceType;
  value: string;
  onPick: (id: string) => void;
}) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    setResults([]);
    setStatus('idle');
  }, [type]);

  useEffect(() => {
    if (!query) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    const path = type === 'universe' ? 'universes' : 'worlds';
    (async () => {
      setStatus('loading');
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const search = encodeURIComponent(query);
        const responses = await Promise.all(
          ['my', 'discover'].map((scope) =>
            authenticatedFetch(`/api/admin/${path}?scope=${scope}&limit=20&search=${search}`, { signal: controller.signal }),
          ),
        );
        if (responses.every((response) => !response.ok)) throw new Error('Search failed');
        const found = new Map<string, Place>();
        for (const response of responses) {
          if (!response.ok) continue;
          const data = await response.json();
          for (const place of (data[path] ?? []) as Place[]) found.set(place.id, place);
        }
        setResults([...found.values()]);
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [query, type]);

  return (
    <div className="grid min-w-0 gap-2">
      <SearchBox
        value={input}
        onChange={setInput}
        onSubmit={() => setQuery(input.trim())}
        onClear={() => setInput('')}
        label={`Search ${type}s by name`}
        placeholder={`Search ${type}s by name`}
      />
      {status === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Searching…
        </p>
      )}
      {status === 'error' && <p className="text-xs text-muted-foreground">The search didn’t work. Try again, or use the ID under Advanced.</p>}
      {status === 'ready' && results.length === 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          No {type} matches “{query}”.
        </p>
      )}
      {results.length > 0 && (
        <ul className="grid max-h-64 min-w-0 gap-1 overflow-y-auto">
          {results.map((place) => {
            const picked = place.id === value;
            return (
              <li key={place.id}>
                <button
                  type="button"
                  onClick={() => onPick(place.id)}
                  aria-pressed={picked}
                  className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border border-border px-3 py-2 text-left text-sm transition-colors hover:border-foreground/25 aria-pressed:border-foreground/40 aria-pressed:bg-accent/60"
                >
                  <KindIcon kind={type} size="sm" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="block font-medium">{place.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {place.universe?.name ? `In ${place.universe.name} · ` : ''}
                      {place.slug}
                    </span>
                  </span>
                  {picked && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const nameCache = new Map<string, string | null>();

/** A scope's universe or world by name, once it's known; its ID until then (or if it can't be read). */
export function PlaceName({ type, id }: { type: string; id: string }) {
  const key = `${type}:${id}`;
  const [name, setName] = useState<string | null>(nameCache.get(key) ?? null);

  useEffect(() => {
    if (!id || (type !== 'universe' && type !== 'world') || nameCache.has(key)) return;
    let cancelled = false;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/${type === 'universe' ? 'universes' : 'worlds'}/${id}`);
        const data = response.ok ? await response.json() : null;
        const found = typeof data?.name === 'string' ? data.name : null;
        nameCache.set(key, found);
        if (!cancelled) setName(found);
      } catch {
        // The ID stays shown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, id, type]);

  return <>{name ?? id}</>;
}
