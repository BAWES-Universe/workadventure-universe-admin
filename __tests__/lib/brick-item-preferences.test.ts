import { isAllowedPreferenceKey, isAllowedPreferenceValue } from '@/lib/user-preferences';
import { readWorkweek } from '@/lib/brick-item-time';

describe('the zone and workdays a Brick reads goals and tasks on (game #2002)', () => {
  it('lets the game keep the person’s own time zone, and only a real one', () => {
    expect(isAllowedPreferenceKey('timeZone')).toBe(true);
    expect(isAllowedPreferenceValue('timeZone', 'Asia/Kuwait')).toBe(true);
    expect(isAllowedPreferenceValue('timeZone', 'Mars/Olympus')).toBe(false);
    expect(isAllowedPreferenceValue('timeZone', 3)).toBe(false);
  });

  it('keeps the workweek as Sun to Thu, Mon to Fri or the days the person named, never guessed', () => {
    expect(isAllowedPreferenceKey('workweek')).toBe(true);
    expect(readWorkweek('sun-thu')).toEqual([0, 1, 2, 3, 4]);
    expect(readWorkweek('mon-fri')).toEqual([1, 2, 3, 4, 5]);
    expect(readWorkweek({ days: [6, 0] })).toEqual([0, 6]);
    for (const bad of [null, 'kuwait', { days: [] }, { days: [8] }, { days: 'all' }]) expect(readWorkweek(bad)).toBeNull();
    expect(isAllowedPreferenceValue('workweek', 'mon-fri')).toBe(true);
    expect(isAllowedPreferenceValue('workweek', 'saturday')).toBe(false);
  });
});
