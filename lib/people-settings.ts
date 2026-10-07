/**
 * Who can ring or friend a player, and what friends can see. Stored as UserPreference rows under
 * the `people.*` keys, so the existing preference allowlist and size cap apply.
 */

/** Live now's old switch, `true` = hidden. Still read, so anyone who had it on stays private. */
export const HIDE_LOCATION_KEY = 'people.hideLocation';
/** Who sees which room you are in: everyone, friends, or no one. Replaces the two switches above and `friendsSeeLocation`. */
export const SHARE_ROOM_KEY = 'people.shareRoom';
/** Who sees your passport: everyone, friends, or no one. */
export const SHARE_PASSPORT_KEY = 'people.sharePassport';

export type Audience = 'everyone' | 'friends' | 'nobody';
export const AUDIENCES: readonly Audience[] = ['everyone', 'friends', 'nobody'];
export const isAudience = (value: unknown): value is Audience => typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value);

/** Every key a person's sharing is read from, the legacy ones included. */
export const SHARING_KEYS = [SHARE_ROOM_KEY, SHARE_PASSPORT_KEY, HIDE_LOCATION_KEY, 'people.friendsSeeLocation'] as const;

type Row = { key: string; value: unknown };

/**
 * Who sees which room someone is in. The new choice wins; without it, the two old switches decide: either one off
 * (hidden from Live now, or friends not seeing where they are) means no one, the cautious reading.
 */
export function shareRoomFromRows(rows: ReadonlyArray<Row>): Audience {
  const chosen = rows.find((row) => row.key === SHARE_ROOM_KEY)?.value;
  if (isAudience(chosen)) return chosen;
  const hidden = rows.some((row) => row.key === HIDE_LOCATION_KEY && row.value === true);
  const friendsBlind = rows.some((row) => row.key === 'people.friendsSeeLocation' && row.value === false);
  return hidden || friendsBlind ? 'nobody' : 'everyone';
}

/** Who sees someone's passport; everyone until they choose otherwise. */
export function sharePassportFromRows(rows: ReadonlyArray<Row>): Audience {
  const chosen = rows.find((row) => row.key === SHARE_PASSPORT_KEY)?.value;
  return isAudience(chosen) ? chosen : 'everyone';
}

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

/** What a new user gets: only friends can ring, anyone signed in can send a request, findable by name. */
export const DEFAULT_PEOPLE_SETTINGS: PeopleSettings = {
  ringFrom: 'friends',
  friendRequestsFrom: 'anyone',
  findableByName: true,
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
  // Friends see where someone is unless they share their room with no one: one choice, read here as a yes or no.
  settings.friendsSeeLocation = shareRoomFromRows(rows) !== 'nobody';
  return settings;
}
