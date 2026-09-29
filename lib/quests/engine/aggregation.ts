import type { QuestAggregation } from '@prisma/client';
import { MAX_COUNTER_STEP, MAX_DURATION_STEP_SECONDS, MAX_THRESHOLD_BY_AGGREGATION } from './limits';

/** What an observation may carry besides the action and its subject. Anything else is ignored. */
export interface ObservationEvidence {
  /** For a duration: how long the state held, in whole seconds. */
  seconds?: number;
  /** For a bounded counter: how many units this action was worth. */
  amount?: number;
}

export interface ObjectiveShape {
  aggregation: QuestAggregation;
  threshold: number;
}

function boundedInteger(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

/**
 * How much one observation adds to an objective, or null when its evidence is out of bounds (missing, not a whole
 * number, zero, negative, or more than one observation may claim). A state predicate, an event and a distinct
 * entity are each worth one; a unique-entity set's deduplication is the caller's.
 */
export function evidenceStep(objective: Pick<ObjectiveShape, 'aggregation'>, evidence: ObservationEvidence | null | undefined): number | null {
  switch (objective.aggregation) {
    case 'STATE':
    case 'UNIQUE_SET':
    case 'EVENT_COUNT':
      return 1;
    case 'DURATION':
      return boundedInteger(evidence?.seconds, MAX_DURATION_STEP_SECONDS);
    case 'COUNTER':
      return boundedInteger(evidence?.amount, MAX_COUNTER_STEP);
  }
}

export interface Advance {
  count: number;
  satisfied: boolean;
}

/** The count after adding a step, never above the threshold, and whether the objective is now met. */
export function advance(objective: ObjectiveShape, count: number, step: number): Advance {
  const next = Math.min(objective.threshold, Math.max(0, count) + Math.max(0, step));
  return { count: next, satisfied: next >= objective.threshold };
}

/** A threshold an objective may ask for: a whole number from one to the bound of its aggregation. */
export function validThreshold(aggregation: QuestAggregation, threshold: unknown): threshold is number {
  return boundedInteger(threshold, MAX_THRESHOLD_BY_AGGREGATION[aggregation]) !== null;
}

/** The evidence an observation carries, kept to the two typed fields the engine reads, or null when there is none. */
export function minimalEvidence(raw: unknown): ObservationEvidence | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const evidence: ObservationEvidence = {};
  if (typeof record.seconds === 'number' && Number.isFinite(record.seconds)) evidence.seconds = record.seconds;
  if (typeof record.amount === 'number' && Number.isFinite(record.amount)) evidence.amount = record.amount;
  return Object.keys(evidence).length ? evidence : null;
}
