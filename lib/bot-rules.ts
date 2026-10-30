import { combine, flag, type PermissionKey } from '@/lib/permissions';

/**
 * Per-bot rules (#427, #737): a role's or a person's No / Default / Yes for one bot, for the six things people do with it.
 * A rule is two permission numbers, the shape room overrides will reuse: `allow` has a bit set where the answer is Yes,
 * `deny` where it is No, and a bit in neither is Default (the roles decide).
 */
export type RuleAction = 'chat' | 'dm' | 'summon' | 'manage' | 'change' | 'deleteOrSend';
export type RuleValue = 'yes' | 'no' | 'default';

export const RULE_ACTIONS: readonly RuleAction[] = ['chat', 'dm', 'summon', 'manage', 'change', 'deleteOrSend'];
export const RULE_VALUES: readonly RuleValue[] = ['yes', 'no', 'default'];

export const RULE_PERMISSION: Record<RuleAction, PermissionKey> = {
  chat: 'CHAT_BOTS_NEARBY',
  dm: 'DM_BOTS',
  summon: 'SUMMON_BOTS',
  manage: 'MANAGE_BOTS',
  change: 'BOTS_CHANGE_THINGS',
  deleteOrSend: 'BOTS_DELETE_OR_SEND',
};

/** The six bits a rule may hold. The database refuses any other. */
export const RULE_MASK: bigint = combine(...RULE_ACTIONS.map((action) => flag(RULE_PERMISSION[action])));

export interface RuleBits {
  allow: bigint;
  deny: bigint;
}

export const NO_RULE: RuleBits = { allow: BigInt(0), deny: BigInt(0) };

const ZERO = BigInt(0);

/** What one rule says about one action. */
export function ruleValue(rule: RuleBits, action: RuleAction): RuleValue {
  const bit = flag(RULE_PERMISSION[action]);
  if (rule.deny & bit) return 'no';
  if (rule.allow & bit) return 'yes';
  return 'default';
}

/** The rule with some actions changed; the others keep what they had. */
export function withValues(rule: RuleBits, values: Partial<Record<RuleAction, RuleValue>>): RuleBits {
  let { allow, deny } = rule;
  for (const action of RULE_ACTIONS) {
    const value = values[action];
    if (!value) continue;
    const bit = flag(RULE_PERMISSION[action]);
    allow &= ~bit;
    deny &= ~bit;
    if (value === 'yes') allow |= bit;
    if (value === 'no') deny |= bit;
  }
  return { allow: allow & RULE_MASK, deny: deny & RULE_MASK };
}

export function isDefaultRule(rule: RuleBits): boolean {
  return rule.allow === ZERO && rule.deny === ZERO;
}

export type Verdict = 'yes' | 'no' | 'none';

/**
 * What the rules say about one action for one person. Their own row beats their roles' rows, so a No for a person beats
 * a Yes from their role. Among their roles it is the Discord way: a Yes from any role beats a No from another. When
 * nothing says Yes or No the answer is 'none' and the roles' permissions decide.
 */
export function verdictFor(action: RuleAction, person: RuleBits | null, roles: readonly RuleBits[]): Verdict {
  if (person) {
    const own = ruleValue(person, action);
    if (own === 'no') return 'no';
    if (own === 'yes') return 'yes';
  }
  const said = roles.map((rule) => ruleValue(rule, action));
  if (said.includes('yes')) return 'yes';
  if (said.includes('no')) return 'no';
  return 'none';
}
