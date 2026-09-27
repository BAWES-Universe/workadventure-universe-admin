'use client';

import { useEffect, useRef } from 'react';
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
  const restored = useRef(false);
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  useEffect(() => {
    if (!enabled || restored.current) return;
    restored.current = true;
    const draft = readDraft<T>(key);
    if (draft && draftDiffers(draft, empty)) setValueRef.current({ ...value, ...draft });
    // Restore once, on mount, with the key given then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !restored.current) return;
    if (draftDiffers(value, empty)) writeDraft(key, value);
    else clearDraft(key);
  }, [enabled, key, value, empty]);

  return {
    discard: () => {
      clearDraft(key);
    },
  };
}
