/**
 * Per-bot rules (#427): the two numbers behind a No / Default / Yes, and which rule wins. Test plan row 13.
 */
import { flag } from '@/lib/permissions';
import {
  NO_RULE,
  RULE_ACTIONS,
  RULE_MASK,
  isDefaultRule,
  ruleValue,
  verdictFor,
  withValues,
  type RuleBits,
} from '@/lib/bot-rules';

const ZERO = BigInt(0);
const rule = (values: Parameters<typeof withValues>[1]): RuleBits => withValues(NO_RULE, values);

describe('the bits a rule can hold', () => {
  it('are exactly Manage bots, Chat nearby, DM and Summon', () => {
    expect(RULE_MASK).toBe(BigInt(8192 + 16384 + 32768 + 65536));
    expect(RULE_ACTIONS).toEqual(['chat', 'dm', 'summon', 'manage']);
  });

  it('reads Default for a row with nothing set', () => {
    for (const action of RULE_ACTIONS) expect(ruleValue(NO_RULE, action)).toBe('default');
    expect(isDefaultRule(NO_RULE)).toBe(true);
  });
});

describe('withValues', () => {
  it('sets Yes and No for the actions named, and leaves the others alone', () => {
    const changed = rule({ chat: 'yes', dm: 'no' });
    expect(ruleValue(changed, 'chat')).toBe('yes');
    expect(ruleValue(changed, 'dm')).toBe('no');
    expect(ruleValue(changed, 'summon')).toBe('default');
    expect(ruleValue(changed, 'manage')).toBe('default');
    expect(changed.allow & changed.deny).toBe(ZERO);
  });

  it('turns a Yes into a No and back, never both at once', () => {
    let current = rule({ summon: 'yes' });
    current = withValues(current, { summon: 'no' });
    expect(ruleValue(current, 'summon')).toBe('no');
    expect(current.allow & flag('SUMMON_BOTS')).toBe(ZERO);
    current = withValues(current, { summon: 'yes' });
    expect(ruleValue(current, 'summon')).toBe('yes');
    expect(current.deny & flag('SUMMON_BOTS')).toBe(ZERO);
  });

  it('puts one action back to Default without touching the rest', () => {
    const current = withValues(rule({ chat: 'yes', dm: 'yes', summon: 'no' }), { dm: 'default' });
    expect(ruleValue(current, 'chat')).toBe('yes');
    expect(ruleValue(current, 'dm')).toBe('default');
    expect(ruleValue(current, 'summon')).toBe('no');
  });

  it('sets nothing when no action is named, and keeps no bit outside the four', () => {
    expect(withValues(NO_RULE, {})).toEqual(NO_RULE);
    const stray = withValues({ allow: flag('GO_LIVE') | flag('CHAT_BOTS_NEARBY'), deny: ZERO }, { dm: 'yes' });
    expect(stray.allow & flag('GO_LIVE')).toBe(ZERO);
    expect(ruleValue(stray, 'chat')).toBe('yes');
  });
});

describe('verdictFor: which rule wins', () => {
  it('says none when nothing has a Yes or No', () => {
    expect(verdictFor('chat', null, [])).toBe('none');
    expect(verdictFor('chat', NO_RULE, [NO_RULE])).toBe('none');
  });

  it("a person's No beats a Yes from their role (row 13)", () => {
    expect(verdictFor('chat', rule({ chat: 'no' }), [rule({ chat: 'yes' })])).toBe('no');
  });

  it("a person's Yes beats a No from their role", () => {
    expect(verdictFor('dm', rule({ dm: 'yes' }), [rule({ dm: 'no' })])).toBe('yes');
  });

  it("a person's Default lets their roles decide", () => {
    expect(verdictFor('summon', rule({ chat: 'no' }), [rule({ summon: 'yes' })])).toBe('yes');
    expect(verdictFor('summon', rule({ chat: 'no' }), [rule({ summon: 'no' })])).toBe('no');
  });

  it('among roles, a Yes from any one beats a No from another, as in Discord', () => {
    expect(verdictFor('chat', null, [rule({ chat: 'no' }), rule({ chat: 'yes' })])).toBe('yes');
    expect(verdictFor('chat', null, [rule({ chat: 'no' }), rule({ chat: 'no' })])).toBe('no');
  });

  it('keeps each action apart', () => {
    const person = rule({ chat: 'no' });
    expect(verdictFor('chat', person, [])).toBe('no');
    expect(verdictFor('dm', person, [])).toBe('none');
    expect(verdictFor('manage', person, [])).toBe('none');
  });
});
