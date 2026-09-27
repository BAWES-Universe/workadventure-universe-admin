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

/** The readable address a name gives a new universe, world or room: "Head Office" → "head-office". */
export function addressFromName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The shape creation drafts are saved in now. Version 1 (no `v`) kept only the typed text; version 2 also keeps
 * whether the address was edited by hand and, for a room, the map choice.
 */
export const FORM_DRAFT_VERSION = 2;

/**
 * Brings a saved creation draft, of any version, into the form's current shape. Only fields the form still has, with
 * the type it expects, are taken (a field that is `null` when empty also takes a string); the rest start blank. A
 * draft from before the address flag was kept counts as edited by hand when its address isn't the one its name gives,
 * so restoring it never overwrites a custom address. Returns null for anything that isn't a draft.
 */
export function upgradeFormDraft<T extends { v: number; name: string; slug: string; addressEdited: boolean }>(
  raw: unknown,
  empty: T,
): T | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const saved = raw as Record<string, unknown>;
  const draft: Record<string, unknown> = { ...empty };
  for (const field of Object.keys(empty)) {
    if (!(field in saved)) continue;
    const blank = (empty as Record<string, unknown>)[field];
    const value = saved[field];
    if (blank === null ? value === null || typeof value === 'string' : typeof value === typeof blank) draft[field] = value;
  }
  if (typeof saved.addressEdited !== 'boolean') {
    const slug = draft.slug as string;
    draft.addressEdited = slug !== '' && slug !== addressFromName(draft.name as string);
  }
  draft.v = FORM_DRAFT_VERSION;
  return draft as T;
}
