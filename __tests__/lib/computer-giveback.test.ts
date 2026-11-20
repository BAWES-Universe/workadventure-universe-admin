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

import { faultClassOf } from '@/lib/computer-faults';
import { giveBackSettingsProblems, retryWaitMs } from '@/lib/computer-giveback';

describe('the class of one thing the relay saw go wrong (Orbit judges it, not the relay)', () => {
  const row = (reason: string, extra: Partial<{ kind: string; source: string }> = {}) => ({ kind: 'fault', source: 'universe-ai', reason, ...extra });

  it('is ours for the faults only our side can cause, and the provider refusing our key, when the relay confirmed it (kind fault)', () => {
    for (const reason of ['relay_down', 'route_unknown', 'authorize_failed', 'key_decrypt_failed', 'pool_busy', 'provider_key_ours']) expect(faultClassOf(row(reason))).toBe('ours');
  });

  it('is the person’s for their allowance, a rule, and a field their job set, when the relay marked it so (kind not_ours)', () => {
    for (const reason of ['allowance', 'rule', 'field_job_set', 'own_provider']) expect(faultClassOf(row(reason, { kind: 'not_ours' }))).toBe('person');
  });

  it('is unresolved for provider failures, a field only the relay sets, and any reason Orbit does not know (never ours)', () => {
    for (const reason of ['provider_5xx', 'provider_429', 'stream_cut', 'timeout_no_output', 'timeout_after_output', 'fieldless_400', 'field_relay_set', 'brand_new_reason']) expect(faultClassOf(row(reason, { kind: 'uncertain' }))).toBe('unresolved');
  });

  it('is unresolved when the relay’s kind and Orbit’s reason do not agree', () => {
    expect(faultClassOf(row('provider_key_ours', { kind: 'uncertain' }))).toBe('unresolved');
    expect(faultClassOf(row('provider_5xx', { kind: 'fault' }))).toBe('unresolved');
    expect(faultClassOf(row('allowance', { kind: 'fault' }))).toBe('unresolved');
    expect(faultClassOf(row('relay_down', { kind: 'not_ours' }))).toBe('unresolved');
  });

  it('is the person’s for every call on their own key, whatever the reason, and nothing for an answered call', () => {
    expect(faultClassOf(row('relay_down', { source: 'own-key' }))).toBe('person');
    expect(faultClassOf(row('provider_5xx', { source: 'own-key' }))).toBe('person');
    expect(faultClassOf(row('relay_down', { kind: 'answered' }))).toBeNull();
  });
});

describe('the settings the give-back reads, and the wait before a held decision is tried again', () => {
  it('has no problem when the numbers are there, and says so when they are not', () => {
    expect(giveBackSettingsProblems({ goodwillPerPersonPerMonth: null, pauseMinRuns: 10, pauseFailureRateBps: 2000 })).toEqual([]);
    expect(giveBackSettingsProblems({ goodwillPerPersonPerMonth: null, pauseMinRuns: null, pauseFailureRateBps: null }).length).toBeGreaterThan(0);
  });

  it('grows from one minute to an hour and stops growing', () => {
    expect(retryWaitMs(0)).toBe(60_000);
    expect(retryWaitMs(3)).toBe(8 * 60_000);
    expect(retryWaitMs(30)).toBe(60 * 60_000);
  });
});
