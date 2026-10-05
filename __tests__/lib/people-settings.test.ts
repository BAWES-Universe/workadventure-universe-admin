import { DEFAULT_PEOPLE_SETTINGS, isValidPeopleSetting, peopleSettingsFromRows } from '@/lib/people-settings';
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
