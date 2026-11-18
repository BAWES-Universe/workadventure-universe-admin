/**
 * A Brick's computer (game #2000, Brick 9): the words the database holds and the rules that need no database.
 *
 * One lasting computer per Brick. Jobs for a Brick queue on it, and only one job WRITES at a time. There is no switch per
 * person: every member can give their own Bricks a computer, inside the allowance of the meter (game #1998).
 */

/**
 * Where the machine is, as stored. `none` is a computer that was given and not made yet: it is made at the first real need. `stopping` is one
 * that must be put to sleep and is not yet proved asleep: nothing uses it, and every sweep tries again until the provider says it is not running. `packing` is one being packed away into cold storage (its copy is made and proved before it is deleted); `cold` is one that is gone and only its copies remain.
 */
export const MACHINE_STATES = ['none', 'waking', 'resting', 'working', 'cold', 'broken', 'restoring', 'stopped', 'stopping', 'packing'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

export const JOB_STATUSES = ['queued', 'running', 'waiting', 'done', 'stopped', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Why a job that is not running yet is queued. `allowance` is the one that leads to "Ask for more"; the others are "wait in line". */
export const QUEUED_FOR = ['turn', 'allowance', 'busy', 'pool'] as const;
export type QueuedFor = (typeof QUEUED_FOR)[number];

/** Why a job stopped before it finished. `unanswered`: it waited for a person to take over and nobody did within the wait a super admin set. `rule`: a rule the person said in chat (no more than $1 a month, only my own accounts) did not let it take more room. */
export const ENDED_BY = ['person', 'allowance', 'pool', 'off', 'deleted', 'error', 'unanswered', 'rule'] as const;
export type EndedBy = (typeof ENDED_BY)[number];

/**
 * A job that ended on our side, so none of what it ran is the person's: it failed, or it was stopped by an error (the machine would not
 * start or could not be reached, the agent's turn broke, the worker was lost and its room lapsed). The books and Activity both ask this,
 * so the two cannot disagree. Everything else that ends a job (done, stopped by the person, out of room, nobody answered) is theirs.
 */
export const givenBackJob = (status: string, endedBy: string | null | undefined): boolean => status === 'failed' || (status === 'stopped' && endedBy === 'error');

/** What a job waits for: the person's step. */
export const WAITING_FOR = ['details', 'signin', 'upload', 'pay', 'submit', 'answer'] as const;
export type WaitingFor = (typeof WAITING_FOR)[number];

/** What a job can do outside its own computer. */
export const EFFECT_KINDS = ['send', 'publish', 'details', 'upload', 'pay', 'submit'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/**
 * Brick hands over BEFORE the first step that sends the person's details, signs in, uploads, pays or submits (plan N1, F2). So
 * these four are never Brick's own step while it has the mouse: paying and submitting are the person's, always, and details
 * and uploads are only done after the person has taken over and asked for it ("Fill in my details").
 */
export const PERSON_ONLY: readonly EffectKind[] = ['pay', 'submit'];
export const AFTER_TAKE_OVER: readonly EffectKind[] = ['details', 'upload'];

export const isMachineState = (value: unknown): value is MachineState => typeof value === 'string' && (MACHINE_STATES as readonly string[]).includes(value);
export const isWaitingFor = (value: unknown): value is WaitingFor => typeof value === 'string' && (WAITING_FOR as readonly string[]).includes(value);
export const isEffectKind = (value: unknown): value is EffectKind => typeof value === 'string' && (EFFECT_KINDS as readonly string[]).includes(value);

/** A job on this status still holds its place on the machine. */
export const HOLDS_MACHINE: readonly JobStatus[] = ['running', 'waiting'];

/** A job is over. */
export const isOver = (status: string): boolean => status === 'done' || status === 'stopped' || status === 'failed';

/** What an awake machine costs for the seconds it was held, in millionths of a dollar. Null when the provider has not said what a minute costs. */
export function costOfSeconds(seconds: number, microsPerMinute: number | null): number | null {
  if (microsPerMinute === null) return null;
  return Math.max(0, Math.round((Math.max(0, seconds) * microsPerMinute) / 60));
}

/**
 * Room for the next stretch of a running job: what the machine costs for `minutes`, at least 1 so room is always a real amount.
 * A rate that is not known reserves the least there can be, and the cost is then recorded as unknown, never as 0.
 */
export function roomFor(minutes: number, microsPerMinute: number | null): number {
  return Math.max(1, Math.ceil(minutes * (microsPerMinute ?? 0)));
}

/** The longest one cold-storage run (a pack-away, a proof, a drill) may last: a run still open after this long was stopped with its server, and is closed at this length. */
export const COLD_RUN_MAX_MS = 6 * 60 * 60 * 1000;

// ---------- Limits the model relay reads (contract v2) ----------

/**
 * The computer Limits the game's model relay no longer fixes in code (contract v2, section 1.1): the longest answer a call may be allowed, how
 * many calls one job may have in flight, and the longest total wait for `busy` and `holds`. They are saved settings, read on every call and in
 * effect at once; the values below are what is served until a super admin saves others (today's values in the game).
 */
export interface ComputerLimits {
  maxOutputTokens: number;
  maxCallsInFlight: number;
  maxWaitSeconds: number;
}

export const COMPUTER_LIMITS_DEFAULT: ComputerLimits = { maxOutputTokens: 32_768, maxCallsInFlight: 8, maxWaitSeconds: 600 };

/** The values that can be saved: they are not limits on anyone's money, only on how a step is sized and how long a refused step waits. */
export const COMPUTER_LIMITS_RANGES: Record<keyof ComputerLimits, { min: number; max: number }> = {
  maxOutputTokens: { min: 1, max: 10_000_000 },
  maxCallsInFlight: { min: 1, max: 1_000 },
  maxWaitSeconds: { min: 1, max: 86_400 },
};

/** The Limits as saved: each value that is there and fits, the served default for the rest. */
export function readComputerLimits(saved: unknown): ComputerLimits {
  const out: ComputerLimits = { ...COMPUTER_LIMITS_DEFAULT };
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return out;
  const record = saved as Record<string, unknown>;
  for (const key of Object.keys(COMPUTER_LIMITS_RANGES) as (keyof ComputerLimits)[]) {
    const value = record[key];
    const range = COMPUTER_LIMITS_RANGES[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max) out[key] = value;
  }
  return out;
}

/** A change to the Limits: only known names, each inside its range. */
export function checkComputerLimits(input: unknown): { ok: true; value: Partial<ComputerLimits> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<ComputerLimits> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(COMPUTER_LIMITS_RANGES, key)) return { ok: false, error: `Unknown limit: ${key}` };
    const range = COMPUTER_LIMITS_RANGES[key as keyof ComputerLimits];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.min || value > range.max) {
      return { ok: false, error: `${key} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    }
    out[key as keyof ComputerLimits] = value;
  }
  return { ok: true, value: out };
}

/** The reasons a refused model step is answered with in contract version 2 (version 1 knows only refused, allowance, pool and rule). */
export const STEP_REFUSALS = ['refused', 'allowance', 'budget', 'funds', 'busy', 'holds', 'rule', 'unpriced', 'unsupported', 'paused'] as const;
export type StepRefusal = (typeof STEP_REFUSALS)[number];

/** Refusals where waiting helps: the game asks again with the same operation id. */
export const WAITING_HELPS: readonly StepRefusal[] = ['busy', 'holds'];

/** Refusals that save and pause a running job (it is truly out, and the sweep resumes it once the reason clears). */
export const PAUSES_JOB: readonly StepRefusal[] = ['allowance', 'budget', 'funds'];
