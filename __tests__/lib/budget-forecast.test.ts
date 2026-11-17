/**
 * The forecast of an area's month and the suggested raises (billing consensus v2, P6): read from the recent days, never a promise of days of
 * notice, and open about a thin sample and a burst.
 */
import { forecast, suggestions, tidyUp } from '@/lib/budget/forecast';

const MILLION = 1_000_000;
const NOW = new Date('2031-06-18T12:00:00Z');
const START = new Date('2031-06-01T00:00:00Z');
const END = new Date('2031-07-01T00:00:00Z');
const input = (over: Partial<Parameters<typeof forecast>[0]> = {}): Parameters<typeof forecast>[0] => ({
  spentMicros: 240 * MILLION,
  heldMicros: 0,
  budgetMicros: 300 * MILLION,
  recentDays: [10, 10, 10, 10, 10, 10, 10].map((value) => value * MILLION),
  now: NOW,
  monthStart: START,
  monthEnd: END,
  sparseDays: 3,
  burstPercent: 50,
  ...over,
});

describe('the forecast', () => {
  it('works the month’s end from the recent daily pace and the days left', () => {
    const result = forecast(input());
    // 12.5 days left at $10 a day on top of $240
    expect(result.dailyMicros).toBe(10 * MILLION);
    expect(result.monthEndMicros).toBe(Math.round(240 * MILLION + 10 * MILLION * 12.5));
  });

  it('says when the budget is reached at that pace, and never when it is not reached this month', () => {
    const reaches = forecast(input());
    expect(reaches.runsOutAt).not.toBeNull();
    // $60 left at $10 a day: six days
    expect(reaches.runsOutAt!.getTime()).toBe(NOW.getTime() + 6 * 24 * 3600 * 1000);
    expect(forecast(input({ budgetMicros: 900 * MILLION })).runsOutAt).toBeNull();
  });

  it('counts room that is set aside as used already', () => {
    const result = forecast(input({ heldMicros: 60 * MILLION }));
    expect(result.usedPercent).toBe(100);
    expect(result.runsOutAt).toEqual(NOW);
  });

  it('has no run-out and no percent for an area with no budget', () => {
    const result = forecast(input({ budgetMicros: null }));
    expect(result.runsOutAt).toBeNull();
    expect(result.usedPercent).toBeNull();
  });

  it('says it has little to go on when few of the days had any use', () => {
    expect(forecast(input({ recentDays: [0, 0, 0, 0, 0, 0, 5 * MILLION] })).sparse).toBe(true);
    expect(forecast(input()).sparse).toBe(false);
  });

  it('shows a burst when one day carries more than the saved share of what was read', () => {
    expect(forecast(input({ recentDays: [1, 1, 1, 1, 1, 1, 30].map((value) => value * MILLION) })).burst).toBe(true);
    expect(forecast(input()).burst).toBe(false);
    // One day alone is not a burst: there is nothing to compare it with
    expect(forecast(input({ recentDays: [30 * MILLION] })).burst).toBe(false);
  });

  it('carries the moment it was read', () => {
    expect(forecast(input()).readAt).toEqual(NOW);
  });
});

describe('suggested budgets', () => {
  it('rounds up to a tidy amount', () => {
    expect(tidyUp(405 * MILLION)).toBe(410 * MILLION);
    expect(tidyUp(12_340_000)).toBe(13 * MILLION);
    expect(tidyUp(0)).toBe(0);
  });

  it('offers two amounts from the forecast, using the saved percents, and only ones above the budget now', () => {
    const offers = suggestions(405 * MILLION, 300 * MILLION, 110, 150);
    expect(offers.map((offer) => offer.micros)).toEqual([tidyUp(405 * MILLION * 1.1), tidyUp(405 * MILLION * 1.5)]);
    expect(offers[1].words).toBe('1.5 times the forecast');
    expect(suggestions(405 * MILLION, 700 * MILLION, 110, 150)).toEqual([]);
  });

  it('offers nothing when the percents are not saved', () => {
    expect(suggestions(405 * MILLION, 300 * MILLION, null, null)).toEqual([]);
  });
});
