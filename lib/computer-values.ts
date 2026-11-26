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
export const QUEUED_FOR = ['turn', 'allowance', 'busy', 'pool', 'paused'] as const;
/** Why a job is paused: the owner's own Pause; the month's computer time ran out (`allowance`) or a spending limit the person set was reached (`rule`): those two carry on by itself when more arrives. */
export const PAUSED_WHY = ['person', 'allowance', 'rule'] as const;
export type PausedWhy = (typeof PAUSED_WHY)[number];
export type QueuedFor = (typeof QUEUED_FOR)[number];
/** The line skips a paused job: `queued_for` is null (a job just made) or any reason but `paused`. Written out because `NOT queued_for = 'paused'` is never true for a null. */
export const NOT_PAUSED = { OR: [{ queuedFor: null }, { queuedFor: { not: 'paused' } }] };

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

/** What a failure the runner calls ours rests on, for Orbit to check itself (GPT audit finding 5): `browser_shared` = Orbit kept answering the job's hand-over `browser_shared` until the runner gave up. */
export const FINISH_BASES = ['browser_shared'] as const;
export type FinishBasis = (typeof FINISH_BASES)[number];

/**
 * A job that ended on our side, so none of what it ran is the person's: Orbit itself saw it break (the machine would not start or could
 * not be reached, the worker was lost and its room lapsed) or the runner said the cause was ours. Those are written `ended_by = 'error'`. A job our own pool or envelope cut off mid-run (`ended_by = 'pool'`) is ours too, and kept as `pool` so the person is told it was our computers that were busy.
 * A failure the runner reports without that cause (the agent gave up, the turn cap) is `failed` with no ending, and is the person's.
 * The books and Activity both ask this, so the two cannot disagree.
 */
export const givenBackJob = (status: string, endedBy: string | null | undefined): boolean => (status === 'failed' || status === 'stopped') && (endedBy === 'error' || endedBy === 'pool');

/**
 * "Try again" of an ended job carries on in that job's agent conversation (piece 8) only after an ending that was not the person's own doing: a failure that was ours (`error`), our pool or envelope
 * cutting it off (`pool`), nobody answering its question in time (`unanswered`), and the month or a spending limit ending it (`allowance`, `rule`: endings from before those paused instead). The person's
 * own Stop or Cancel (`person`), a computer turned off (`off`) and a Brick deleted (`deleted`) are a fresh job, and so is a job that finished (`done`) and one that never ran (no conversation). A failure
 * the agent itself gave (`failed` with no ending word) carries on too (Fable's ruling, 23 Nov): Brick's report of it already offers to try again with what the computer kept. ONE list, read by the
 * start (which re-checks every ask) and by the look the game makes before it asks.
 */
export const CONTINUES_AFTER: readonly EndedBy[] = ['error', 'pool', 'unanswered', 'allowance', 'rule'];
export const continuableEnding = (status: string, endedBy: string | null | undefined): boolean => endedBy ? (status === 'failed' || status === 'stopped') && (CONTINUES_AFTER as readonly string[]).includes(endedBy) : status === 'failed';

/** What a job waits for: the person's step. */
export const WAITING_FOR = ['details', 'signin', 'upload', 'pay', 'submit', 'answer'] as const;
export type WaitingFor = (typeof WAITING_FOR)[number];

/**
 * The waits that put the person's own things into the browser or onto the disk (their details, a sign-in, a file, a payment, a form sent in their name): the job asking for one must have
 * the computer to itself, or another job beside it could read what the person put in. Only `answer`, a question in words, is left out (GPT audit finding 5, Opus design 26 Nov).
 */
export const BROWSER_ALONE: readonly WaitingFor[] = ['details', 'signin', 'upload', 'pay', 'submit'];
export const needsBrowserAlone = (waitingFor: WaitingFor): boolean => BROWSER_ALONE.includes(waitingFor);

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

/**
 * The one reading of a job's status that the bot server and Orbit share for a start it looked up by its key: `live` (in line, running or waiting for its person: it can still do work), `done` (it finished) or `ended`
 * (it was stopped or failed). Not known (the look could not be made) is never one of these: it is the 503 `{ retry: true }` the lookup answers instead. Any status this does not know reads as `live`, the cautious one:
 * a caller never takes it for a job that is over.
 */
export type StartState = 'live' | 'done' | 'ended';
export const startStateOf = (status: string): StartState => (status === 'done' ? 'done' : status === 'stopped' || status === 'failed' ? 'ended' : 'live');

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

/**
 * The tag every turn sent to a job's agent starts with. The machine's local model address (the image's `universe-proxy`) finds it in a call's body and
 * passes the call on with THAT job's key, so two jobs that run at once on one machine (read-only jobs may) are each booked their own calls: their room, the
 * rules that count a task, and what is given back when one of them fails on our side. It is never authority: what a key may do comes from Orbit's records,
 * and a call with no tag, or one for a job the machine holds no key of, goes on the key last written.
 */
export const JOB_TAG_PREFIX = '[universe-job:';
export const JOB_TAG_NOTE = ' (a tag for the system, there is no need to repeat it)';
export const jobTagOf = (jobId: string): string => `${JOB_TAG_PREFIX}${jobId}]${JOB_TAG_NOTE}`;

/**
 * Every reason a start can be refused, and every one of them is answered as an ordinary success of the request (HTTP 200 `{ ok: false, reason }`): a refusal is a business answer, never an error status. Orbit never answers
 * a start with 429 (or any other non-200 status) for a refusal, so a 429 a caller sees on a start did not come from Orbit: an intermediary (a proxy, a gateway) said it, and the start's outcome is NOT known: look it up by its key.
 * A start that fails is 400 (the input is not valid), 401 (not the bot server) or 500 (Orbit could not do it): never with an `ok` field.
 */
export const START_REFUSALS = ['not_owner', 'off', 'not_open', 'broken_start', 'no_run', 'paused', 'cheaper_route', 'not_set', 'rule', 'expired', 'cannot_continue', 'retired', 'stale_consent', 'retired_by_game'] as const;

/**
 * How long one command on a machine may take: waiting for the machine's own lock, stopping the browser, moving a profile, starting the browser
 * again and waiting for it to answer (lib/computer-browser-profile-script.ts).
 */
export const MACHINE_COMMAND_MS = 150_000;

/**
 * How long a machine's cleanup claim is believed. It MUST be longer than `MACHINE_COMMAND_MS`, or a claim taken for a long command goes stale
 * while that command still runs and a second one starts beside it: two commands stopping, moving and starting the same browser at once
 * (CodeRabbit N7 on #1025). One shared value, so the two places that take this claim (`withClaim` in lib/computer-browser-profile.ts, and the
 * cleanup claim and `untilCleaned` in lib/computer.ts) can never drift apart.
 */
export const CLEAN_CLAIM_STALE_MS = MACHINE_COMMAND_MS + 30_000;
