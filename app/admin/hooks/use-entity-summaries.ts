'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetSummary, loadSummary, type EntitySummary, type SummaryKind } from './use-room-analytics';

export type SummaryState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; summary: EntitySummary };

const LOADING: SummaryState = { status: 'loading' };

/**
 * Activity (accesses, peak, last visits) for every universe, world or room in a list.
 *
 * Each id is asked for ONCE: a failure (403, 503, network) becomes `error` for that id and stays so until `retry`
 * is called, so a refusing server never turns into a request loop. The list is keyed by its ids, not by the array's
 * identity, and answers are shared through the analytics cache with every other card showing the same place.
 */
export function useEntitySummaries(kind: SummaryKind, ids: readonly string[]) {
  const key = ids.join('\n');
  const [states, setStates] = useState<Record<string, SummaryState>>({});
  const [nonce, setNonce] = useState(0);
  const attempted = useRef(new Set<string>());
  const mounted = useRef(true);

  // Answers are kept per id, so one that lands after the list changed is still that place's answer (and a place
  // still listed must get it: it is never asked for twice). Only unmounting stops them.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const list = key ? key.split('\n') : [];
    for (const id of list) {
      if (attempted.current.has(`${kind}:${id}`)) continue;
      attempted.current.add(`${kind}:${id}`);
      void loadSummary(kind, id).then((summary) => {
        if (!mounted.current) return;
        setStates((previous) => ({ ...previous, [id]: summary ? { status: 'ready', summary } : { status: 'error' } }));
      });
    }
  }, [kind, key, nonce]);

  /** Ask again for the given ids, or for every id that failed. */
  const retry = useCallback(
    (retryIds?: readonly string[]) => {
      const targets = retryIds ?? Object.keys(states).filter((id) => states[id].status === 'error');
      if (targets.length === 0) return;
      for (const id of targets) {
        attempted.current.delete(`${kind}:${id}`);
        forgetSummary(kind, id);
      }
      setStates((previous) => {
        const next = { ...previous };
        for (const id of targets) next[id] = LOADING;
        return next;
      });
      setNonce((value) => value + 1);
    },
    [kind, states],
  );

  const get = useCallback((id: string): SummaryState => states[id] ?? LOADING, [states]);
  const summary = useCallback((id: string): EntitySummary | undefined => {
    const state = states[id];
    return state?.status === 'ready' ? state.summary : undefined;
  }, [states]);
  const listed = key ? key.split('\n') : [];
  const failed = listed.filter((id) => states[id]?.status === 'error');

  return { get, summary, failed, retry };
}
