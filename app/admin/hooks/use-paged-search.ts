'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type PagedResult<R> =
  | { status: 'idle' }
  | { status: 'loading'; data: R | null }
  | { status: 'ready'; data: R }
  | { status: 'error'; data: R | null };

/**
 * A searchable, paged list: `{query, page}` is the state, and each change of it runs ONE request (abortable; an answer
 * for an older `{query, page}` never lands). A new query always starts on page 1, set together with the query so the
 * two never race. `load` may return `null` to say "ignore this" (e.g. it is redirecting to sign in).
 *
 * `debounceMs` makes typing search as you type: `setInput` updates the field at once and applies the query after the
 * pause; `submit` applies it now.
 */
export function usePagedSearch<R>(
  load: (params: { query: string; page: number }, signal: AbortSignal) => Promise<R | null>,
  { enabled = true, debounceMs }: { enabled?: boolean; debounceMs?: number } = {},
) {
  const [input, setInputState] = useState('');
  const [params, setParams] = useState({ query: '', page: 1 });
  const [attempt, setAttempt] = useState(0);
  // The last settled answer, and which {query, page, attempt} it answered: anything else is still loading.
  const [settled, setSettled] = useState<{
    params: { query: string; page: number };
    attempt: number;
    ok: boolean;
    data: R | null;
  } | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const applyQuery = useCallback((raw: string) => {
    const query = raw.trim();
    setParams((current) => (current.query === query && current.page === 1 ? current : { query, page: 1 }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    loadRef
      .current(params, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || data === null) return;
        setSettled({ params, attempt, ok: true, data });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // A failure keeps the last good list on screen, under the error.
        setSettled((current) => ({ params, attempt, ok: false, data: current?.data ?? null }));
      });
    return () => controller.abort();
  }, [enabled, params, attempt]);

  const current = settled !== null && settled.params === params && settled.attempt === attempt;
  const result: PagedResult<R> = !enabled && settled === null
    ? { status: 'idle' }
    : !current
      ? { status: 'loading', data: settled?.data ?? null }
      : settled.ok
        ? { status: 'ready', data: settled.data as R }
        : { status: 'error', data: settled.data };

  // Search as you type: apply what was typed once typing pauses.
  useEffect(() => {
    if (debounceMs === undefined) return;
    const timer = setTimeout(() => applyQuery(input), debounceMs);
    return () => clearTimeout(timer);
  }, [input, debounceMs, applyQuery]);

  const setPage = useCallback((page: number) => {
    setParams((current) => (current.page === page ? current : { ...current, page }));
  }, []);

  return {
    input,
    setInput: setInputState,
    query: params.query,
    page: params.page,
    setPage,
    /** Apply the typed query now (Enter). */
    submit: useCallback(() => applyQuery(input), [applyQuery, input]),
    /** Empty the field and the applied query at once. */
    clear: useCallback(() => {
      setInputState('');
      applyQuery('');
    }, [applyQuery]),
    retry: useCallback(() => setAttempt((value) => value + 1), []),
    result,
    loading: result.status === 'loading' || result.status === 'idle',
    error: result.status === 'error',
    data: result.status === 'idle' ? null : result.data,
  };
}
