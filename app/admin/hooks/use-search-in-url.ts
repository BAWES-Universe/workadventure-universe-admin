'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * A list's search lives in the address (`?q=`): Space's "See all" carries it over, and Back returns to the same
 * search instead of an empty one.
 */

/** The search the address starts with (read once). */
export function useInitialSearch(): string {
  const params = useSearchParams();
  const [initial] = useState(() => params?.get('q') ?? '');
  return initial;
}

/** Keeps `?q=` in step with the applied search. */
export function useSearchInUrl(query: string): void {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  useEffect(() => {
    const current = params?.get('q') ?? '';
    if (current === query) return;
    const next = new URLSearchParams(params?.toString() ?? '');
    if (query) next.set('q', query);
    else next.delete('q');
    const search = next.toString();
    // Replace, not push: each search is not a page of its own in the history.
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }, [query, params, pathname, router]);
}
