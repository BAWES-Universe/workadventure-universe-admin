import { dollars } from '@/lib/costs-words';
import { monthOf } from '@/lib/meter-values';

/**
 * Rules people say in chat, as the server holds them (paying spec 3, section 10 and part O4): "only use my accounts", "no more
 * than $1 for this task". A rule is data with a scope, a period and a funding source, and the server holds to it. The words a
 * person wrote are never kept: only what the rule means, and the plain sentence made from it.
 *
 * Nothing here is a number of ours. Every amount is one a person said; there is no ceiling and no default amount.
 */

/** Where a rule applies: one task, one bot (a Brick), or everything the person pays for. */
export const RULE_SCOPES = ['task', 'bot', 'person'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** How long a cap counts: one task, a UTC day or a UTC month (the same calendar the credit uses). */
export const RULE_PERIODS = ['task', 'day', 'month'] as const;
export type RulePeriod = (typeof RULE_PERIODS)[number];

/** What a rule is about: Instant Apps credit, computer credit, or both. */
export const RULE_COVERS = ['apps', 'computer', 'all'] as const;
export type RuleCovers = (typeof RULE_COVERS)[number];

/** What a paid step is charged as: Instant Apps credit or a computer's time. A model's own thinking and ordinary connected apps are never charged to credit. */
export type ChargeClass = 'apps' | 'computer';

export interface SpendRule {
  id: string;
  ownerPersonId: string;
  scope: RuleScope;
  botId: string | null;
  taskKey: string | null;
  /** Null when the rule has no cap (it only says "my own accounts"). */
  period: RulePeriod | null;
  capMicros: number | null;
  /** "Only my own accounts": nothing is taken from credit. */
  onlyOwnAccounts: boolean;
  covers: RuleCovers;
  words: string;
  version: number;
}

/** What a rule says before it is saved. */
export interface RuleDraft {
  scope: RuleScope | null;
  botId: string | null;
  taskKey: string | null;
  period: RulePeriod | null;
  capMicros: number | null;
  onlyOwnAccounts: boolean;
  covers: RuleCovers;
}

export type Drafted = { ok: true; draft: RuleDraft & { scope: RuleScope } } | { ok: false; reason: 'invalid'; error: string } | { ok: false; reason: 'needs_answer'; ask: Ask };

/** One short question, with the answers that settle it, for the Brick to put to the person. */
export interface Ask {
  /** What is missing: the scope or the period. */
  about: 'scope' | 'period';
  question: string;
  options: { value: string; label: string }[];
}

export interface DraftInput {
  /** The Brick it was said to, and the task it was said during, when there is one. */
  botId: string;
  taskKey?: string | null;
  botName?: string | null;
  scope?: unknown;
  period?: unknown;
  capMicros?: unknown;
  onlyOwnAccounts?: unknown;
  covers?: unknown;
}

const isOne = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** What a cap is called: "$1.00", or a cent for a cent. Zero means nothing may be spent. */
const amountWords = (micros: number): string => (micros === 0 ? '$0' : dollars(micros));

const coversWords = (covers: RuleCovers): string => (covers === 'apps' ? 'Instant Apps credit' : covers === 'computer' ? 'computer credit' : 'credit');

/**
 * The plain sentence of a rule, written from what it means: shown back to the person so they can correct it, and in the rule's
 * list. Only the words "Apps", "credit", "computer" and "Brick": nothing about how it works inside.
 */
export function ruleWords(rule: Pick<SpendRule, 'scope' | 'period' | 'capMicros' | 'onlyOwnAccounts' | 'covers'>, botName?: string | null): string {
  const who = rule.scope === 'person' ? 'all your Bricks' : (botName?.trim() || 'this Brick');
  const parts: string[] = [];
  if (rule.onlyOwnAccounts) {
    // Where it applies is said too: the same words for one task, one Brick and all of them would not tell which the person saved
    parts.push(`Only your own accounts, ${rule.scope === 'task' ? 'for this task' : `for ${who}`}: nothing is taken from your ${coversWords(rule.covers)}`);
  }
  if (rule.capMicros !== null) {
    const amount = amountWords(rule.capMicros);
    const what = coversWords(rule.covers);
    if (rule.scope === 'task' || rule.period === 'task') {
      parts.push(rule.scope === 'task' ? `No more than ${amount} from your ${what} for this task` : `No more than ${amount} from your ${what} for each task, for ${who}`);
    } else {
      const every = rule.period === 'day' ? 'a day' : 'a month';
      parts.push(`No more than ${amount} ${every} from your ${what} for ${who}`);
    }
  }
  return parts.join('. ') || 'A rule';
}

/**
 * Reads what the bot server sent into a rule, or the one short question that settles it. The bot server's model reads the person's
 * words; this decides what they mean and never guesses:
 *  - a cap said for a Brick or for everything, with no word on how long ("no more than $1 for this bot"), asks "each task, each day or each month?";
 *  - a rule with no word on where it applies asks "just this Brick, or all your Bricks?", unless it was said during a task, where "this task" is the plain reading;
 *  - a rule with neither a cap nor "only my accounts" is not a rule.
 */
export function draftRule(input: DraftInput): Drafted {
  const onlyOwnAccounts = input.onlyOwnAccounts === true;
  const hasCap = input.capMicros !== undefined && input.capMicros !== null;
  if (hasCap && (typeof input.capMicros !== 'number' || !Number.isSafeInteger(input.capMicros) || input.capMicros < 0)) {
    return { ok: false, reason: 'invalid', error: 'A cap is a whole number of millionths of a dollar, 0 or more' };
  }
  if (!hasCap && !onlyOwnAccounts) return { ok: false, reason: 'invalid', error: 'A rule needs a cap or "only my own accounts"' };
  if (input.scope !== undefined && input.scope !== null && !isOne(RULE_SCOPES, input.scope)) return { ok: false, reason: 'invalid', error: 'Scope is task, bot or person' };
  if (input.period !== undefined && input.period !== null && !isOne(RULE_PERIODS, input.period)) return { ok: false, reason: 'invalid', error: 'Period is task, day or month' };
  if (input.covers !== undefined && input.covers !== null && !isOne(RULE_COVERS, input.covers)) return { ok: false, reason: 'invalid', error: 'Covers is apps, computer or all' };
  const covers: RuleCovers = isOne(RULE_COVERS, input.covers) ? input.covers : 'all';
  const taskKey = input.taskKey ? String(input.taskKey) : null;
  const given: RuleScope | null = isOne(RULE_SCOPES, input.scope) ? input.scope : null;

  // Said during a task, "this task" is the plain reading, unless the person also named a recurring period ("$5 a month"): that is not
  // about one task, so it is asked where it applies, and the period they said is kept
  const recurring = input.period === 'day' || input.period === 'month';
  const scope: RuleScope | null = given ?? (taskKey && !recurring ? 'task' : null);
  if (scope === null) {
    const brick = input.botName?.trim() || 'this Brick';
    return {
      ok: false,
      reason: 'needs_answer',
      ask: {
        about: 'scope',
        question: `Is that just for ${brick}, or for all your Bricks?`,
        options: [
          { value: 'bot', label: `Just ${brick}` },
          { value: 'person', label: 'All my Bricks' },
        ],
      },
    };
  }
  if (scope === 'task' && !taskKey) return { ok: false, reason: 'invalid', error: 'A rule for one task needs the task' };

  let period: RulePeriod | null = null;
  if (hasCap) {
    if (scope === 'task') {
      // A cap on one task counts that task. A recurring period said with it is a different rule (a Brick's month): never quietly
      // turned into a one-task cap that later tasks do not inherit
      if (input.period === 'day' || input.period === 'month') {
        return { ok: false, reason: 'invalid', error: 'A cap on one task counts that task. For a day or a month, say it for the Brick or for everything' };
      }
      period = 'task';
    } else if (isOne(RULE_PERIODS, input.period)) period = input.period;
    else {
      return {
        ok: false,
        reason: 'needs_answer',
        ask: {
          about: 'period',
          question: `Is ${amountWords(input.capMicros as number)} for each task, each day or each month?`,
          options: [
            { value: 'task', label: 'Each task' },
            { value: 'day', label: 'Each day' },
            { value: 'month', label: 'Each month' },
          ],
        },
      };
    }
  }
  return { ok: true, draft: { scope, botId: scope === 'person' ? null : input.botId, taskKey: scope === 'task' ? taskKey : null, period, capMicros: hasCap ? (input.capMicros as number) : null, onlyOwnAccounts, covers } };
}

/** What a paid step is about to take, for the rules to look at. */
export interface SpendAttempt {
  /** Whose credit or accounts pay: the rules of this person apply. */
  payerPersonId: string;
  botId: string | null;
  /** The task it belongs to (a computer job, an Instant run): what "for each task" counts. */
  taskKey: string | null;
  chargeClass: ChargeClass;
  /** What it would take, millionths of a dollar. Use 1 to ask whether anything more may be taken at all; 0 asks only whether the rule is already past (a renewal that adds nothing). */
  amountMicros: number;
  /**
   * Set for the renewal of room already held: what the room could cost before and after, and when it was first taken. A rule that
   * already counts this room (it was taken in the rule's own period) is asked for the difference; a rule that does not count it (taken
   * in an earlier day or month) is asked for all of it, since nothing of it is in what that rule has counted.
   */
  renewal?: { exposureBeforeMicros: number; exposureAfterMicros: number; startedAt: Date };
}

/** What is already taken or held, for the rule's own scope and period (see `spentFor`). */
export interface SpentSoFar {
  spentMicros: number;
  heldMicros: number;
}

export type Refused = { ok: false; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };
export type Allowed = { ok: true };

/** Whether a rule is about this step: its owner pays, the bot or task is the one named, and it covers what the step is charged as. */
export function ruleApplies(rule: SpendRule, attempt: SpendAttempt): boolean {
  if (rule.ownerPersonId !== attempt.payerPersonId) return false;
  if (rule.covers !== 'all' && rule.covers !== attempt.chargeClass) return false;
  if (rule.scope === 'bot') return rule.botId !== null && rule.botId === attempt.botId;
  if (rule.scope === 'task') return rule.taskKey !== null && rule.taskKey === attempt.taskKey;
  return true;
}

/**
 * The rules together: every one that applies must pass, so the strictest one decides and nothing is added up or "the bigger wins".
 * `spent` is asked for each cap by the caller, because what counts depends on the rule's own scope and period. Of several refusals
 * the one with the least left is told, so the person hears the real limit they hit.
 */
export function holdToRules(rules: readonly SpendRule[], attempt: SpendAttempt, spent: (rule: SpendRule) => SpentSoFar, now: Date = new Date()): Allowed | Refused {
  let worst: Refused | null = null;
  for (const rule of rules) {
    if (!ruleApplies(rule, attempt)) continue;
    if (rule.onlyOwnAccounts) {
      return { ok: false, ruleId: rule.id, why: 'own_accounts', leftMicros: 0, words: rule.words };
    }
    if (rule.capMicros !== null) {
      const so = spent(rule);
      const left = Math.max(0, rule.capMicros - so.spentMicros - so.heldMicros);
      const asked = amountFor(rule, attempt, now);
      // An ask for nothing more (a renewal that adds no exposure) passes a job that is at its cap, and stops one that is past it
      const over = so.spentMicros + so.heldMicros > rule.capMicros;
      if ((asked > left || (asked === 0 && over)) && (worst === null || left < (worst.leftMicros ?? 0))) {
        worst = { ok: false, ruleId: rule.id, why: 'cap', leftMicros: left, words: rule.words };
      }
    }
  }
  return worst ?? { ok: true };
}

/** What a step asks of one rule: for a renewal, the growth of what the rule already counts of that room (all of it when the rule does not count it). */
function amountFor(rule: SpendRule, attempt: SpendAttempt, now: Date): number {
  const renewal = attempt.renewal;
  if (!renewal) return attempt.amountMicros;
  const start = rule.period ? periodStart(rule.period, now) : null;
  const counted = start === null || renewal.startedAt.getTime() >= start.getTime();
  return Math.max(0, renewal.exposureAfterMicros - (counted ? renewal.exposureBeforeMicros : 0));
}

/** The first moment a cap with this period starts counting, UTC. A task has no calendar: it counts what that task did. */
export function periodStart(period: RulePeriod, now: Date): Date | null {
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'month') return monthOf(now).start;
  return null;
}

/** What the Brick says when a rule stops a step. Only the rule's own sentence and what is left, never a push to add credit. */
export function refusedWords(refused: Refused): string {
  if (refused.why === 'own_accounts') return `${refused.words}. Brick can use an app you have connected instead.`;
  const left = refused.leftMicros ?? 0;
  return left > 0 ? `${refused.words}. ${dollars(left)} is left under it.` : `${refused.words}. Nothing is left under it.`;
}
