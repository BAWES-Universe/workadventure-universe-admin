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
  const row = (reason: string, extra: Partial<{ kind: string; source: string; providerStatus: number | null }> = {}) => ({ kind: 'fault', source: 'universe-ai', reason, ...extra });

  it('is ours for the faults only our side can cause, and the provider refusing our key, when the relay confirmed it (kind fault)', () => {
    for (const reason of ['relay_down', 'route_unknown', 'authorize_failed', 'key_decrypt_failed', 'pool_busy', 'provider_key_ours']) expect(faultClassOf(row(reason))).toBe('ours');
  });

  it('is the person’s for their allowance, a rule, and a field their job set, when the relay marked it so (kind not_ours)', () => {
    for (const reason of ['allowance', 'rule', 'field_job_set']) expect(faultClassOf(row(reason, { kind: 'not_ours' }))).toBe('person');
  });

  it('is the owner’s for their own provider only when it REFUSED the key or the request (a 4xx); a generic 5xx, a timeout, a disconnect with no status or a cut stream is unresolved, never theirs', () => {
    const own = (providerStatus: number | null) => faultClassOf(row('own_provider', { kind: 'not_ours', source: 'own-key', providerStatus }));
    for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) expect(own(status)).toBe('person');
    for (const status of [408, 500, 502, 503, 504, 529, null]) expect(own(status)).toBe('unresolved');
  });

  it('is unresolved for provider failures, a field only the relay sets, and any reason Orbit does not know (never ours)', () => {
    for (const reason of ['provider_5xx', 'provider_429', 'stream_cut', 'timeout_no_output', 'timeout_after_output', 'fieldless_400', 'field_relay_set', 'provider_403', 'brand_new_reason']) expect(faultClassOf(row(reason, { kind: 'uncertain' }))).toBe('unresolved');
  });

  it('is unresolved when the relay’s kind and Orbit’s reason do not agree', () => {
    expect(faultClassOf(row('provider_key_ours', { kind: 'uncertain' }))).toBe('unresolved');
    expect(faultClassOf(row('provider_5xx', { kind: 'fault' }))).toBe('unresolved');
    expect(faultClassOf(row('allowance', { kind: 'fault' }))).toBe('unresolved');
    expect(faultClassOf(row('relay_down', { kind: 'not_ours' }))).toBe('unresolved');
  });

  it('does not charge by source alone: an own-key call reads by kind and reason, so our relay being down is ours and a timeout is unresolved', () => {
    expect(faultClassOf(row('relay_down', { source: 'own-key' }))).toBe('ours');
    expect(faultClassOf(row('provider_5xx', { source: 'own-key', kind: 'uncertain' }))).toBe('unresolved');
    expect(faultClassOf(row('timeout_after_output', { source: 'own-key', kind: 'uncertain' }))).toBe('unresolved');
    expect(faultClassOf(row('own_provider', { source: 'own-key', kind: 'not_ours', providerStatus: 401 }))).toBe('person');
    expect(faultClassOf(row('own_provider', { source: 'own-key', kind: 'not_ours', providerStatus: 500 }))).toBe('unresolved');
    expect(faultClassOf(row('own_provider', { source: 'own-key', kind: 'not_ours' }))).toBe('unresolved');
    // Their provider refusing their key is theirs only when the relay says it is not ours; unconfirmed, or a row that says fault on their own key, stays unresolved
    expect(faultClassOf(row('provider_key_ours', { source: 'own-key', kind: 'not_ours' }))).toBe('person');
    expect(faultClassOf(row('provider_key_ours', { source: 'own-key', kind: 'uncertain' }))).toBe('unresolved');
    expect(faultClassOf(row('provider_key_ours', { source: 'own-key', kind: 'fault' }))).toBe('unresolved');
  });

  it('is nothing for an answered call', () => {
    expect(faultClassOf(row('relay_down', { kind: 'answered' }))).toBeNull();
    expect(faultClassOf(row('relay_down', { source: 'own-key', kind: 'answered' }))).toBeNull();
  });
});

describe('the settings the give-back reads, and the wait before a held decision is tried again', () => {
  it('has no problem when the numbers are there, and says so when they are not', () => {
    expect(giveBackSettingsProblems({ goodwillPerPersonPerMonth: null, pauseMinRuns: 10, pauseFailureRateBps: 2000 })).toEqual([]);
    expect(giveBackSettingsProblems({ goodwillPerPersonPerMonth: null, pauseMinRuns: null, pauseFailureRateBps: null }).length).toBeGreaterThan(0);
  });

  it('names the provider pause number and the person’s failure rate apart: the number of runs is what pauses a provider, the rate only a person’s own give-backs', () => {
    const onlyRate = giveBackSettingsProblems({ goodwillPerPersonPerMonth: 2, pauseMinRuns: 3, pauseFailureRateBps: null });
    expect(onlyRate).toHaveLength(1);
    expect(onlyRate[0]).toMatch(/failure rate/);
    expect(onlyRate[0]).not.toMatch(/provider failing/);
    const onlyRuns = giveBackSettingsProblems({ goodwillPerPersonPerMonth: 2, pauseMinRuns: null, pauseFailureRateBps: 2000 });
    expect(onlyRuns.some((line) => /number of runs/.test(line) && /provider failing/.test(line))).toBe(true);
  });

  it('grows from one minute to an hour and stops growing', () => {
    expect(retryWaitMs(0)).toBe(60_000);
    expect(retryWaitMs(3)).toBe(8 * 60_000);
    expect(retryWaitMs(30)).toBe(60 * 60_000);
  });
});
