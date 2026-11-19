import type { ActionOutcome, ReceiptOutcome } from '@/lib/task-receipts-values';

/**
 * PLACEHOLDER WORDS for how a task came to end (money fixes O1). The final wording lands with mock M2; this is the only place the words
 * live, so swapping them is one edit here (the tests that read these words import them, never copy them).
 */
export const OUTCOME_WORDS: Record<ReceiptOutcome, string> = {
  done: 'Done',
  partial: 'Partly done',
  refunded: 'Refunded, nothing taken',
};

/** One action's line on a receipt, e.g. "gmail: worked". The name of the App is the toolkit's own short name. */
export const ACTION_OUTCOME_WORDS: Record<ActionOutcome, string> = {
  worked: 'worked',
  failed: 'did not work',
};

export const actionWords = (label: string, outcome: ActionOutcome): string => `${label}: ${ACTION_OUTCOME_WORDS[outcome]}`;
