import { prisma } from '@/lib/db';

/**
 * The two amounts set aside for one model step of a computer job (R1, D1). They are never one number:
 *  - the member's: what the person's credit sets aside, from a realistic answer length, and
 *  - the provider's: the most the provider can bill for the step, held in Universe's pool.
 * The member's estimate never changes the model, the reasoning, the tools or the answer the call is really allowed.
 *
 * The constants below live in this one file and limit nobody: they only size what is set aside while a step runs. What is really
 * charged is what the step used, and a step that is longer than its estimate takes the rest only from funds that are eligible, free and
 * inside what was authorised (lib/computer-calls.ts).
 */

/** How many of the job's most recent comparable settled steps the estimate reads. */
export const HISTORY_STEPS = 20;
/** Steps that must have settled before the history is used; before that a new job starts at `STARTING_ANSWER_TOKENS`. */
export const MIN_HISTORY_STEPS = 5;
/** The answer length a new job is estimated at, in tokens. */
export const STARTING_ANSWER_TOKENS = 4_096;
/** The estimate is this many times the median answer of the history. */
export const MEDIAN_FACTOR = 2;

export interface StepGroup {
  jobId: string;
  /** Comparable steps: the same route and model, and the same kind of step where the game says it. */
  route: string;
  model: string;
  stepKind: string;
}

/** The median of a list of numbers (the mean of the middle two for an even count); 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The answer length, in tokens, the member's amount is worked out at: twice the median answer of the last 20 comparable settled steps of
 * this job, or 4,096 until 5 steps have settled. Never above what the call is really allowed to answer (including a call allowed less than 4,096).
 */
export function estimatedAnswerTokens(history: readonly number[], maxOutputTokens: number): number {
  const wanted = history.length >= MIN_HISTORY_STEPS ? Math.ceil(median(history.slice(0, HISTORY_STEPS)) * MEDIAN_FACTOR) : STARTING_ANSWER_TOKENS;
  return Math.max(1, Math.min(wanted, maxOutputTokens));
}

/** The output side of a cost: tokens at a price for one million, rounded up to whole millionths of a dollar. */
export const outputMicros = (tokens: number, outputMicrosPerMillion: number): number => Math.ceil((tokens * outputMicrosPerMillion) / 1_000_000);

/** The answer lengths of the job's last settled comparable steps, newest first (a step that did not say its length is not counted). */
export async function answerHistory(group: StepGroup): Promise<number[]> {
  const rows = await prisma.computerCallAuthorisation.findMany({
    where: { jobId: group.jobId, route: group.route, model: group.model, stepKind: group.stepKind, state: 'settled', outputTokens: { not: null } },
    orderBy: { settledAt: 'desc' },
    take: HISTORY_STEPS,
    select: { outputTokens: true },
  });
  return rows.flatMap((row) => (row.outputTokens === null ? [] : [row.outputTokens]));
}

export interface TwoAmounts {
  /** What is set aside from the member (the funding authorisation's payer). At least 1. */
  memberMicros: number;
  /** The most the provider can bill, held in the pool. Never less than the member's. */
  providerMaxMicros: number;
  /** The answer length the member's amount was worked out at. */
  answerTokens: number;
}

/**
 * The two amounts for a step. The provider maximum is recomputed here from the step's own figures; a larger figure the game sent as
 * its own reading is kept, a smaller one is never trusted.
 */
export async function twoAmounts(
  group: StepGroup,
  step: { inputMicros: number; outputMicrosPerMillion: number; maxOutputTokens: number; providerMaxMicros?: number | null },
): Promise<TwoAmounts> {
  const history = await answerHistory(group);
  const answerTokens = estimatedAnswerTokens(history, step.maxOutputTokens);
  const worst = step.inputMicros + outputMicros(step.maxOutputTokens, step.outputMicrosPerMillion);
  const providerMaxMicros = Math.max(1, worst, step.providerMaxMicros ?? 0);
  const memberMicros = Math.max(1, Math.min(providerMaxMicros, step.inputMicros + outputMicros(answerTokens, step.outputMicrosPerMillion)));
  return { memberMicros, providerMaxMicros, answerTokens };
}
