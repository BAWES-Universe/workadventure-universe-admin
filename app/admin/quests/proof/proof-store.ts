'use client';

import { useState, useSyncExternalStore } from 'react';
import { PROOF_STORAGE_KEY, newProofDocument, readProofDocument, type ProofDocument } from './proof-model';

interface ProofSnapshot {
  document: ProofDocument;
  saved: boolean;
}

/** A tab-local design document. The server snapshot is stable; storage is read after hydration by React. */
function createProofStore() {
  const initial: ProofSnapshot = { document: newProofDocument(), saved: true };
  let snapshot = initial;
  let loaded = false;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    if (!loaded && typeof window !== 'undefined') {
      loaded = true;
      try {
        const stored = readProofDocument(sessionStorage.getItem(PROOF_STORAGE_KEY));
        if (stored) snapshot = { document: stored, saved: true };
      } catch {
        snapshot = { ...snapshot, saved: false };
      }
    }
    return snapshot;
  };
  return {
    getSnapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDocument: (update: (current: ProofDocument) => ProofDocument) => {
      const document = update(getSnapshot().document);
      let saved = true;
      try {
        sessionStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(document));
      } catch {
        saved = false;
      }
      snapshot = { document, saved };
      listeners.forEach((listener) => listener());
    },
  };
}

export function useProofDocument() {
  const [store] = useState(createProofStore);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { ...snapshot, setDocument: store.setDocument };
}
