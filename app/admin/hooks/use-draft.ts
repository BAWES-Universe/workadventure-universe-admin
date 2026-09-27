'use client';

import { useEffect, useRef, useState } from 'react';
import { clearDraft, draftDiffers, readDraft, writeDraft } from '@/lib/drafts';

/**
 * Keeps a form's state as a draft that survives navigation (see lib/drafts.ts).
 *
 * On the first render it restores a saved draft, if there is one. From then on every change is saved. Call the
 * returned `discard` once the form has been submitted, so the next visit starts clean.
 *
 * `empty` is the form's blank state: a draft equal to it is not saved, and restoring never overwrites what the page
 * already filled in with something blank.
 */
export function useDraft<T extends object>(
  key: string,
  value: T,
  setValue: (value: T) => void,
  empty: T,
  enabled = true,
): { discard: () => void } {
  const restored = useRef<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const discarded = useRef<{ key: string; value: string } | null>(null);
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  useEffect(() => {
    if (!enabled || restored.current === key) return;
    const changedScope = restored.current !== null;
    restored.current = key;
    discarded.current = null;
    const draft = readDraft<T>(key);
    if (draft && draftDiffers(draft, empty)) setValueRef.current({ ...(changedScope ? empty : value), ...draft });
    else if (changedScope) setValueRef.current(empty);
    // Persist only after the restored value has reached the next render. Otherwise the old form can overwrite a
    // new scope's draft during this effect pass.
    setReadyKey(key);
    // Restore once per scope, after the form has loaded any server values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || readyKey !== key) return;
    if (discarded.current?.key === key && discarded.current.value === JSON.stringify(value)) return;
    discarded.current = null;
    if (draftDiffers(value, empty)) writeDraft(key, value);
    else clearDraft(key);
  }, [enabled, key, readyKey, value, empty]);

  return {
    discard: () => {
      // A successful save can change the server baseline before the form unmounts. Do not recreate its draft
      // until the person actually edits again.
      discarded.current = { key, value: JSON.stringify(value) };
      clearDraft(key);
    },
  };
}
