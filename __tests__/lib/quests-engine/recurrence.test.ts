import { attemptWindow, inWindow } from '@/lib/quests/engine/recurrence';

describe('attemptWindow', () => {
  it('a one-shot quest has one attempt that never ends', () => {
    expect(attemptWindow('ONCE', new Date('2026-09-29T13:00:00Z'))).toEqual({ startsAt: new Date(0), endsAt: null });
  });

  it('a daily quest resets at UTC midnight', () => {
    const window = attemptWindow('DAILY', new Date('2026-09-29T23:59:59.999Z'));
    expect(window).toEqual({ startsAt: new Date('2026-09-29T00:00:00Z'), endsAt: new Date('2026-09-30T00:00:00Z') });
    expect(inWindow(window, new Date('2026-09-29T00:00:00Z'))).toBe(true);
    expect(inWindow(window, new Date('2026-09-30T00:00:00Z'))).toBe(false);
  });

  it('a weekly quest starts on Monday 00:00 UTC', () => {
    // 2026-09-29 is a Tuesday.
    expect(attemptWindow('WEEKLY', new Date('2026-09-29T13:00:00Z'))).toEqual({
      startsAt: new Date('2026-09-28T00:00:00Z'),
      endsAt: new Date('2026-10-05T00:00:00Z'),
    });
    // A Sunday belongs to the week that started the Monday before.
    expect(attemptWindow('WEEKLY', new Date('2026-10-04T23:00:00Z')).startsAt).toEqual(new Date('2026-09-28T00:00:00Z'));
    expect(attemptWindow('WEEKLY', new Date('2026-10-05T00:00:00Z')).startsAt).toEqual(new Date('2026-10-05T00:00:00Z'));
  });
});
