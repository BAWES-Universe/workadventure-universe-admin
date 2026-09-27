/**
 * Drafts survive navigation. A form keeps what the person typed in this tab's sessionStorage, so leaving the page
 * (Back, Escape, a tap elsewhere) never loses it and never asks "are you sure?". The draft is cleared when the form
 * is submitted, and with everything else per account when the account changes (see purgeAccountState).
 */

export const DRAFT_KEY_PREFIX = 'orbit.draft.';

/** Keep a creation draft attached to the universe or world it will be submitted to. */
export function scopedDraftKey(form: string, ...scope: (string | null)[]): string {
  return `${form}:${scope.map((part) => encodeURIComponent(part ?? '')).join(':')}`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readDraft<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DRAFT_KEY_PREFIX + key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, value: T): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(DRAFT_KEY_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the draft just doesn't survive this time.
  }
}

export function clearDraft(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(DRAFT_KEY_PREFIX + key);
  } catch {
    // Nothing to clear.
  }
}

/** Whether a draft is worth keeping: something differs from the form's empty state. */
export function draftDiffers<T extends object>(value: T, empty: T): boolean {
  return JSON.stringify(value) !== JSON.stringify(empty);
}
