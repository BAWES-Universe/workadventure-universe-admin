import { DEFAULT_PUSH_SETTINGS, applyPushSettingsChange, readStoredPushSettings } from '@/lib/push-settings';

jest.mock('@/lib/db', () => ({ prisma: {} }));

describe('notification settings', () => {
  it('starts with messages, friend requests and memberships on, a friend in your room and going live off', () => {
    expect(DEFAULT_PUSH_SETTINGS).toEqual({
      directMessages: true,
      friendRequests: true,
      memberships: true,
      friendInRoom: false,
      friendLive: false,
      dmFrom: 'friends_members',
      previews: true,
      quietHours: null,
    });
  });

  it('applies a change of some settings and keeps the rest', () => {
    expect(applyPushSettingsChange(DEFAULT_PUSH_SETTINGS, { friendLive: true, dmFrom: 'friends' })).toEqual({
      ...DEFAULT_PUSH_SETTINGS,
      friendLive: true,
      dmFrom: 'friends',
    });
  });

  it('takes quiet hours in a time zone, and Off', () => {
    const quietHours = { start: '22:00', end: '07:00', timeZone: 'Asia/Kuwait' };
    const on = applyPushSettingsChange(DEFAULT_PUSH_SETTINGS, { quietHours });
    expect(on?.quietHours).toEqual(quietHours);
    expect(applyPushSettingsChange(on!, { quietHours: null })?.quietHours).toBeNull();
  });

  it.each([
    ['an unknown setting', { sound: true }],
    ['a switch that is not true or false', { memberships: 'yes' }],
    ['an unknown source', { dmFrom: 'guests' }],
    ['a time that does not exist', { quietHours: { start: '24:00', end: '07:00', timeZone: 'Asia/Kuwait' } }],
    ['quiet hours that start when they end', { quietHours: { start: '07:00', end: '07:00', timeZone: 'Asia/Kuwait' } }],
    ['an unknown time zone', { quietHours: { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' } }],
    ['a list', [true]],
  ])('refuses the whole change for %s', (_label, change) => {
    expect(applyPushSettingsChange(DEFAULT_PUSH_SETTINGS, change)).toBeNull();
  });

  it('reads a stored row leniently: what is no longer valid falls back to its default', () => {
    expect(readStoredPushSettings({ friendLive: true, dmFrom: 'gone', old: 1 })).toEqual({ ...DEFAULT_PUSH_SETTINGS, friendLive: true });
    expect(readStoredPushSettings(undefined)).toEqual(DEFAULT_PUSH_SETTINGS);
  });
});
