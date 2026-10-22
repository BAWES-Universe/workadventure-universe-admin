import { timeAgo, timeAgoShort } from '@/lib/time-ago';

const now = new Date('2026-10-19T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe('timeAgo', () => {
  it('says weeks up to 30 days, never "0 months"', () => {
    expect(timeAgo(daysAgo(27), now)).toBe('3 weeks ago');
    expect(timeAgo(daysAgo(28), now)).toBe('4 weeks ago');
    expect(timeAgo(daysAgo(29), now)).toBe('4 weeks ago');
    expect(timeAgo(daysAgo(30), now)).toBe('1 month ago');
  });

  it('says months up to a year, never "0 years"', () => {
    expect(timeAgo(daysAgo(359), now)).toBe('11 months ago');
    expect(timeAgo(daysAgo(362), now)).toBe('12 months ago');
    expect(timeAgo(daysAgo(365), now)).toBe('1 year ago');
  });

  it('matches the short version at the same edge', () => {
    expect(timeAgoShort(daysAgo(29), now)).toBe('4 w');
    expect(timeAgoShort(daysAgo(30), now)).toBe('1 mo');
  });
});
