import type { ActionOutcome, ReceiptAction, ReceiptOutcome } from '@/lib/task-receipts-values';

/**
 * The words for how a task came to end, as mock M2 (approved 19 Nov 2026) has them. This is the only place the words live, so a change of
 * wording is one edit here (the tests import these, never copy them).
 */
export const OUTCOME_WORDS: Record<ReceiptOutcome, string> = {
  done: 'Done',
  partial: 'Partly done',
  refunded: 'Refunded, nothing taken',
};

/** What a failed action says it took: nothing. A worked action's amount is its own line from the books. */
export const NOTHING_TAKEN = 'Nothing taken';

const ACTION_OUTCOME_WORDS: Record<ActionOutcome, string> = {
  worked: 'worked',
  failed: "didn't work",
};

/** The App's short name as a reader sees it: "gmail" is "Gmail". */
export const appLabel = (toolkit: string): string => {
  const words = toolkit.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'App';
};

/** One action's line on a receipt: "Gmail · worked", "Gmail · didn't work". */
export const actionWords = (toolkit: string, outcome: ActionOutcome): string => `${appLabel(toolkit)} · ${ACTION_OUTCOME_WORDS[outcome]}`;

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The sentence under a partly done receipt: "Two steps worked and one didn't. Nothing was taken for the one that didn't." Null for any other
 * outcome (nothing more needs saying).
 */
export function outcomeNote(outcome: ReceiptOutcome, actions: readonly Pick<ReceiptAction, 'outcome'>[]): string | null {
  if (outcome !== 'partial') return null;
  const worked = actions.filter((action) => action.outcome === 'worked').length;
  const failed = actions.length - worked;
  if (worked === 0 || failed === 0) return null;
  const steps = (n: number) => `${capital(countWord(n))} ${n === 1 ? 'step' : 'steps'}`;
  const those = failed === 1 ? 'the one that didn’t' : 'the ones that didn’t';
  return `${steps(worked)} worked and ${countWord(failed)} didn’t. Nothing was taken for ${those}.`;
}
