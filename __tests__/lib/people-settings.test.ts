import {
  DEFAULT_PEOPLE_SETTINGS,
  isValidPeopleSetting,
  peopleSettingsFromRows,
  sharePassportFromRows,
  shareRoomFromRows,
} from '@/lib/people-settings';
import { isAllowedPreferenceKey, isAllowedPreferenceValue } from '@/lib/user-preferences';
import { orderedPair, relationshipFor } from '@/lib/friends';

jest.mock('@/lib/db', () => ({ prisma: {} }));

describe('people settings', () => {
  it('falls back to the defaults for missing or invalid stored values', () => {
    expect(peopleSettingsFromRows([])).toEqual(DEFAULT_PEOPLE_SETTINGS);
    expect(peopleSettingsFromRows([
      { key: 'people.ringFrom', value: 'nobody' },
      { key: 'people.findableByName', value: 'yes' },
      { key: 'people.friendRequestsFrom', value: 'everyone' },
    ])).toEqual({ ...DEFAULT_PEOPLE_SETTINGS, ringFrom: 'nobody' });
  });

  it('validates each key against its own values', () => {
    expect(isValidPeopleSetting('people.ringFrom', 'friends_and_members')).toBe(true);
    expect(isValidPeopleSetting('people.ringFrom', true)).toBe(false);
    expect(isValidPeopleSetting('people.friendsSeeLocation', false)).toBe(true);
    expect(isValidPeopleSetting('people.other', true)).toBe(false);
  });

  it('are allowlisted preferences whose values /api/me/preferences also checks', () => {
    expect(isAllowedPreferenceKey('people.ringFrom')).toBe(true);
    expect(isAllowedPreferenceKey('people.other')).toBe(false);
    expect(isAllowedPreferenceValue('people.ringFrom', 'everyone')).toBe(false);
    expect(isAllowedPreferenceValue('people.ringFrom', 'nobody')).toBe(true);
    expect(isAllowedPreferenceValue('orbit.introSeen', { any: 'json' })).toBe(true);
  });
});

describe('sharing', () => {
  it('is Everyone until someone chooses otherwise, for the room and for the passport', () => {
    expect(shareRoomFromRows([])).toBe('everyone');
    expect(sharePassportFromRows([])).toBe('everyone');
  });

  it('reads the new choice first', () => {
    expect(shareRoomFromRows([{ key: 'people.shareRoom', value: 'friends' }])).toBe('friends');
    expect(shareRoomFromRows([{ key: 'people.shareRoom', value: 'everyone' }, { key: 'people.hideLocation', value: true }])).toBe('everyone');
    expect(sharePassportFromRows([{ key: 'people.sharePassport', value: 'nobody' }])).toBe('nobody');
  });

  it('reads either old switch, when off, as No one', () => {
    expect(shareRoomFromRows([{ key: 'people.hideLocation', value: true }])).toBe('nobody');
    expect(shareRoomFromRows([{ key: 'people.friendsSeeLocation', value: false }])).toBe('nobody');
    expect(shareRoomFromRows([{ key: 'people.hideLocation', value: false }, { key: 'people.friendsSeeLocation', value: true }])).toBe('everyone');
  });

  it('ignores a stored value that is not one of the three', () => {
    expect(shareRoomFromRows([{ key: 'people.shareRoom', value: 'strangers' }])).toBe('everyone');
    expect(sharePassportFromRows([{ key: 'people.sharePassport', value: 3 }])).toBe('everyone');
  });

  it('turns the friends switch into the room choice, so the game and Orbit agree', () => {
    expect(peopleSettingsFromRows([{ key: 'people.shareRoom', value: 'everyone' }]).friendsSeeLocation).toBe(true);
    expect(peopleSettingsFromRows([{ key: 'people.shareRoom', value: 'friends' }]).friendsSeeLocation).toBe(true);
    expect(peopleSettingsFromRows([{ key: 'people.shareRoom', value: 'nobody' }]).friendsSeeLocation).toBe(false);
    expect(peopleSettingsFromRows([{ key: 'people.hideLocation', value: true }]).friendsSeeLocation).toBe(false);
  });
});

describe('friend pairs', () => {
  it('store each pair one way round', () => {
    expect(orderedPair('b', 'a')).toEqual({ user1Id: 'a', user2Id: 'b' });
    expect(orderedPair('a', 'b')).toEqual({ user1Id: 'a', user2Id: 'b' });
  });

  it('read from each side', () => {
    const row = { user1Id: 'a', user2Id: 'b', status: 'pending', requestedById: 'a' };
    expect(relationshipFor('a', row)).toBe('request_sent');
    expect(relationshipFor('b', row)).toBe('request_received');
    expect(relationshipFor('b', { ...row, status: 'ignored' })).toBe('request_received');
    expect(relationshipFor('a', { ...row, status: 'blocked' })).toBe('blocked_by_me');
    expect(relationshipFor('b', { ...row, status: 'blocked' })).toBe('blocked_by_them');
    expect(relationshipFor('b', { ...row, status: 'accepted' })).toBe('friends');
    expect(relationshipFor('a', null)).toBe('none');
  });
});
