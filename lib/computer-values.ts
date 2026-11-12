/**
 * A Brick's computer (game #2000, Brick 9): the words the database holds and the rules that need no database.
 *
 * One lasting computer per Brick. Jobs for a Brick queue on it, and only one job WRITES at a time. There is no switch per
 * person: every member can give their own Bricks a computer, inside the allowance of the meter (game #1998).
 */

/** Where the machine is, as stored. `none` is a computer that was given and not made yet: it is made at the first real need. */
export const MACHINE_STATES = ['none', 'waking', 'resting', 'working', 'cold', 'broken', 'restoring', 'stopped'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

export const JOB_STATUSES = ['queued', 'running', 'waiting', 'done', 'stopped', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Why a job that is not running yet is queued. `allowance` is the one that leads to "Ask for more"; the others are "wait in line". */
export const QUEUED_FOR = ['turn', 'allowance', 'busy', 'pool'] as const;
export type QueuedFor = (typeof QUEUED_FOR)[number];

/** Why a job stopped before it finished. */
export const ENDED_BY = ['person', 'allowance', 'pool', 'off', 'deleted', 'error'] as const;
export type EndedBy = (typeof ENDED_BY)[number];

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
