import { isPeopleSettingKey, isValidPeopleSetting } from './people-settings';

/**
 * Per-user Orbit preferences. Only allowlisted keys can be read or written, and
 * each value is capped so the table cannot be used as general-purpose storage.
 */

export const PREFERENCE_VALUE_MAX_BYTES = 2048;

/** Invitations dismissed on Orbit home, `{ ids }`: hidden there and left out of the count on You. */
export const INVITATIONS_DISMISSED_KEY = 'guidance.dismissed.invitations';

/** Live now's own switch: true drops you out of Live now and its counts (see lib/live-presence.ts). */
export const HIDE_LOCATION_KEY = 'people.hideLocation';

const FIXED_PREFERENCE_KEYS = new Set(['orbit.introSeen', 'quests.invitationDeclined', HIDE_LOCATION_KEY]);

/** `guidance.dismissed.<id>`: id is 1-64 chars of letters, digits, `_` or `-`. */
const GUIDANCE_DISMISSED_KEY = /^guidance\.dismissed\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isAllowedPreferenceKey(key: unknown): key is string {
  return typeof key === 'string'
    && (FIXED_PREFERENCE_KEYS.has(key) || GUIDANCE_DISMISSED_KEY.test(key) || isPeopleSettingKey(key));
}

/** Keys with a fixed set of values (the `people.*` settings) only accept those; other keys accept any JSON. */
export function isAllowedPreferenceValue(key: string, value: unknown): boolean {
  return isPeopleSettingKey(key) ? isValidPeopleSetting(key, value) : true;
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
