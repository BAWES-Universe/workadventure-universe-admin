import { draftRule, holdToRules, periodStart, refusedWords, ruleApplies, ruleWords, type SpendAttempt, type SpendRule } from '@/lib/spend-rules-values';

const rule = (over: Partial<SpendRule> = {}): SpendRule => ({
  id: 'r1',
  ownerPersonId: 'sara',
  scope: 'bot',
  botId: 'brick1',
  taskKey: null,
  period: 'month',
  capMicros: 1_000_000,
  onlyOwnAccounts: false,
  covers: 'all',
  words: 'No more than $1.00 a month from your credit for Brick',
  version: 1,
  ...over,
});

const attempt = (over: Partial<SpendAttempt> = {}): SpendAttempt => ({ payerPersonId: 'sara', botId: 'brick1', taskKey: 'job1', chargeClass: 'computer', amountMicros: 100_000, ...over });

describe('what a rule said in chat means', () => {
  it('"no more than $1 for this bot" asks one short question: each task, each day or each month', () => {
    const drafted = draftRule({ botId: 'brick1', botName: 'Scout', scope: 'bot', capMicros: 1_000_000 });
    expect(drafted).toMatchObject({ ok: false, reason: 'needs_answer', ask: { about: 'period', question: 'Is $1.00 for each task, each day or each month?' } });
    if (!drafted.ok && drafted.reason === 'needs_answer') expect(drafted.ask.options.map((o) => o.value)).toEqual(['task', 'day', 'month']);
  });

  it('asks "just this Brick, or all your Bricks?" when nothing says where it applies and no task is going on', () => {
    const drafted = draftRule({ botId: 'brick1', botName: 'Scout', capMicros: 500_000, period: 'month' });
    expect(drafted).toMatchObject({ ok: false, reason: 'needs_answer', ask: { about: 'scope', question: 'Is that just for Scout, or for all your Bricks?' } });
  });

  it('read during a task, "this task" is the plain reading and nothing is asked', () => {
    const drafted = draftRule({ botId: 'brick1', taskKey: 'job1', capMicros: 1_000_000 });
    expect(drafted).toMatchObject({ ok: true, draft: { scope: 'task', taskKey: 'job1', botId: 'brick1', period: 'task', capMicros: 1_000_000 } });
  });

  it('said during a task with a day or a month, it is not "this task": where it applies is asked, and the period said is kept', () => {
    const asked = draftRule({ botId: 'brick1', botName: 'Scout', taskKey: 'job1', capMicros: 5_000_000, period: 'month' });
    expect(asked).toMatchObject({ ok: false, reason: 'needs_answer', ask: { about: 'scope' } });
    // Once it is said where, the month stands, and it is not turned into a rule for one task
    expect(draftRule({ botId: 'brick1', taskKey: 'job1', scope: 'bot', capMicros: 5_000_000, period: 'month' })).toMatchObject({ ok: true, draft: { scope: 'bot', taskKey: null, period: 'month' } });
    // "For each task" said during a task is still this task
    expect(draftRule({ botId: 'brick1', taskKey: 'job1', capMicros: 5_000_000, period: 'task' })).toMatchObject({ ok: true, draft: { scope: 'task', period: 'task' } });
  });

  it('an ask for nothing more passes a rule that is exactly at its cap and stops one that is past it', () => {
    const capped = rule({ capMicros: 100 });
    expect(holdToRules([capped], attempt({ amountMicros: 0 }), () => ({ spentMicros: 40, heldMicros: 60 }))).toEqual({ ok: true });
    expect(holdToRules([capped], attempt({ amountMicros: 0 }), () => ({ spentMicros: 40, heldMicros: 61 }))).toMatchObject({ ok: false, why: 'cap', leftMicros: 0 });
    expect(holdToRules([capped], attempt({ amountMicros: 1 }), () => ({ spentMicros: 40, heldMicros: 60 }))).toMatchObject({ ok: false });
  });

  it('a cap on one task that also says a day or a month is refused, not quietly turned into a one-task cap', () => {
    expect(draftRule({ botId: 'brick1', taskKey: 'job1', scope: 'task', capMicros: 5_000_000, period: 'month' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'brick1', taskKey: 'job1', scope: 'task', capMicros: 5_000_000, period: 'day' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'brick1', taskKey: 'job1', scope: 'task', capMicros: 5_000_000, period: 'task' })).toMatchObject({ ok: true, draft: { scope: 'task', period: 'task' } });
  });

  it('"only use my accounts" needs no period and no amount', () => {
    const drafted = draftRule({ botId: 'brick1', scope: 'person', onlyOwnAccounts: true });
    expect(drafted).toMatchObject({ ok: true, draft: { scope: 'person', botId: null, taskKey: null, period: null, capMicros: null, onlyOwnAccounts: true, covers: 'all' } });
  });

  it('keeps a real zero: "spend nothing" is a cap of 0, not a missing cap', () => {
    expect(draftRule({ botId: 'brick1', scope: 'bot', period: 'month', capMicros: 0 })).toMatchObject({ ok: true, draft: { capMicros: 0 } });
  });

  it('refuses what is not a rule, and numbers that are not whole money', () => {
    expect(draftRule({ botId: 'b' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', capMicros: -1, scope: 'bot', period: 'day' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', capMicros: 1.5, scope: 'bot', period: 'day' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', capMicros: '1', scope: 'bot', period: 'day' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', capMicros: 100, scope: 'galaxy' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', capMicros: 100, scope: 'bot', period: 'week' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(draftRule({ botId: 'b', onlyOwnAccounts: true, scope: 'task' })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('has no ceiling and no default amount of its own: the amount is only ever the one said', () => {
    expect(draftRule({ botId: 'b', scope: 'person', period: 'day', capMicros: Number.MAX_SAFE_INTEGER })).toMatchObject({ ok: true });
    expect(draftRule({ botId: 'b', scope: 'person', period: 'day' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('a rule in plain words', () => {
  it('says what it is about in the words people use: Apps, credit, computer, Brick', () => {
    expect(ruleWords({ scope: 'bot', period: 'month', capMicros: 1_000_000, onlyOwnAccounts: false, covers: 'all' }, 'Scout')).toBe('No more than $1.00 a month from your credit for Scout');
    expect(ruleWords({ scope: 'task', period: 'task', capMicros: 1_200_000, onlyOwnAccounts: false, covers: 'apps' })).toBe('No more than $1.20 from your Instant Apps credit for this task');
    expect(ruleWords({ scope: 'person', period: 'day', capMicros: 500_000, onlyOwnAccounts: false, covers: 'computer' })).toBe('No more than $0.50 a day from your computer credit for all your Bricks');
    expect(ruleWords({ scope: 'bot', period: 'task', capMicros: 250_000, onlyOwnAccounts: false, covers: 'all' }, 'Scout')).toBe('No more than $0.25 from your credit for each task, for Scout');
    expect(ruleWords({ scope: 'person', period: null, capMicros: null, onlyOwnAccounts: true, covers: 'all' })).toBe('Only your own accounts: nothing is taken from your credit');
    expect(ruleWords({ scope: 'bot', period: 'month', capMicros: 0, onlyOwnAccounts: false, covers: 'all' })).toContain('No more than $0');
  });

  it('never uses the words tool, MCP, connector, wallet or top up', () => {
    const all = [
      ruleWords({ scope: 'person', period: 'month', capMicros: 1, onlyOwnAccounts: true, covers: 'apps' }),
      refusedWords({ ok: false, ruleId: 'r', why: 'own_accounts', leftMicros: 0, words: 'Only your own accounts' }),
      refusedWords({ ok: false, ruleId: 'r', why: 'cap', leftMicros: 250_000, words: 'No more than $1.00 a month' }),
    ].join(' ');
    expect(all).not.toMatch(/tool|mcp|connector|wallet|top up|top-up/i);
  });
});

describe('which rules are about a step', () => {
  it('only the paying person’s own rules, for the bot, the task or everything they pay for', () => {
    expect(ruleApplies(rule(), attempt())).toBe(true);
    expect(ruleApplies(rule(), attempt({ payerPersonId: 'omar' }))).toBe(false);
    expect(ruleApplies(rule(), attempt({ botId: 'other' }))).toBe(false);
    expect(ruleApplies(rule({ scope: 'person', botId: null }), attempt({ botId: 'other' }))).toBe(true);
    expect(ruleApplies(rule({ scope: 'task', taskKey: 'job1' }), attempt())).toBe(true);
    expect(ruleApplies(rule({ scope: 'task', taskKey: 'job1' }), attempt({ taskKey: 'job2' }))).toBe(false);
  });

  it('a rule about Instant Apps credit does not touch a computer job, and the other way round', () => {
    expect(ruleApplies(rule({ covers: 'apps' }), attempt({ chargeClass: 'computer' }))).toBe(false);
    expect(ruleApplies(rule({ covers: 'apps' }), attempt({ chargeClass: 'apps' }))).toBe(true);
    expect(ruleApplies(rule({ covers: 'computer' }), attempt({ chargeClass: 'apps' }))).toBe(false);
  });
});

describe('holding a step to the rules', () => {
  const none = () => ({ spentMicros: 0, heldMicros: 0 });

  it('lets a step through when nothing applies', () => {
    expect(holdToRules([], attempt(), none)).toEqual({ ok: true });
    expect(holdToRules([rule({ ownerPersonId: 'omar' })], attempt({ amountMicros: 999_000_000 }), none)).toEqual({ ok: true });
  });

  it('counts what was taken and what is held: a step is refused when it would go over, and the answer says what is left', () => {
    const refused = holdToRules([rule()], attempt({ amountMicros: 300_000 }), () => ({ spentMicros: 600_000, heldMicros: 200_000 }));
    expect(refused).toMatchObject({ ok: false, ruleId: 'r1', why: 'cap', leftMicros: 200_000 });
    expect(holdToRules([rule()], attempt({ amountMicros: 200_000 }), () => ({ spentMicros: 600_000, heldMicros: 200_000 }))).toEqual({ ok: true });
  });

  it('is refused when nothing is left, and a cap of 0 refuses everything', () => {
    expect(holdToRules([rule()], attempt({ amountMicros: 1 }), () => ({ spentMicros: 1_000_000, heldMicros: 0 }))).toMatchObject({ ok: false, leftMicros: 0 });
    expect(holdToRules([rule({ capMicros: 0 })], attempt({ amountMicros: 1 }), none)).toMatchObject({ ok: false, why: 'cap', leftMicros: 0 });
  });

  it('"only my own accounts" refuses any step charged to credit, with no amount involved', () => {
    expect(holdToRules([rule({ capMicros: null, period: null, onlyOwnAccounts: true })], attempt({ amountMicros: 1 }), none)).toMatchObject({ ok: false, why: 'own_accounts' });
  });

  it('every rule that applies must pass: the strictest decides and nothing is added up or lifted', () => {
    const generous = rule({ id: 'big', capMicros: 50_000_000 });
    const strict = rule({ id: 'small', capMicros: 150_000 });
    const spent = (r: SpendRule) => (r.id === 'big' ? { spentMicros: 0, heldMicros: 0 } : { spentMicros: 100_000, heldMicros: 0 });
    expect(holdToRules([generous, strict], attempt({ amountMicros: 100_000 }), spent)).toMatchObject({ ok: false, ruleId: 'small', leftMicros: 50_000 });
    // Two refusals: the person hears the one with the least left
    const tight = rule({ id: 'tight', capMicros: 100_000 });
    expect(holdToRules([strict, tight], attempt({ amountMicros: 200_000 }), () => ({ spentMicros: 0, heldMicros: 0 }))).toMatchObject({ ruleId: 'tight', leftMicros: 100_000 });
  });
});

describe('when a cap counts from', () => {
  it('a day and a month start at 00:00 UTC, the same calendar the credit uses; a task has no calendar', () => {
    const now = new Date('2026-11-15T21:30:00Z');
    expect(periodStart('day', now)?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(periodStart('month', now)?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(periodStart('task', now)).toBeNull();
  });
});
