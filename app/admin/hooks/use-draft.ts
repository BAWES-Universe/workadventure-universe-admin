'use client';

import { useEffect, useRef, useState } from 'react';
import { clearDraft, draftDiffers, readDraft, writeDraft } from '@/lib/drafts';

/**
 * Keeps a form's state as a draft that survives navigation (see lib/drafts.ts).
 *
 * On the first render (and again whenever the key changes, i.e. the form now belongs to another parent) it restores
 * a saved draft, if there is one, and says so (`restored`) so the form can tell the person and offer `revert`. From
 * then on every change is saved. Call `discard` once the form has been submitted: the draft goes, and it isn't
 * recreated until the person edits again.
 *
 * `empty` is the form's starting state (blank for a new item, the saved values for an edit): a draft equal to it is
 * not kept, and `revert` goes back to it.
 */
export function useDraft<T extends object>(
  key: string,
  value: T,
  setValue: (value: T) => void,
  empty: T,
  enabled = true,
): { discard: () => void; restored: boolean; revert: () => void } {
  const restoredFor = useRef<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const discarded = useRef<{ key: string; value: string } | null>(null);
  // Through refs, so the one-time restore doesn't depend on (or re-run for) new setter identities.
  const setters = useRef({ setValue, setRestored });
  setters.current = { setValue, setRestored };

  useEffect(() => {
    if (!enabled || restoredFor.current === key) return;
    const changedScope = restoredFor.current !== null;
    restoredFor.current = key;
    discarded.current = null;
    const draft = readDraft<T>(key);
    if (draft && draftDiffers(draft, empty)) {
      setters.current.setValue({ ...(changedScope ? empty : value), ...draft });
      setters.current.setRestored(true);
    } else {
      if (changedScope) setters.current.setValue(empty);
      setters.current.setRestored(false);
    }
    // Save only once the restored value has rendered; otherwise the old form would overwrite the new scope's draft.
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
      // A save can change the server baseline before the form unmounts: don't recreate its draft until edited again.
      discarded.current = { key, value: JSON.stringify(value) };
      clearDraft(key);
      setRestored(false);
    },
    restored,
    revert: () => {
      clearDraft(key);
      setRestored(false);
      setValue({ ...value, ...empty });
    },
  };
}
