'use client';

import { useEffect, useRef, useState } from 'react';
import { clearDraft, draftDiffers, readDraft, writeDraft } from '@/lib/drafts';

/**
 * Keeps a form's state as a draft that survives navigation (see lib/drafts.ts).
 *
 * On the first render it restores a saved draft, if there is one, and says so (`restored`) so the form can tell the
 * person and offer `revert`. From then on every change is saved. Call `discard` once the form has been submitted, so
 * the next visit starts clean.
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
  const done = useRef(false);
  const [restored, setRestored] = useState(false);
  // Through refs, so the one-time restore doesn't depend on (or re-run for) new setter identities.
  const setters = useRef({ setValue, setRestored });
  setters.current = { setValue, setRestored };

  useEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    const draft = readDraft<T>(key);
    if (draft && draftDiffers(draft, empty)) {
      setters.current.setValue({ ...value, ...draft });
      setters.current.setRestored(true);
    }
    // Restore once, on mount, with the key given then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !done.current) return;
    if (draftDiffers(value, empty)) writeDraft(key, value);
    else clearDraft(key);
  }, [enabled, key, value, empty]);

  return {
    discard: () => {
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
