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
   * Set for the renewal of room already held: the lease as it is before the renewal and as it would be after it. A rule counts a held
   * lease by what it covers inside the rule's own period (see `exposureOf`), so the renewal is asked for the growth of that, whether the
   * lease began in this period or an earlier day or month.
   */
  renewal?: { before: Lease; after: Lease; renewMinutes: number };
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

/** What a step asks of one rule: for a renewal, the growth of what the rule counts of that lease (the part it covers in the rule's period). */
function amountFor(rule: SpendRule, attempt: SpendAttempt, now: Date): number {
  const renewal = attempt.renewal;
  if (!renewal) return attempt.amountMicros;
  const since = rule.period ? periodStart(rule.period, now) : null;
  const before = exposureOf([renewal.before], renewal.renewMinutes, now, since);
  const after = exposureOf([renewal.after], renewal.renewMinutes, now, since);
  return Math.max(0, after - before);
}

/** What one authorized stretch of a lease was priced at when it was taken: when, the room held for one stretch, and how long a stretch was. */
export interface LeaseTerm {
  at: number;
  micros: number;
  stretchMs: number;
}

/** Room held for a computer: a lease is taken for one stretch and renewed, each renewal holding one more stretch and moving the end. */
export interface Lease {
  amountMicros: bigint;
  renewals: number;
  createdAt: Date;
  expiresAt: Date;
  /** The terms of each stretch, in order (see `LeaseTerm`); missing on older rows. */
  terms?: unknown;
}

const toNumber = (value: bigint | number | null): number => (value === null ? 0 : Number(value));

/** The terms of a lease when every one is whole and in time order, else null (the lease is then counted as equal stretches, the safe way round for older rows). */
export function termsOf(value: unknown): LeaseTerm[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const terms: LeaseTerm[] = [];
  for (const item of value) {
    const one = item as Partial<LeaseTerm> | null;
    if (!one || !Number.isFinite(one.at) || !Number.isFinite(one.micros) || !Number.isFinite(one.stretchMs) || (one.micros as number) < 0 || (one.stretchMs as number) <= 0) return null;
    if (terms.length > 0 && (one.at as number) < terms[terms.length - 1].at) return null;
    terms.push({ at: one.at as number, micros: one.micros as number, stretchMs: one.stretchMs as number });
  }
  return terms;
}

/**
 * What the stretches of a lease are priced at between two moments, as a weight: each stretch counts for the room it held per millisecond (its recorded
 * `micros` over its `stretchMs`) times the time of `from`..`to` that fell in it (the first stretch reaches back and the last one forward, so the whole
 * window is always priced). A job's price, and the split of it between two months, are both read from this, so they can never disagree with the room that
 * was held for the same time (`exposureOf`).
 */
export function termWeight(terms: ReadonlyArray<LeaseTerm>, from: number, to: number): number {
  let weight = 0;
  for (let index = 0; index < terms.length; index++) {
    const begin = index === 0 ? Number.NEGATIVE_INFINITY : terms[index].at;
    const end = index + 1 < terms.length ? terms[index + 1].at : Number.POSITIVE_INFINITY;
    const overlap = Math.min(to, end) - Math.max(from, begin);
    if (overlap > 0) weight += (terms[index].micros * overlap) / terms[index].stretchMs;
  }
  return weight;
}

/** The terms of a lease whose price changed while it ran (more than one rate among them), else null: only those need keeping to split a job between periods. */
export function priceChanges(value: unknown): LeaseTerm[] | null {
  const terms = termsOf(value);
  if (!terms) return null;
  const first = terms[0];
  return terms.every((term) => term.micros * first.stretchMs === first.micros * term.stretchMs) ? null : terms;
}

/**
 * The rate a job is priced at when it settles: what each stretch of its lease was priced at when it was taken, over the time the job ran (from its
 * lease to its end, or to the seconds it was charged for if those reach further), never the provider's rate at the moment it closed. One price all
 * through is exactly that price (per minute). Null for a lease with no recorded terms (an older row), which keeps the provider's rate.
 */
export function pinnedMicrosPerMinute(value: unknown, seconds: number, endMs: number): number | null {
  const terms = termsOf(value);
  if (!terms) return null;
  const first = terms[0];
  if (!priceChanges(value)) return (first.micros * 60_000) / first.stretchMs;
  const to = Math.max(endMs, first.at + Math.max(0, seconds) * 1000);
  const span = to - first.at;
  if (span <= 0) {
    const last = terms[terms.length - 1];
    return (last.micros * 60_000) / last.stretchMs;
  }
  return (termWeight(terms, first.at, to) / span) * 60_000;
}

/**
 * What held room can still cost, for a rule. A job that keeps running renews its room every part of a stretch and each renewal holds one
 * more stretch (so the room held grows faster than the computer is used: that is how the allowance stays safe). A rule is about what a
 * task can really cost, so it counts the time the lease covers, never the whole of what was stacked up: a cap of $1 must not stop a job at
 * $0.40. Room taken once (a model call, a first stretch) has no renewals and counts whole.
 *
 * Each stretch is counted under its own recorded price (`terms`): from when it was taken to when the next one was (the last to where the lease
 * ends), at the room held for it per stretch. So a price that changed in the middle of a lease counts the time before it at the old price and
 * the time after at the new one, never an average of the two. Older rows with no terms are counted as equal stretches. The sum is in whole
 * micros, rounded up once for the lease, never less than one stretch at the latest price and never more than what was held.
 *
 * `since` is the start of the rule's period (a day or a month): a lease that began before it is counted by what it covers from `since` on,
 * so the room of a job that crossed midnight or the end of a month is seen by every step of the new period, not only by its own renewal.
 */
export function exposureOf(rows: ReadonlyArray<Lease>, renewMinutes: number, _now?: Date, since: Date | null = null): number {
  const stretchMs = renewMinutes * 60_000;
  let total = 0;
  for (const row of rows) {
    const amount = toNumber(row.amountMicros);
    const terms = termsOf(row.terms);
    if (row.renewals <= 0 || (!terms && !(stretchMs > 0))) {
      total += amount;
      continue;
    }
    const ends = row.expiresAt.getTime();
    // A lease with terms starts when its first stretch was taken (recorded with it), not when its row happened to be written
    const began = terms ? terms[0].at : row.createdAt.getTime();
    const floor = since ? Math.max(since.getTime(), began) : began;
    if (terms) {
      // Whole micros: each piece is (micros x time) / stretch, summed as a fraction and rounded up once
      let cost = 0;
      for (let index = 0; index < terms.length; index++) {
        const term = terms[index];
        const from = Math.max(floor, term.at);
        const to = Math.min(ends, index + 1 < terms.length ? terms[index + 1].at : ends);
        if (to > from) cost += (term.micros * (to - from)) / term.stretchMs;
      }
      const last = terms[terms.length - 1];
      total += Math.min(amount, Math.max(Math.min(last.micros, amount), Math.ceil(cost - 1e-6)));
      continue;
    }
    const oneStretch = amount / (row.renewals + 1);
    // The most the lease can cost is the whole time it covers, from when it began (or from the start of the period, when it began before)
    // to when it now ends: that moves only when a renewal moves the end, never with the clock
    const coveredMs = Math.max(0, ends - floor);
    total += Math.min(amount, Math.max(Math.ceil(oneStretch), Math.ceil(oneStretch * (coveredMs / stretchMs))));
  }
  return total;
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
