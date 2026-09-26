/**
 * Per-user Orbit preferences. Only allowlisted keys can be read or written, and
 * each value is capped so the table cannot be used as general-purpose storage.
 */

export const PREFERENCE_VALUE_MAX_BYTES = 2048;

const FIXED_PREFERENCE_KEYS = new Set(['orbit.introSeen', 'quests.invitationDeclined']);

/** `guidance.dismissed.<id>`: id is 1-64 chars of letters, digits, `_` or `-`. */
const GUIDANCE_DISMISSED_KEY = /^guidance\.dismissed\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isAllowedPreferenceKey(key: unknown): key is string {
  return typeof key === 'string' && (FIXED_PREFERENCE_KEYS.has(key) || GUIDANCE_DISMISSED_KEY.test(key));
}

/** Serialized size in bytes, or null when the value is not JSON-serializable. */
export function preferenceValueSize(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}
