import { personGiveBackBound, personGiveBackPaused } from '@/lib/computer-giveback';

describe('how many give-backs a person may have, read from Instant’s own Limits', () => {
  it('is the number a super admin set for Instant give-backs, when there is one', () => {
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: 5, pauseMinRuns: 10, pauseFailureRateBps: 2000 })).toBe(5);
  });

  it('is what Instant’s pause rule tolerates in its smallest batch when that number is empty (the launch numbers: 2 in 10)', () => {
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: null, pauseMinRuns: 10, pauseFailureRateBps: 2000 })).toBe(2);
    // Zero never means "unlimited": it reads as empty, like Instant's own button
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: 0, pauseMinRuns: 10, pauseFailureRateBps: 2000 })).toBe(2);
  });

  it('is never less than one, however small the batch and share are', () => {
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: null, pauseMinRuns: 1, pauseFailureRateBps: 1 })).toBe(1);
  });

  it('is nothing to read when Limits carry no number at all', () => {
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: null, pauseMinRuns: null, pauseFailureRateBps: null })).toBeNull();
    expect(personGiveBackBound({ goodwillPerPersonPerMonth: null, pauseMinRuns: 10, pauseFailureRateBps: null })).toBeNull();
  });
});

describe('Instant’s pause rule on one person’s month', () => {
  const limits = { pauseMinRuns: 10, pauseFailureRateBps: 2000 };

  it('pauses once enough jobs ended and the share given back reached the share that pauses Instant', () => {
    expect(personGiveBackPaused(limits, 10, 2)).toBe(true);
    expect(personGiveBackPaused(limits, 10, 3)).toBe(true);
  });

  it('does not pause under that share, or before enough jobs have ended', () => {
    expect(personGiveBackPaused(limits, 10, 1)).toBe(false);
    expect(personGiveBackPaused(limits, 9, 9)).toBe(false);
  });

  it('lifts by itself as the share falls', () => {
    expect(personGiveBackPaused(limits, 10, 2)).toBe(true);
    expect(personGiveBackPaused(limits, 11, 2)).toBe(false);
  });

  it('never pauses with no numbers', () => {
    expect(personGiveBackPaused({ pauseMinRuns: null, pauseFailureRateBps: null }, 100, 100)).toBe(false);
  });
});
