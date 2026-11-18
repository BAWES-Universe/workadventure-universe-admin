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
 * Who a failed job's ending is down to, when the computer's own runner reports it. `ours`: the relay was not there, the preparing broke, the
 * agent's turn broke three times in a row, the stream broke. `agent`: the agent wrote that it could not go on, or it hit its turn cap: the
 * job ran, and its time is the person's like any other run. A runner that says nothing is `agent`, so nothing is given back on its word alone.
 */
export const FINISH_CAUSES = ['ours', 'agent'] as const;
export type FinishCause = (typeof FINISH_CAUSES)[number];

/**
 * A job that ended on our side, so none of what it ran is the person's: Orbit itself saw it break (the machine would not start or could
 * not be reached, the worker was lost and its room lapsed) or the runner said the cause was ours. Those are written `ended_by = 'error'`.
 * A failure the runner reports without that cause (the agent gave up, the turn cap) is `failed` with no ending, and is the person's.
 * The books and Activity both ask this, so the two cannot disagree.
 */
export const givenBackJob = (status: string, endedBy: string | null | undefined): boolean => (status === 'failed' || status === 'stopped') && endedBy === 'error';

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

/**
 * The endings Brick never tells the person about, because they just did it themselves: their own Stop, the computer turned off, the Brick
 * deleted. Every other ending is said once in their chat with the Brick (the report back).
 */
export const silentEnding = (endedBy: string | null): boolean => endedBy === 'person' || endedBy === 'off' || endedBy === 'deleted';

/** Why a report can never be delivered: nobody to deliver it to, not allowed to, the conversation it began in is gone, or the chat turned it down. */
export const UNDELIVERABLE_WHY = ['no_chat', 'not_allowed', 'origin_gone', 'refused'] as const;
export type UndeliverableWhy = (typeof UNDELIVERABLE_WHY)[number];
