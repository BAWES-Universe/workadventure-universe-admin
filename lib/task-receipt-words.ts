import type { ActionOutcome, ActivityOutcome } from '@/lib/task-receipts-values';

/**
 * The words for how a task came to end, as mock M2 (approved 19 Nov 2026) has them, and for the two endings that mock did not have: a task
 * that did not finish but took something (the computer's time), and one whose delivery nobody could confirm. This is the only place the
 * words live, so a change of wording is one edit here (the tests import these, never copy them).
 */
export const OUTCOME_WORDS: Record<ActivityOutcome, string> = {
  done: 'Done',
  partial: 'Partly done',
  refunded: 'Refunded, nothing taken',
  failed: 'Didn’t finish',
  unconfirmed: 'Couldn’t confirm',
  stopped: 'Stopped',
  deciding: 'Still checking',
  refund_pending: 'Refund pending',
};

/**
 * What a computer job stopped before it finished says, by what stopped it: never Done (starting a computer is not proof it finished). The pool's words are for a job
 * Orbit's own computers cut off; once its time is given back the headline says so (see `outcomeTextOf`).
 */
export const STOPPED_WORDS = {
  rule: 'Stopped at your spending rule',
  allowance: 'Stopped: your computer time ran out',
  person: 'Stopped by you',
  pool: 'Stopped: our computers were busy',
} as const;
export const STOPPED_AT_RULE = STOPPED_WORDS.rule;

/** What a computer job that is still being looked at says while Orbit has not decided whether to give its cost back (never Done, never refunded). */
export const STILL_CHECKING = 'We’re still checking this one. If it was our fault, the time comes back.';

/** What a failed action says it took: nothing. A worked action's amount is its own line from the books. */
export const NOTHING_TAKEN = 'Nothing taken';

/** What an action nobody could confirm says while its hold on credit is still on: the hold is on its way back, nothing is charged for it. */
export const HOLD_BEING_RELEASED = 'Hold being released';

/** What it says once the credit books have acknowledged giving the hold back (the amount is said beside it). */
export const HOLD_RELEASED = 'Hold released';

/** What a charge the books have not acknowledged yet is called on a receipt: a run held for this may already have been debited. */
export const SETTLEMENT_PENDING = 'Settlement pending';

const ACTION_OUTCOME_WORDS: Record<ActionOutcome, string> = {
  worked: 'worked',
  failed: "didn't work",
  unknown: 'couldn’t confirm delivery',
};

/** The App's short name as a reader sees it: "gmail" is "Gmail". */
export const appLabel = (toolkit: string): string => {
  const words = toolkit.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'App';
};

/** One action's line on a receipt: "Gmail · worked", "Gmail · didn't work", "Gmail · couldn’t confirm delivery". */
export const actionWords = (toolkit: string, outcome: ActionOutcome): string => `${appLabel(toolkit)} · ${ACTION_OUTCOME_WORDS[outcome]}`;

/**
 * Whole micros as a reader says them: "$0", "$0.03", "$0.009" (a charge under a cent shows its thousandths, so a $0.009 Gmail charge is not
 * said as a cent), "less than $0.001" for the smallest.
 */
export function dollars(micros: number): string {
  if (micros <= 0) return '$0';
  if (micros < 500) return 'less than $0.001';
  if (micros < 10_000) return `$${(micros / 1_000_000).toFixed(3)}`;
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** The headline of a receipt for how it came to end: "Stopped at your spending rule", "$0.03 refund pending", and the plain words for the rest. */
export function outcomeTextOf(outcome: ActivityOutcome, facts: { stoppedBy?: string | null; refundPendingMicros?: number; givenBack?: boolean } = {}): string {
  if (outcome === 'stopped' && facts.stoppedBy === 'pool') return facts.givenBack ? `${STOPPED_WORDS.pool}, and its time was given back` : STOPPED_WORDS.pool;
  if (outcome === 'stopped' && (facts.stoppedBy === 'rule' || facts.stoppedBy === 'allowance' || facts.stoppedBy === 'person')) return STOPPED_WORDS[facts.stoppedBy];
  if (outcome === 'refund_pending' && facts.refundPendingMicros !== undefined && facts.refundPendingMicros > 0) return `${dollars(facts.refundPendingMicros)} refund pending`;
  return OUTCOME_WORDS[outcome];
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const listOf = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** What the receipt knows beyond its actions, for the sentence under it. */
export interface NoteFacts {
  /**
   * A computer job was part of the task: how it ended. `worked` (the agent finished it), `failed` (the agent gave up: its time is the person's), `stopped` (stopped before
   * it finished: the person's rule, or they stopped it), `returned` (it failed on our side: none of its cost is the person's).
   */
  job?: 'worked' | 'failed' | 'stopped' | 'returned';
  /** What the computer's time took from the person, in whole micros; null while its price is not known yet; absent when no computer time was charged against the task. */
  computerMicros?: number | null;
  /** An action nobody could confirm still has its credit on hold (it is on its way back). */
  holdPending?: boolean;
  /** What the books say they gave back for actions nobody could confirm, in whole micros (only once they acknowledged it); the hold is then not "being released" any more. */
  releasedMicros?: number;
  /** Computer cost the books have acknowledged giving back, in whole micros. */
  returnedMicros?: number;
  /** Computer cost still owed back to the person: asked for, not acknowledged by the books yet. */
  refundPendingMicros?: number;
  /** Why a charge is only provisional: Orbit is still deciding whether the computer cost is given back. */
  deciding?: 'effect' | 'limits';
  /** What each action that worked took, for a task with a computer (the receipt's lines say it for any other): null while its price is not known yet. */
  appCharges?: readonly { label: string; micros: number | null }[];
  /** What stopped a job that was stopped before it finished (the job's `ended_by`: rule, allowance, person, pool). Said beside the steps of a partly done task, so the stop is never lost behind "Partly done". */
  stoppedBy?: string | null;
  /** What the person pays for the whole task once it is settled (never said while a refund is pending or a price is not known). */
  netMicros?: number | null;
}

/**
 * The sentence under a receipt that did not simply work. Null for done and for refunded (nothing more needs saying).
 *  - partial: "Two steps worked and one didn’t. Nothing was taken for the one that didn’t." (a step that could not be confirmed says so, never "didn’t work")
 *  - failed: "It didn’t finish. Computer time used $0.03. Gmail charged $0."
 *  - stopped: "It stopped before it finished, and nothing was confirmed as done. Computer time used $0.02."
 *  - refund_pending: "We’re returning $0.05 to your credit."
 *  - deciding: "We’re still checking this one. If it was our fault, the time comes back. Computer time $0.03 is charged for now."
 *  - unconfirmed: "We couldn’t confirm whether Gmail finished. We’re releasing your hold." (then "Your hold of $0.01 was released." once the books say so)
 * A task with a computer also says what the computer cost and what each App took, and, once settled, what the person pays in all: a Gmail charge is never hidden
 * behind a refunded computer. What was taken is only ever said from the books' amounts the caller passes in; a hold still on is said as a hold being released.
 */
export function outcomeNote(outcome: ActivityOutcome, actions: readonly { outcome: ActionOutcome; label?: string }[], facts: NoteFacts = {}): string | null {
  if (outcome === 'done' || outcome === 'refunded') return null;
  const steps: ActionOutcome[] = [...actions.map((action) => action.outcome), ...(facts.job ? [facts.job === 'worked' ? ('worked' as const) : ('failed' as const)] : [])];
  const count = (wanted: ActionOutcome) => steps.filter((step) => step === wanted).length;
  const worked = count('worked');
  const failed = count('failed');
  const unknown = count('unknown');
  const notWorked = actions.filter((action) => action.outcome !== 'worked');
  const labels = [...new Set(notWorked.map((action) => appLabel(action.label ?? '')))];
  const hasComputer = facts.job !== undefined;
  const computerKnown = hasComputer && facts.computerMicros !== undefined;
  const pending = facts.refundPendingMicros !== undefined && facts.refundPendingMicros > 0;

  // What the computer cost, said for each way it can have ended
  const computer: string[] = [];
  if (facts.job === 'returned') {
    if (pending) computer.push(`Computer cost of ${dollars(facts.refundPendingMicros ?? 0)} refund pending.`);
    else if (facts.returnedMicros !== undefined && facts.returnedMicros > 0) computer.push(`Computer cost of ${dollars(facts.returnedMicros)} was given back.`);
  } else if (computerKnown) {
    if (facts.computerMicros === null) computer.push('Computer time price not known yet.');
    else computer.push(facts.deciding !== undefined ? `Computer time ${dollars(facts.computerMicros ?? 0)} is charged for now.` : `Computer time used ${dollars(facts.computerMicros ?? 0)}.`);
  }
  // What each App that worked took (for a task with a computer; any other task has its lines)
  const charged: string[] = hasComputer
    ? (facts.appCharges ?? []).map((charge) => (charge.micros === null ? `${appLabel(charge.label)} price not known yet.` : `${appLabel(charge.label)} charged ${dollars(charge.micros)}.`))
    : [];
  // What was taken for the actions that did not work
  const taken: string[] = [];
  if (notWorked.length > 0) {
    if (facts.holdPending) taken.push('We’re releasing your hold.');
    else if (facts.releasedMicros !== undefined && facts.releasedMicros > 0) taken.push(`Your hold of ${dollars(facts.releasedMicros)} was released.`);
    else if (hasComputer) for (const label of labels) taken.push(`${label} charged $0.`);
    else if (notWorked.every((action) => action.outcome === 'failed') && outcome === 'partial') taken.push(`Nothing was taken for ${notWorked.length === 1 ? 'the one that didn’t' : 'the ones that didn’t'}.`);
    else taken.push(`Nothing was taken for ${notWorked.length === 1 ? 'it' : 'them'}.`);
  }
  // What the person pays in all, once everything is settled
  const net: string[] = hasComputer && facts.netMicros !== undefined && facts.netMicros !== null && !pending && facts.returnedMicros !== undefined && facts.returnedMicros > 0 ? [`You pay ${dollars(facts.netMicros)} in all.`] : [];

  const after = [...computer, ...charged, ...taken, ...net];
  const stoppedSaid = (by: string | null | undefined): string[] =>
    by === 'rule' ? ['The computer stopped at your spending rule.'] : by === 'allowance' ? ['The computer stopped because your computer time ran out.'] : by === 'person' ? ['You stopped the computer.'] : by === 'pool' ? ['The computer stopped because our computers were busy.'] : [];
  if (outcome === 'partial') {
    if (worked === 0 || failed + unknown === 0) return null;
    // A computer that failed on our side, beside an App that worked: said as that, with what came back, what the App took and what the person pays in all
    if (facts.job === 'returned') {
      const lead = pending
        ? `The computer part didn’t finish because of a problem on our side. Its time (${dollars(facts.refundPendingMicros ?? 0)}) is refund pending.`
        : `The computer part didn’t finish because of a problem on our side, and its time${facts.returnedMicros !== undefined && facts.returnedMicros > 0 ? ` (${dollars(facts.returnedMicros)})` : ''} was given back.`;
      const apps = (facts.appCharges ?? []).map((charge) => (charge.micros === null ? `${appLabel(charge.label)} worked. Its price is not known yet.` : `${appLabel(charge.label)} worked and was charged ${dollars(charge.micros)}.`));
      return [lead, ...apps, ...taken, ...net].join(' ');
    }
    const parts = [`${capital(countWord(worked))} ${worked === 1 ? 'step' : 'steps'} worked`];
    const rest = [failed > 0 ? `${countWord(failed)} didn’t` : null, unknown > 0 ? `${countWord(unknown)} couldn’t be confirmed` : null].filter((part): part is string => part !== null);
    // A computer cost that is only provisional while Orbit decides is said beside the steps
    const deciding = facts.deciding === undefined ? [] : [STILL_CHECKING];
    const stopped = facts.job !== 'stopped' ? [] : stoppedSaid(facts.stoppedBy).length > 0 ? stoppedSaid(facts.stoppedBy) : ['The computer was stopped before it finished.'];
    return [`${parts[0]} and ${rest.join(' and ')}.`, ...stopped, ...deciding, ...after].join(' ').trim();
  }
  if (outcome === 'failed') return ['It didn’t finish.', ...after].join(' ');
  if (outcome === 'stopped') return ['It stopped before it finished, and nothing was confirmed as done.', ...after].join(' ');
  if (outcome === 'refund_pending') return [`We’re returning ${dollars(facts.refundPendingMicros ?? 0)} to your credit.`, ...charged, ...taken].join(' ');
  if (outcome === 'deciding') return [STILL_CHECKING, ...computer, ...charged, ...taken].join(' ');
  // unconfirmed
  const names = labels.length > 0 ? listOf(labels) : 'it';
  return [`We couldn’t confirm whether ${names} finished.`, ...after].join(' ');
}
