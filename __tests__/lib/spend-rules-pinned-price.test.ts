/** A job is priced at the rates its lease recorded as each stretch was taken (not the provider's rate when it closed), and split between periods by them. */
import { priceChanges, pinnedMicrosPerMinute, termWeight } from '@/lib/spend-rules-values';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 12, 0);
const stretch = (at: number, micros: number) => ({ at: T0 + at * MIN, micros, stretchMs: 10 * MIN });

describe('pinnedMicrosPerMinute', () => {
  it('is null for a lease with no recorded terms (an older row keeps the provider’s rate)', () => {
    expect(pinnedMicrosPerMinute(null, 300, T0)).toBeNull();
    expect(pinnedMicrosPerMinute([], 300, T0)).toBeNull();
  });

  it('is exactly the one price when every stretch was taken at it', () => {
    const terms = [stretch(0, 60_000), stretch(8, 60_000), stretch(16, 60_000)];
    expect(pinnedMicrosPerMinute(terms, 1_200, T0 + 20 * MIN)).toBe(6_000);
    expect(priceChanges(terms)).toBeNull();
  });

  it('is the time-weighted price when it changed while the job ran: 8 minutes at 6,000 and 7 at 12,000', () => {
    const terms = [stretch(0, 60_000), stretch(8, 120_000)];
    // 8 x 6,000 + 7 x 12,000 = 132,000 over 15 minutes
    expect(pinnedMicrosPerMinute(terms, 900, T0 + 15 * MIN)).toBeCloseTo(8_800, 6);
    expect(priceChanges(terms)).toEqual(terms);
  });

  it('prices seconds that reach past the end (a hand over of files) at the last stretch’s price, never above what was held', () => {
    const terms = [stretch(0, 60_000), stretch(8, 120_000)];
    // 900 seconds charged, ended at minute 14: the window reaches to minute 15
    expect(pinnedMicrosPerMinute(terms, 900, T0 + 14 * MIN)).toBeCloseTo(8_800, 6);
  });

  it('a stretch taken while the rate was not known (1 micro) is not a price: its neighbour prices its time', () => {
    // 4 minutes at 6,000, then 1 micro of room for the next stretch, over 8 minutes
    const terms = [stretch(0, 60_000), stretch(4, 1)];
    expect(pinnedMicrosPerMinute(terms, 480, T0 + 8 * MIN)).toBe(6_000);
    expect(priceChanges(terms)).toBeNull();
    // First stretch unknown: the next one prices it, back to the start of the lease
    expect(pinnedMicrosPerMinute([stretch(0, 1), stretch(4, 60_000)], 480, T0 + 8 * MIN)).toBe(6_000);
    // A real change next to an unknown one is still the time-weighted price of the real ones: 4 at 6,000, unknown, 4 at 12,000 (the unknown one is priced by the first)
    expect(pinnedMicrosPerMinute([stretch(0, 60_000), stretch(4, 1), stretch(8, 120_000)], 720, T0 + 12 * MIN)).toBeCloseTo(8_000, 6);
  });

  it('a lease with no price at all (only unknown stretches) keeps the provider’s rate', () => {
    expect(pinnedMicrosPerMinute([stretch(0, 1)], 300, T0 + 5 * MIN)).toBeNull();
    expect(pinnedMicrosPerMinute([stretch(0, 1), stretch(5, 1)], 600, T0 + 10 * MIN)).toBeNull();
  });

  it('a lease that ended the moment it began is priced at its last stretch', () => {
    expect(pinnedMicrosPerMinute([stretch(0, 60_000), stretch(0, 120_000)], 0, T0)).toBe(12_000);
  });
});

describe('termWeight', () => {
  it('reaches the first stretch back and the last one forward, so the whole window is priced', () => {
    const terms = [stretch(0, 60_000), stretch(8, 120_000)];
    // 10 minutes before the lease at the first price, 5 after the last at the last price
    expect(termWeight(terms, T0 - 10 * MIN, T0)).toBe(60_000);
    expect(termWeight(terms, T0 + 8 * MIN, T0 + 13 * MIN)).toBe(60_000);
    expect(termWeight(terms, T0, T0 + 15 * MIN)).toBe(132_000);
  });
});
