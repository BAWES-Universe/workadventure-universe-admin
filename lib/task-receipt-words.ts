import type { ActionOutcome, ReceiptOutcome } from '@/lib/task-receipts-values';

/**
 * The words for how a task came to end, as mock M2 (approved 19 Nov 2026) has them, and for the two endings that mock did not have: a task
 * that did not finish but took something (the computer's time), and one whose delivery nobody could confirm. This is the only place the
 * words live, so a change of wording is one edit here (the tests import these, never copy them).
 */
export const OUTCOME_WORDS: Record<ReceiptOutcome, string> = {
  done: 'Done',
  partial: 'Partly done',
  refunded: 'Refunded, nothing taken',
  failed: 'Didn’t finish',
  unconfirmed: 'Couldn’t confirm',
};

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

/** Whole micros as a reader says them: "$0", "$0.03", "less than $0.01" for a charge too small to show in cents. */
export function dollars(micros: number): string {
  if (micros <= 0) return '$0';
  if (micros < 5000) return 'less than $0.01';
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const listOf = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** What the receipt knows beyond its actions, for the sentence under it. */
export interface NoteFacts {
  /** A computer job was part of the task: how it ended (the agent finished it, or gave up). */
  job?: 'worked' | 'failed';
  /** What the computer's time took from the person, in whole micros; null while its price is not known yet; absent when no computer time was charged against the task. */
  computerMicros?: number | null;
  /** An action nobody could confirm still has its credit on hold (it is on its way back). */
  holdPending?: boolean;
  /** What the books say they gave back for actions nobody could confirm, in whole micros (only once they acknowledged it); the hold is then not "being released" any more. */
  releasedMicros?: number;
}

/**
 * The sentence under a receipt that did not simply work. Null for done and for refunded (nothing more needs saying).
 *  - partial: "Two steps worked and one didn’t. Nothing was taken for the one that didn’t." (a step that could not be confirmed says so, never "didn’t work")
 *  - failed: "It didn’t finish. Computer time used $0.03. Gmail charged $0."
 *  - unconfirmed: "We couldn’t confirm whether Gmail finished. We’re releasing your hold." (then "Your hold of $0.01 was released." once the books say so)
 * What was taken is only ever said from the books' amounts the caller passes in; a hold still on is said as a hold being released.
 */
export function outcomeNote(outcome: ReceiptOutcome, actions: readonly { outcome: ActionOutcome; label?: string }[], facts: NoteFacts = {}): string | null {
  if (outcome === 'done' || outcome === 'refunded') return null;
  const steps: ActionOutcome[] = [...actions.map((action) => action.outcome), ...(facts.job ? [facts.job] : [])];
  const count = (wanted: ActionOutcome) => steps.filter((step) => step === wanted).length;
  const worked = count('worked');
  const failed = count('failed');
  const unknown = count('unknown');
  const notWorked = actions.filter((action) => action.outcome !== 'worked');
  const labels = [...new Set(notWorked.map((action) => appLabel(action.label ?? '')))];
  const hasComputer = facts.job !== undefined && facts.computerMicros !== undefined;

  // What was taken, said for each part
  const taken: string[] = [];
  if (hasComputer) taken.push(facts.computerMicros === null ? 'Computer time price not known yet.' : `Computer time used ${dollars(facts.computerMicros ?? 0)}.`);
  if (notWorked.length > 0) {
    if (facts.holdPending) taken.push('We’re releasing your hold.');
    else if (facts.releasedMicros !== undefined && facts.releasedMicros > 0) taken.push(`Your hold of ${dollars(facts.releasedMicros)} was released.`);
    else if (hasComputer) for (const label of labels) taken.push(`${label} charged $0.`);
    else if (notWorked.every((action) => action.outcome === 'failed') && outcome === 'partial') taken.push(`Nothing was taken for ${notWorked.length === 1 ? 'the one that didn’t' : 'the ones that didn’t'}.`);
    else taken.push(`Nothing was taken for ${notWorked.length === 1 ? 'it' : 'them'}.`);
  }

  if (outcome === 'partial') {
    if (worked === 0 || failed + unknown === 0) return null;
    const parts = [`${capital(countWord(worked))} ${worked === 1 ? 'step' : 'steps'} worked`];
    const rest = [failed > 0 ? `${countWord(failed)} didn’t` : null, unknown > 0 ? `${countWord(unknown)} couldn’t be confirmed` : null].filter((part): part is string => part !== null);
    return `${parts[0]} and ${rest.join(' and ')}. ${taken.join(' ')}`.trim();
  }
  if (outcome === 'failed') return ['It didn’t finish.', ...taken].join(' ');
  // unconfirmed
  const names = labels.length > 0 ? listOf(labels) : 'it';
  return [`We couldn’t confirm whether ${names} finished.`, ...taken].join(' ');
}
