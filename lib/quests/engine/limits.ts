import type { QuestAggregation, QuestEvidence } from '@prisma/client';

/**
 * The bounds of the quest ledger. Every value in it is finite, positive and bounded: per objective (thresholds and the
 * step one observation may add), per source (what each evidence class may grant, and how much per day) and per actor,
 * source, quest and window (how often observations are applied).
 */

/** From the least to the most trusted observer. An observation may only advance objectives that ask for its class or a weaker one. */
export const EVIDENCE_RANK: Readonly<Record<QuestEvidence, number>> = {
  CLIENT: 0,
  MAP_SCRIPT: 1,
  PARTNER: 2,
  SERVER: 3,
};

export function evidenceCovers(source: QuestEvidence, required: QuestEvidence): boolean {
  return EVIDENCE_RANK[source] >= EVIDENCE_RANK[required];
}

/** The most one reward rule may be worth when its least trusted evidence is this class. A client-observed action is low stakes. */
export const MAX_REWARD_VALUE_BY_EVIDENCE: Readonly<Record<QuestEvidence, number>> = {
  CLIENT: 10,
  MAP_SCRIPT: 25,
  PARTNER: 50,
  SERVER: 1000,
};

/** The most an actor may be granted per UTC day from observations of one class, across every quest. */
export const DAILY_GRANT_BUDGET_BY_EVIDENCE: Readonly<Record<QuestEvidence, number>> = {
  CLIENT: 100,
  MAP_SCRIPT: 250,
  PARTNER: 500,
  SERVER: 100_000,
};

/** The largest threshold an objective may ask for, by aggregation. */
export const MAX_THRESHOLD_BY_AGGREGATION: Readonly<Record<QuestAggregation, number>> = {
  STATE: 1,
  UNIQUE_SET: 1_000,
  EVENT_COUNT: 10_000,
  DURATION: 24 * 60 * 60,
  COUNTER: 10_000,
};

/** The most one observation may add to a duration (seconds) or a counter (units). */
export const MAX_DURATION_STEP_SECONDS = 60 * 60;
export const MAX_COUNTER_STEP = 100;

/** Applications per actor, source class and quest inside the window; observations past it are recorded but not applied. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMIT_MAX_APPLICATIONS = 120;

/** How far in the future or past an observation may claim to have happened, relative to when it is received. */
export const MAX_OCCURRED_AT_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_OBJECTIVES_PER_VERSION = 20;
export const MAX_REWARD_RULES_PER_VERSION = 10;
export const MAX_ACTIVE_PROGRESS_PER_ACTOR = 200;

export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_SUBJECT_LENGTH = 128;
