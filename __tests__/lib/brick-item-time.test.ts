import { firstDue, isTimeZone, nextDue, readCadence, repeatMinutes, zonedToUtc } from '@/lib/brick-item-time';

const iso = (ms: number | Date | null) => (ms === null ? null : new Date(ms).toISOString());

describe('zonedToUtc', () => {
  it('reads the wall clock of the zone', () => {
    expect(iso(zonedToUtc(2026, 11, 12, 7, 30, 'Asia/Kuwait'))).toBe('2026-11-12T04:30:00.000Z');
    expect(iso(zonedToUtc(2026, 11, 12, 7, 30, 'UTC'))).toBe('2026-11-12T07:30:00.000Z');
  });

  it('runs a time that does not exist at the moment the clock jumps', () => {
    // Europe/London 29 Mar 2026: 01:00 GMT jumps to 02:00 BST, so 01:30 never happens
    expect(iso(zonedToUtc(2026, 3, 29, 1, 30, 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z');
    // America/New_York 8 Mar 2026: 02:00 EST jumps to 03:00 EDT
    expect(iso(zonedToUtc(2026, 3, 8, 2, 30, 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
  });

  it('runs a time that happens twice the first time', () => {
    // Europe/London 25 Oct 2026: 02:00 BST goes back to 01:00 GMT, so 01:30 happens twice
    expect(iso(zonedToUtc(2026, 10, 25, 1, 30, 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('readCadence', () => {
  it('takes the four cadences and nothing else', () => {
    expect(readCadence({ type: 'daily', time: '07:30', days: [5, 1, 3] })).toEqual({ type: 'daily', time: '07:30', days: [1, 3, 5] });
    expect(readCadence({ type: 'every', minutes: 60 })).toEqual({ type: 'every', minutes: 60 });
    expect(readCadence({ type: 'once', at: '2026-11-12T10:00:00+03:00' })).toEqual({ type: 'once', at: '2026-11-12T07:00:00.000Z' });
    expect(readCadence({ type: 'none' })).toEqual({ type: 'none' });
    for (const bad of [null, 'daily', { type: 'cron' }, { type: 'daily', time: '7:30', days: [1] }, { type: 'daily', time: '07:30', days: [] }, { type: 'daily', time: '07:30', days: [1, 1] }, { type: 'daily', time: '07:30', days: [7] }, { type: 'every', minutes: 0 }, { type: 'every', minutes: 1.5 }, { type: 'once', at: 'soon' }]) {
      expect(readCadence(bad)).toBeNull();
    }
  });
});

describe('due times', () => {
  const kuwait = 'Asia/Kuwait';
  const workdays = { type: 'daily' as const, time: '07:30', days: [0, 1, 2, 3, 4] };

  it('finds the next workday morning, skipping the weekend', () => {
    // Thursday 12 Nov 2026, 9:00 Kuwait: the next is Sunday 15 Nov 7:30 (Sun to Thu workweek; Friday and Saturday are off)
    expect(iso(firstDue(workdays, kuwait, new Date('2026-11-12T06:00:00Z')))).toBe('2026-11-15T04:30:00.000Z');
    expect(iso(firstDue(workdays, kuwait, new Date('2026-11-12T00:00:00Z')))).toBe('2026-11-12T04:30:00.000Z');
  });

  it('never gives a moment that is already past after an outage: one catch-up, no backlog', () => {
    const due = new Date('2026-11-09T04:30:00Z');
    // Down for three days: the next one is the first still to come, not the three missed
    expect(iso(nextDue(workdays, kuwait, due, new Date('2026-11-12T06:00:00Z')))).toBe('2026-11-15T04:30:00.000Z');
    const hourly = { type: 'every' as const, minutes: 60 };
    expect(iso(nextDue(hourly, kuwait, new Date('2026-11-12T01:00:00Z'), new Date('2026-11-12T05:20:00Z')))).toBe('2026-11-12T06:00:00.000Z');
    expect(iso(nextDue(hourly, kuwait, new Date('2026-11-12T01:00:00Z'), new Date('2026-11-12T01:00:05Z')))).toBe('2026-11-12T02:00:00.000Z');
  });

  it('keeps the zone the item was set in when the clock changes', () => {
    const london = { type: 'daily' as const, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
    // 24 Oct 08:00 is still summer time (07:00Z); after the clocks go back 08:00 is 08:00Z
    expect(iso(firstDue(london, 'Europe/London', new Date('2026-10-24T08:00:00Z')))).toBe('2026-10-25T08:00:00.000Z');
    expect(iso(nextDue(london, 'Europe/London', new Date('2026-10-25T08:00:00Z'), new Date('2026-10-25T08:00:01Z')))).toBe('2026-10-26T08:00:00.000Z');
  });

  it('a one-off that is already past is never due', () => {
    expect(firstDue({ type: 'once', at: '2026-11-12T01:00:00.000Z' }, kuwait, new Date('2026-11-12T02:00:00Z'))).toBeNull();
    expect(nextDue({ type: 'once', at: '2026-11-12T01:00:00.000Z' }, kuwait, new Date('2026-11-12T01:00:00Z'), new Date('2026-11-12T01:00:01Z'))).toBeNull();
    expect(firstDue({ type: 'none' }, kuwait, new Date())).toBeNull();
  });
});

describe('isTimeZone', () => {
  it('knows real zones only', () => {
    expect(isTimeZone('Asia/Kuwait')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(5)).toBe(false);
  });
});

describe('a moment names its own offset, and a daily time repeats at the gap its weekdays leave', () => {
  it('refuses a moment with no Z or offset, which would be read on the server clock', () => {
    expect(readCadence({ type: 'once', at: '2026-11-12T08:00:00' })).toBeNull();
    expect(readCadence({ type: 'once', at: '2026-11-12' })).toBeNull();
    expect(readCadence({ type: 'once', at: '2026-11-12T08:00:00Z' })).toEqual({ type: 'once', at: '2026-11-12T08:00:00.000Z' });
    expect(readCadence({ type: 'once', at: '2026-11-12T08:00:00+03:00' })).toEqual({ type: 'once', at: '2026-11-12T05:00:00.000Z' });
  });

  it('counts the shortest gap between the chosen weekdays, wrapping round the week', () => {
    const daily = (days: number[]) => repeatMinutes({ type: 'daily', time: '08:00', days });
    expect(daily([0, 1, 2, 3, 4, 5, 6])).toBe(1440);
    expect(daily([1, 2, 3, 4, 5])).toBe(1440);
    expect(daily([1, 3])).toBe(2 * 1440);
    expect(daily([1, 4])).toBe(3 * 1440);
    expect(daily([1])).toBe(7 * 1440);
    expect(daily([0, 6])).toBe(1440);
  });
});
