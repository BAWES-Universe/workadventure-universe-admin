/**
 * Who can ring or friend a player, and what friends can see. Stored as UserPreference rows under
 * the `people.*` keys, so the existing preference allowlist and size cap apply.
 */

export const PEOPLE_PREFERENCE_KEYS = {
  ringFrom: 'people.ringFrom',
  friendRequestsFrom: 'people.friendRequestsFrom',
  findableByName: 'people.findableByName',
  friendsSeeLocation: 'people.friendsSeeLocation',
} as const;

export type RingFrom = 'friends' | 'friends_and_members' | 'nobody';
export type FriendRequestsFrom = 'anyone' | 'shared_world' | 'nobody';

export interface PeopleSettings {
  ringFrom: RingFrom;
  friendRequestsFrom: FriendRequestsFrom;
  findableByName: boolean;
  friendsSeeLocation: boolean;
}

/** What a new user gets: only friends can ring, requests from people who share a world, not findable by name. */
export const DEFAULT_PEOPLE_SETTINGS: PeopleSettings = {
  ringFrom: 'friends',
  friendRequestsFrom: 'shared_world',
  findableByName: false,
  friendsSeeLocation: true,
};

const RING_FROM: readonly string[] = ['friends', 'friends_and_members', 'nobody'];
const REQUESTS_FROM: readonly string[] = ['anyone', 'shared_world', 'nobody'];

export function isPeopleSettingKey(key: string): boolean {
  return (Object.values(PEOPLE_PREFERENCE_KEYS) as string[]).includes(key);
}

/** Whether `value` is allowed for the people setting stored under `key`. */
export function isValidPeopleSetting(key: string, value: unknown): boolean {
  switch (key) {
    case PEOPLE_PREFERENCE_KEYS.ringFrom:
      return typeof value === 'string' && RING_FROM.includes(value);
    case PEOPLE_PREFERENCE_KEYS.friendRequestsFrom:
      return typeof value === 'string' && REQUESTS_FROM.includes(value);
    case PEOPLE_PREFERENCE_KEYS.findableByName:
    case PEOPLE_PREFERENCE_KEYS.friendsSeeLocation:
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/** Builds settings from stored preference rows, falling back to the defaults for missing or invalid values. */
export function peopleSettingsFromRows(rows: ReadonlyArray<{ key: string; value: unknown }>): PeopleSettings {
  const settings: PeopleSettings = { ...DEFAULT_PEOPLE_SETTINGS };
  for (const field of Object.keys(PEOPLE_PREFERENCE_KEYS) as (keyof PeopleSettings)[]) {
    const row = rows.find((r) => r.key === PEOPLE_PREFERENCE_KEYS[field]);
    if (row && isValidPeopleSetting(row.key, row.value)) {
      (settings as unknown as Record<string, unknown>)[field] = row.value;
    }
  }
  return settings;
}
