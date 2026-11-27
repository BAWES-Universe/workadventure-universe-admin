/**
 * Control of one computer job after it began (piece 1 of the computer job controls, 23 Nov): Pause, Resume, Do this next and Cancel, each for ONE job. Stop (`stopJobFor`) keeps its meaning: it ends everything, paused jobs included.
 *
 * A paused job is a job in line that the line skips until it is resumed: status `queued`, `queued_for` `paused`. So it holds no room and costs nothing, Stop still ends it, and every rule for a job in line
 * already applies to it. Pausing a job that held the machine (it ran, or waited for its person) is an AUTHORITY action under the ownership rules (lib/computer-owner):
 *  - Rule A. It is decided in ONE transaction under the job's cutoff lock with its row locked: the time so far is counted and its room settled at that (the person's, like a Stop: never given back), the job goes back in
 *    line holding nothing, its owner epoch and lease version move (every request of the worker that ran it is `superseded` from that commit on) and every model key of the job ends.
 *  - Rule B. A job whose finish is already kept, or that Orbit decided to end for its own capacity, is not paused (`ending`): the finalizer owns its ending.
 *  - Rule C. The agent's turn is cancelled only AFTER that commit, and only the turn that commit read. Nothing is sent to the provider under a lock.
 * The person holding the screen cannot pause (`taken_over`): they hand it back first, or Stop.
 *
 * Each pause of a running job is kept as a row (computer_job_pauses) with the seconds it ran and the room it settled, and is written to the books as its own event (`computer:<job>:time:<n>`) right after the commit;
 * one that did not get there is written by the sweep (`bookMissingPauses`). The job's own `seconds_run` starts again from 0, so the job's ending writes only the time since it last started (`computer:<job>:time`, as
 * for any job), and no second is ever written twice. `seconds_billed` keeps what its pauses wrote, so the job's whole time is `seconds_run + seconds_billed`.
 *
 * Resume puts the job first in line and tries it at once: it runs again with a NEW reservation through the normal start (a computer that is cold is brought back), and its runner claims it afresh (a new epoch).
 * If it cannot start now it stays first in line. If the person's month or a limit they set does not let it start, it stays paused and says why (`allowance` / `rule`).
 *
 * One control, one effect (GPT round 6, finding 4; lib/computer-commands): every control given with a command id keeps it in `computer_job_commands` with what it came to. Pause, Resume and "do this first" write the
 * row under the job's locks in the transaction that decides them (after the locks, the order used everywhere), so the same id again answers what the first decided and writes nothing, whatever the job did since.
 * Cancel commits its row first, naming its job, and ends it through the finalizer's own transactions. The library still takes a control without one (its own callers); every route asks for it.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { brickOf, computerView, controlInternals, notStartedYet, provedAtOf, provedSecondsOf, providerFor, settleTurnHold, type ComputerView } from '@/lib/computer';
import { lockJob } from '@/lib/computer-owner';
import { pauseWhenRowFree, takeRowOrYield } from '@/lib/computer-power';
import { hasFinishIntent, hasPoolCutoff } from '@/lib/computer-faults';
import { revokeJobTokens } from '@/lib/computer-token';
import { settleRoomIn } from '@/lib/meter-allowance';
import { pinnedMicrosPerMinute } from '@/lib/spend-rules-values';
import { costOfSeconds, isOver, type PausedWhy } from '@/lib/computer-values';
import { dropProfile, parkProfile, settlePark, signInsKept } from '@/lib/computer-browser-profile';
import { grantsPrintIn, tellIn } from '@/lib/computer-tellings';
import { releaseIfUnheld } from '@/lib/computer-control';
import type { ComputerProvider as Provider } from '@/lib/computer-provider';
import { claimCommand, claimCommandIn, commandRow, decidedOfCommand, keepFinalOutcome, keepOutcome, refuseUnder, resumeOutcomeFrom, seenCommand, settlePendingResumesIn, stretchOfCommand, type Claimed, type Command, type CommandKind, type CommandRow, type StoredOutcome } from '@/lib/computer-commands';

/** Why a control was not done. `not_found`: not the owner's Brick, or no such job on it. `over`: the job already ended. `taken_over`: the person has the screen. `ending`: its ending is already decided. `not_paused` / `not_queued`: the job is not in the state the tap was for. `allowance` / `rule`: a resume the person's month, or a limit they set, does not let start (the job stays paused). `not_ready`: it carried on but its browser could not be settled, so the sweep is still working on it (finding 7). `started`: a Cancel that carried `expected: 'not_started'` found the job started since the person was asked: nothing was cancelled. `not_ended`: a Cancel's ending did not finish (the job is still live after its bounded tries): nothing is kept as done, the command stays pending, and the same command id asked again ends it (CodeRabbit on #1025, N11 of the d522f4b3 pass). */
export type ControlRefusal = 'not_found' | 'over' | 'taken_over' | 'ending' | 'not_paused' | 'not_queued' | 'allowance' | 'rule' | 'not_ready' | 'command_reused' | 'not_ended' | 'started';
/** `command_reused`: the control's command id was already used for another control (another job, kind or argument): refused, nothing written (finding 4). `signInsKept` is said only when a job that held the machine was paused: false when its sign-ins could not be put away (it will need them again when it carries on). */
export type Controlled = { ok: true; view: ComputerView; signInsKept?: boolean } | { ok: false; reason: ControlRefusal };

const SECOND = 1000;
const TX = { timeout: 15_000, maxWait: 15_000 } as const;

/** The event a pause writes its time under: one per pause, so asked twice it is the same event. */
export const pauseEventId = (jobId: string, n: number): string => `computer:${jobId}:time:${n}`;

/** The job on this Brick, or null. */
async function jobOnBrick(botId: string, jobId: string) {
  return prisma.computerJob.findFirst({ where: { id: jobId, botId }, select: { id: true, botId: true, status: true, queuedFor: true, pauses: true, stepDone: true } });
}

/** The highest rank in the Brick's line now (0 when nobody is ahead). */
async function topRank(db: Pick<typeof prisma, 'computerJob'>, botId: string): Promise<number> {
  const top = await db.computerJob.aggregate({ where: { botId, status: 'queued' }, _max: { queueRank: true } });
  return top._max.queueRank ?? 0;
}

async function viewOf(botId: string, ownerId: string, now: Date): Promise<Controlled> {
  const view = await computerView(botId, ownerId, now);
  return view ? { ok: true, view } : { ok: false, reason: 'not_found' };
}

/** A command seen before (finding 4): its stored outcome, with the computer as it stands NOW; nothing is written. `command_reused` for an id used for another control. */
async function answerOf(botId: string, ownerId: string, seen: Exclude<Claimed, { fresh: true }>, now: Date): Promise<Controlled> {
  if ('reused' in seen) return { ok: false, reason: 'command_reused' };
  const outcome = seen.replay;
  if (outcome && !outcome.ok) return { ok: false, reason: outcome.reason as ControlRefusal };
  const view = await viewOf(botId, ownerId, now);
  return view.ok && outcome?.ok && outcome.signInsKept !== undefined ? { ...view, signInsKept: outcome.signInsKept } : view;
}

/** What a refusal is kept as. */
const refusalOutcome = (reason: ControlRefusal): StoredOutcome => ({ ok: false, reason });

/**
 * A refusal found before the control's transaction, kept under its command (when it has one) so the same command always answers the same; a copy that got there first answers instead. When that copy claimed the command but has not
 * answered yet, this one waits (as long as a Resume copy does) for the final answer and gives it; if none comes, it is refused as it saw the job when it looked, and nothing is stored: it never answers the computer view, which reads as done
 * (CodeRabbit on #1038).
 */
async function refused(botId: string, ownerId: string, under: { command: Command; row: CommandRow } | null, reason: ControlRefusal, now: Date): Promise<Controlled> {
  if (!under) return { ok: false, reason };
  const claimed = await refuseUnder(under.command, under.row, reason);
  if ('fresh' in claimed) return { ok: false, reason };
  if ('replay' in claimed && claimed.replay === null) {
    const began = Date.now();
    for (;;) {
      const seen = await seenCommand(under.command, under.row);
      if (seen && ('reused' in seen || seen.replay !== null)) return answerOf(botId, ownerId, seen, now);
      if (Date.now() >= began + resumeWait.ms) return { ok: false, reason };
      await new Promise((resolve) => setTimeout(resolve, resumeWait.stepMs));
    }
  }
  return answerOf(botId, ownerId, claimed, now);
}

/** How long a copy of a Resume waits for the first request's own answer before it settles the command itself (the first request may have stopped after its commit). Exported for the tests. */
export const resumeWait = { ms: 20_000, stepMs: 100, /** The longest a copy waits in all for a start that has not reached its decision; after that it answers `not_ready` and stores nothing (the same command asked again decides it). */ capMs: 5 * 60_000 };

/** What a Resume came to, from the job as it stands after ITS OWN start was tried: the refusal the month or a limit made of the start, a browser that could not be settled, or success (a job that stays in line is a success: the resume was taken). */
async function resumeOutcomeOf(jobId: string, stretch: number | null = null): Promise<StoredOutcome> {
  const after = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, queuedFor: true, pausedWhy: true, prepState: true, pauses: true } });
  return resumeOutcomeFrom(after, stretch);
}

/**
 * The same, read by a COPY of a Resume whose first request has not answered: what the Resume's OWN start attempt recorded on its command the moment its try returned (`recordResumeDecision`), and null while it has recorded
 * nothing. Never read from the job: another try of the same job (the queue sweep decides for the same place in line), a newer Resume, a pause or a Cancel changes the job, and a success stored from it could be a start that the month
 * refuses a moment later, or another attempt's outcome (CodeRabbit on #1025, A10, and the d522f4b3 pass, N6, N21, N22, N23).
 */
async function resumeDecidedOf(command: Command, jobId: string): Promise<StoredOutcome | null> {
  const recorded = await decidedOfCommand(command);
  if (recorded) return recorded;
  // The "a restoring job waits for a decision" rule below holds only for a job that is still LIVE: once the job ends, every ending settles its pending Resumes first (`settlePendingResumesIn`, final), so nothing stays pending for good (N7).
  // Nothing recorded: the first request stopped inside its start. A job that RUNS (or waits for the person after running) with its browser settled cannot be refused by that start any more (a start finding it running changes nothing), so it is read as it stands; a job still
  // in line, paused or restoring waits for a decision (a try that is not this Resume's never decides it, N21)
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, queuedFor: true, pausedWhy: true, prepState: true, pauses: true } });
  return (job?.status === 'running' || job?.status === 'waiting') && job.prepState === null ? resumeOutcomeFrom(job, await stretchOfCommand(command)) : null;
}

/** Keeps the Resume's final outcome over its pending mark, once: the first write wins (a copy that settled the command meanwhile, or the request itself), and the stored outcome is what is returned. */
async function settleResume(command: Command, outcome: StoredOutcome): Promise<StoredOutcome> {
  const written = await prisma.$executeRaw`UPDATE "computer_job_commands" SET "outcome" = ${JSON.stringify(outcome)}::jsonb WHERE "command_id" = ${command.id}::uuid AND "outcome"->>'pending' = 'true'`;
  if (written === 1) return outcome;
  const rows = await prisma.$queryRaw<Array<{ outcome: StoredOutcome | null }>>`SELECT "outcome" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  return rows[0]?.outcome ?? outcome;
}

/**
 * A copy of a control seen while the first request has not kept its answer (a Resume whose start is still being tried, a Pause whose browser is still being put away): it never answers success for what may still turn
 * into a refusal or lose its sign-ins, and never does anything itself. It waits for the first request's answer; if none comes in time (the first request stopped after its commit), it settles the command from `settleFrom`,
 * once, and answers that (CodeRabbit on #1025, 16, 23 and 51).
 */
async function answerPendingCommand(botId: string, ownerId: string, under: { command: Command; row: CommandRow }, settleFrom: () => Promise<StoredOutcome | null>, now: Date): Promise<Controlled> {
  const began = Date.now();
  for (;;) {
    const seen = await seenCommand(under.command, under.row);
    if (!seen || 'reused' in seen || seen.replay !== null) return seen ? answerOf(botId, ownerId, seen, now) : viewOf(botId, ownerId, now);
    if (Date.now() >= began + resumeWait.ms) {
      // The first request has not answered in time: the command is settled from what the job came to, once. A start that has not reached its decision settles nothing: the copy goes on waiting, and past the cap it answers
      // that the job is not ready yet and stores nothing (the same command asked again reads it again)
      const from = await settleFrom();
      if (from) return answerOf(botId, ownerId, { replay: await settleResume(under.command, from), targets: null }, now);
      if (Date.now() >= began + resumeWait.capMs) return { ok: false, reason: 'not_ready' };
    }
    await new Promise((resolve) => setTimeout(resolve, resumeWait.stepMs));
  }
}

/**
 * What a command that is still pending came to. A Pause (or "do this first") that paused jobs lists them in its pending mark, each with the number of the pause it took: what each of those pauses kept of the sign-ins is read
 * from exactly that row; a row that has not recorded it yet (null) keeps the command pending (CodeRabbit on #1025, O45): a recorded false means that pause put no browser away, and the sign-ins are needed again when the job carries on. A command with no jobs listed is a Resume (a "do this first" aimed at a paused job is its resume): it is read as one.
 */
async function pendingOutcomeOf(command: Command, jobId: string): Promise<StoredOutcome | null> {
  const rows = await prisma.$queryRaw<Array<{ outcome: StoredOutcome | null }>>`SELECT "outcome" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  const outcome = rows[0]?.outcome;
  const listed = outcome && outcome.ok && outcome.targets && outcome.targets.length > 0 ? outcome : null;
  if (!listed) return resumeDecidedOf(command, jobId);
  const pauses = listed.held ?? [];
  const wanted = pauses.length > 0 ? pauses : (listed.targets ?? []).map((id) => ({ jobId: id, n: null as number | null }));
  let kept: boolean | undefined;
  for (const one of wanted) {
    const row = one.n === null ? await prisma.computerJobPause.findFirst({ where: { jobId: one.jobId }, orderBy: { n: 'desc' }, select: { signInsKept: true } }) : await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId: one.jobId, n: one.n } }, select: { signInsKept: true } });
    // A pause whose sign-ins outcome is not recorded yet (`null`: the parking request has not written it) is not a `false`: the command is still pending, and the copy keeps waiting (after the cap it answers `not_ready` and stores nothing).
    // A `false` that was recorded keeps its meaning: that pause put no browser away (CodeRabbit on #1025, O45)
    if (row && row.signInsKept === null) return null;
    kept = (kept ?? true) && row?.signInsKept === true;
  }
  return kept === undefined ? { ok: true } : { ok: true, signInsKept: kept };
}

/** The command of a control, and the row it is kept under. */
const underOf = (command: Command | undefined, botId: string, ownerId: string, jobId: string, kind: CommandKind, args: Record<string, unknown> = {}, stretch: number | null = null) =>
  command ? { command, row: commandRow(botId, ownerId, jobId, kind, args, stretch) } : null;

/** What a pause decided, as its command keeps it (the person's own Pause: the same words `pauseJob` answers). */
const decisionOutcome = (decided: PauseDecision): StoredOutcome => {
  if (decided.kind === 'held' || decided.kind === 'queued' || decided.kind === 'already') return { ok: true };
  if (decided.kind === 'not_found' || decided.kind === 'over' || decided.kind === 'taken_over' || decided.kind === 'ending') return refusalOutcome(decided.kind);
  return refusalOutcome('ending');
};

export type PauseResult =
  | { ok: true; kind: 'held'; n: number; signInsKept: boolean }
  | { ok: true; kind: 'queued' | 'already' }
  | { ok: false; reason: 'not_found' | 'over' | 'taken_over' | 'ending' | 'superseded' };

export interface PauseOptions {
  /** "Do this first": the job goes back in line at this rank as a job WAITING (not paused), so it carries on by itself after the job put ahead of it, however that one ends. */
  backInLine?: { rank: number };
  /** Only while this worker still owns the job (a pause decided for a worker, such as the month running out in its renewal): another owner's job is left alone (`superseded`). Left out for the person's own tap. */
  ownerEpoch?: number;
  /** Only while the job is still on this control generation (a take-over and a hand back each move it): a pause decided from something read earlier (a machine found asleep) is not made under a hand-over that came since (`changed`, CodeRabbit on #1040). */
  controlGeneration?: number;
  /** False when the caller moves the line itself afterwards. */
  advance?: boolean;
}

/** What a pause decided inside its transaction: nothing (and why), or the pause of a job that held the machine, with what the steps after the commit need. */
export type PauseDecision =
  | { kind: 'not_found' | 'over' | 'superseded' | 'taken_over' | 'ending' | 'already' | 'queued' | 'key_gone' | 'changed' }
  | { kind: 'held'; n: number; botId: string; responseId: string | null; turnHold: boolean; /** The person held the screen: it was taken back in this write (released after the commit) */ heldScreen: boolean; /** When the pause was decided (after every lock was held): the steps after the commit, and the job that starts next on the machine, are dated from it, never from the ask */ at: Date };

export interface PauseInOptions extends PauseOptions {
  /**
   * The clock of a pause that may have waited for locks (`pauseWhenRowFree`): read once the pause holds every lock it needs, so the stretch it ends, its pause row and the next start are dated when the pause is WRITTEN, not when it
   * was asked (the job kept running meanwhile). Without it the pause is dated `now`.
   */
  clock?: () => Date;
  /** A pause decided for a refused model call: only while that call's key is still good and was made under the owner epoch the job has now (a delayed call of a worker that was replaced pauses nothing: `key_gone`). */
  key?: string;
  /** The person's own tap may pause a job waiting in line; a pause for the month or a limit is only ever for a job that holds the machine (one in line is left to the line). */
  heldOnly?: boolean;
  /**
   * The month or a limit only (Fable's ruling of 23 Nov, section 7): a job the person holds the screen of is paused too, never ended. The screen is taken back in the same write (the job is Brick's again, and the
   * computer goes back to Brick's once no job is left in the person's hands, as an ending does), the pause is marked `heldScreen`, it never carries on by itself, and on resume it asks the person for that step again.
   * Without it (the person's own Pause), a job whose screen the person holds is not paused (`taken_over`, decision 3a).
   */
  heldScreen?: boolean;
  /** The month or a limit only (finding 5, GPT round 6): what was refused, kept with the pause so it carries on by itself only once that fits (a model call's estimate, or the renewal's room). */
  blocked?: { kind: 'call' | 'renewal'; micros: number };
  /**
   * `machine` only (post-0.5.0 B): the machine was found asleep under the job. Its stretch ends at the last moment the machine was proved awake (`awake_proved_at`, or the readiness that began the stretch), never later: time
   * after that proof is not priced, and what the job had counted since that proof (a hand-over carries the stretch on in `seconds_run`) is dropped from it before anything is booked.
   */
  endAtProof?: boolean;
}

/** Why a pause row was written: a pause the person or their limits made, or `machine` (post-0.5.0 B): the machine was found asleep under the job, which goes back in line by itself and is never told or shown as a pause. */
export type PauseWhy = PausedWhy | 'machine';

/** A pause makes an unsaid `carried_on` untrue for good: it is let go in the pause's own transaction, so a manual restart never makes it say "carrying on" of a job the person paused in between (CodeRabbit on #1025, 57). */
async function staleCarriedOn(tx: Prisma.TransactionClient, jobId: string, now: Date): Promise<void> {
  await tx.computerJobTelling.updateMany({ where: { jobId, kind: 'carried_on', toldAt: null, undeliverableAt: null, staleAt: null }, data: { staleAt: now } });
}

/**
 * The pause itself, inside the caller's transaction (Rule A): the job's cutoff lock and row lock are taken here (taken again when the caller already holds them, which Postgres allows), everything is read under them, and every
 * write lands in this one commit: the stretch counted and its room settled at that room's own terms, the pause row, the job back in line holding nothing, its owner epoch and lease version moved, every model key ended,
 * and, for the month or a limit, what Brick is to tell the person. Nothing is sent to the provider here: the caller runs `afterPause` once this commits (Rule C).
 * `provider`: the Brick computer's provider, read BEFORE the transaction opened (a read that fails inside it would leave the transaction aborted).
 */
export async function decidePauseIn(tx: Prisma.TransactionClient, jobId: string, why: PauseWhy, asked: Date, provider: Provider | null, options: PauseInOptions = {}): Promise<PauseDecision> {
  // A machine pause is only ever a job sent back in line by itself, from the room the job held; it never becomes the job's own `paused_why`
  if (why === 'machine' && !options.backInLine) throw new Error('A machine pause always goes back in line');
  let now = asked;
  const row = await lockJob(tx, jobId);
  if (!row) return { kind: 'not_found' };
  if (isOver(row.status)) return { kind: 'over' };
  if (options.ownerEpoch !== undefined && row.ownerEpoch !== options.ownerEpoch) return { kind: 'superseded' };
  if (options.controlGeneration !== undefined && row.controlGeneration !== options.controlGeneration) return { kind: 'changed' };
  if (row.status === 'queued') {
    if (options.heldOnly) return { kind: 'already' };
    if (options.backInLine) return { kind: 'already' };
    const inLine = await tx.computerJob.findUnique({ where: { id: jobId }, select: { queuedFor: true, pausedWhy: true } });
    // A Resume of this job that is still pending is settled from the job as it stands BEFORE a pause changes its place or its reason (a person's Pause of a job the month paused makes it theirs): what each Resume came to is never
    // read from the pause's state afterwards (CodeRabbit on #1025, d522f4b3 pass, N23)
    await settlePendingResumesIn(tx, jobId);
    if (inLine?.queuedFor === 'paused') {
      // Finding 5 (GPT round 6): the person's own Pause of a job their month or a limit paused makes it THEIR pause, durably, under this lock: it never carries on by itself after this (only their Resume)
      if (why === 'person' && inLine.pausedWhy !== 'person') await tx.computerJob.update({ where: { id: jobId }, data: { pausedWhy: 'person', carryOnPending: false, leaseVersion: { increment: 1 } } });
      return { kind: 'already' };
    }
    // Never started (or waiting again): nothing is held, so nothing is counted; it only leaves the line until resumed
    await tx.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'paused', pausedAt: now, pausedWhy: why, leaseVersion: { increment: 1 }, carryOnPending: false } });
    await staleCarriedOn(tx, jobId, now);
    return { kind: 'queued' };
  }
  // Rule A: the person holding the screen hands it back first (their own Pause is not offered then); the month or a limit takes the screen back and pauses (section 7)
  const heldScreen = row.control !== 'brick';
  if (heldScreen && !(options.heldScreen && (why === 'allowance' || why === 'rule'))) return { kind: 'taken_over' };
  // Rule B: a kept finish or a decided cutoff owns the ending
  if ((await hasFinishIntent(tx, jobId)) || (await hasPoolCutoff(tx, jobId))) return { kind: 'ending' };
  // E3: a refused call pauses the job only while its own key is still good and is the current owner's (a key of before the epochs counts as epoch 0)
  if (options.key !== undefined) {
    const live = await tx.computerJobToken.count({ where: { id: options.key, jobId, revokedAt: null, expiresAt: { gt: now }, OR: [{ ownerEpoch: row.ownerEpoch }, ...(row.ownerEpoch === 0 ? [{ ownerEpoch: null }] : [])] } });
    if (live === 0) return { kind: 'key_gone' };
  }
  // From here the pause writes the Brick computer's row: it is taken now, without waiting, before the room is settled (post-0.5.0: pause during take-over; see `takeRowOrYield`)
  await takeRowOrYield(tx, row.botId);
  // Every lock is held now (the job's, the computer's row): the pause is dated this moment, not the ask or the start of the transaction (CodeRabbit on #1040)
  if (options.clock) now = options.clock();
  const job = await tx.computerJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { botId: true, secondsRun: true, secondsBilled: true, stretchStarted: true, reservationKey: true, startedAt: true, pauses: true, firstTurnSentAt: true, agentResponseId: true, awakeProvedAt: true },
  });
  const stretch = job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
  const counted = job.secondsRun + stretch;
  // Post-0.5.0 B: only the seconds the machine was proved awake. The stretch is one run from its readiness `began` (the hand-overs in between carry it on in `seconds_run`); the proof is the last renewal that read the machine
  // awake, or that readiness itself. Never more than was counted, never less than nothing
  const seconds = options.endAtProof ? provedSecondsOf(job, now, counted) : counted;
  // Only the proved seconds are priced: the price window ends at the proof (kept on the pause, so the books read the same one), a rate that changed after it never prices them (CodeRabbit on #1036)
  const pricedUntil = options.endAtProof && seconds < counted ? provedAtOf(job, now) : null;
  const n = job.pauses + 1;
  // The Resumes of this job still pending (their request stopped before it kept an answer) are settled NOW, from the job as it stands before this pause writes anything, under the job's lock: what each came to is recorded on its own
  // command, per attempt, while its browser state (`prep_state`) still belongs to it. A pause leaves `prep_state` as it is, and a later Resume sets it again, so read later it would be another attempt's: a restore that never settled would
  // answer success once the job ran and was paused again, and a ready Resume would answer a later restore's `not_ready` (CodeRabbit on #1025, d522f4b3 pass, N14). Written once: an answer already kept stays
  await settlePendingResumesIn(tx, jobId);
  // The time so far, priced as THIS stretch's room was held (its own terms: the same rule a job's ending uses), settles the room in this very commit: the unused part goes back at once
  if (job.reservationKey) {
    const lease = await tx.meterReservation.findUnique({ where: { reservationKey: job.reservationKey }, select: { terms: true } });
    const pinned = lease ? pinnedMicrosPerMinute(lease.terms, seconds, (pricedUntil ?? now).getTime()) : null;
    const cost = costOfSeconds(seconds, pinned ?? (provider ? provider.microsPerMinute() : null));
    await settleRoomIn(tx, { key: job.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now);
  }
  // A first turn that was sent and never named may still run with nothing to cancel it by: the machine is held until it is proved asleep (as a job's ending does), so nothing starts beside it
  const turnHold = !!job.firstTurnSentAt && !job.agentResponseId;
  if (turnHold) await tx.brickComputer.updateMany({ where: { botId: job.botId, turnUnprovenSince: null }, data: { turnUnprovenSince: now } });
  // The job's sign-ins are not put away yet: that happens after this commit (`afterPause`). From this very commit the machine carries the job's id as a park that has not finished, so a crash between the two
  // cannot let another job start on a browser that still holds this one's sign-ins: `tryStart` of any other job on this machine stays queued (`busy`) while it is set. `parkProfile` clears it, and the sweep
  // finishes a park nobody finished (GPT round 6, finding 7)
  // Another pause still waits for its browser to be put away (one command that pauses a writer and a looker): the browser is then NEVER put away under either name, it is emptied. The first pointer stays
  await tx.brickComputer.updateMany({ where: { botId: job.botId, parkPendingJobId: null }, data: { parkPendingJobId: jobId } });
  await tx.brickComputer.updateMany({ where: { botId: job.botId, NOT: [{ parkPendingJobId: null }, { parkPendingJobId: jobId }] }, data: { parkPendingWipe: true } });
  await tx.computerJob.update({
    where: { id: jobId },
    data: {
      status: 'queued',
      queuedFor: options.backInLine ? 'turn' : 'paused',
      pausedAt: options.backInLine ? null : now,
      pausedWhy: options.backInLine ? null : (why as PausedWhy),
      ...(options.backInLine ? { queueRank: options.backInLine.rank } : {}),
      pauses: n,
      // The time so far is the pause's (written below); the job counts again from 0 when it runs again
      secondsRun: 0,
      awakeProvedAt: null,
      secondsBilled: { increment: seconds },
      stretchStarted: null,
      reservationKey: null,
      // The agent's conversation is kept (`agent_session_id`): it carries on in it. The turn it was on is over
      agentResponseId: null,
      firstTurnSentAt: null,
      turnClaimedAt: null,
      prepareClaimedAt: null,
      waitingFor: null,
      readyWhat: null,
      readyWhere: null,
      handoverUntold: false,
      lastTriedAt: null,
      startDecidedAt: null,
      // The screen is taken back: the job is Brick's again (the computer itself goes back to Brick's after the commit, once no job is left in the person's hands)
      ...(heldScreen ? { control: 'brick' } : {}),
      ownerEpoch: { increment: 1 },
      leaseVersion: { increment: 1 },
      // The worker that held the job holds it no longer: its keys end here, so the hold that kept other workers out ends with them and the runner that carries the job on claims it at once (GPT round 6, finding 3)
      ownerLeaseUntil: null,
      carryOnPending: false,
    },
  });
  await revokeJobTokens(jobId, now, undefined, tx);
  // What the Brick's Apps were at this pause: the month or a limit carries the job on by itself only while they are the same (lib/computer-limit-pause)
  const grantsPrint = await grantsPrintIn(tx, job.botId);
  // What the month or a limit refused (finding 5): the sweep carries the job on only once that much fits again, so unchanged funds restart nothing
  const blocked = (why === 'allowance' || why === 'rule') && options.blocked ? { blockedKind: options.blocked.kind, blockedMicros: BigInt(Math.max(0, Math.round(options.blocked.micros))), blockedMonth: now.toISOString().slice(0, 7), blockedRuleRev: await ruleRevIn(tx, row.personId) } : {};
  await tx.computerJobPause.create({ data: { jobId, n, why, roomKey: job.reservationKey, seconds, startedAt: job.startedAt, at: now, pricedUntil, grantsPrint, heldScreen, ...blocked } });
  await staleCarriedOn(tx, jobId, now);
  // The month or a limit: Brick tells the person once, from this very commit (their own tap is never told back to them); a screen taken back says so, in place of the usual line
  if (!options.backInLine && (why === 'allowance' || why === 'rule')) await tellIn(tx, jobId, 'paused', why, now, { heldScreen });
  return { kind: 'held', n, botId: job.botId, responseId: job.agentResponseId, turnHold, heldScreen, at: now };
}

/** A digest of the person's own active spending limits (their ids, versions and amounts): kept with a limit's pause, for support (the room check decides whether it carries on). */
async function ruleRevIn(tx: Prisma.TransactionClient, personId: string): Promise<string> {
  const rules = await tx.spendRule.findMany({ where: { ownerPersonId: personId, state: 'active' }, select: { id: true, version: true, capMicros: true, period: true, covers: true }, orderBy: { id: 'asc' } });
  return createHash('sha256').update(rules.map((rule) => [rule.id, rule.version, rule.capMicros ?? '', rule.period ?? '', rule.covers].join('|')).join('\n')).digest('hex');
}

/**
 * The steps after a pause committed (Rule C), in this order: the turn the commit read is cancelled (that one only), the stretch is written to the books under its own event, where the browser went so far is kept, the job's
 * sign-ins are put away for it alone, the machine rests (or is proved asleep under a turn hold), and the line moves. None of it can undo the pause.
 */
export async function afterPause(jobId: string, decided: PauseDecision, asked: Date, options: PauseOptions = {}): Promise<PauseResult> {
  if (decided.kind !== 'held') {
    if (decided.kind === 'queued' || decided.kind === 'already') return { ok: true, kind: decided.kind };
    return { ok: false, reason: decided.kind === 'key_gone' || decided.kind === 'changed' ? 'superseded' : decided.kind };
  }
  const { botId, n } = decided;
  // Every step after the commit, and the job that starts next on the machine, is dated when the pause was decided, which is later than the ask when it waited for the computer's row: the next job's stretch never begins before the paused one's ends
  const now = decided.at;
  // Rule C: only now, and only the turn the commit read
  if (decided.responseId) await controlInternals.cancelAgentTurn(botId, decided.responseId);
  await bookPause(jobId, n, now);
  // Where its browser went so far is kept before anything can clear it
  await controlInternals.recordJobVisits({ id: jobId, botId, startedAt: (await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId, n } }, select: { startedAt: true } }))?.startedAt ?? null }, now);
  // Its sign-ins are put away for it alone, before anything else can run on the machine or it rests
  const parked = await parkProfile(botId, jobId, now, n).catch((error) => {
    console.error('[Computer] Could not put away a paused job’s browser:', error instanceof Error ? error.message : 'unknown');
    return null;
  });
  // The mark the pause left on the machine is settled here: put away, or the live browser emptied at once. Only if neither works does the machine go on waiting, and then nothing else starts
  // on it until the sweep settles the park — a paused job's sign-ins are never handed to the next job (GPT round 6, finding 7)
  await settlePark(botId, jobId, parked, now, n).catch((error) => console.error('[Computer] Could not settle a paused job’s browser:', error instanceof Error ? error.message : 'unknown'));
  // A screen taken back: the computer goes back to Brick's once no job is left in the person's hands, exactly as when a job the person held ends (the screen link ends with it)
  if (decided.heldScreen) await releaseIfUnheld(botId).catch((error) => console.error('[Computer] Could not take the screen back at a pause:', error instanceof Error ? error.message : 'unknown'));
  if (decided.turnHold) await settleTurnHold(botId);
  else await controlInternals.restIfUnheld(botId, now);
  if (options.advance !== false) await controlInternals.startNext(botId, now);
  return { ok: true, kind: 'held', n, signInsKept: parked ? signInsKept(parked) : false };
}

/**
 * Pauses one job, decided under its locks (see the head of this file). Exported for the other ways a job pauses (its month runs out). Safe to ask twice: a job already paused is left as it is (`already`).
 */
export async function pauseJobAs(jobId: string, why: PausedWhy, now: Date = new Date(), options: PauseInOptions = {}): Promise<PauseResult> {
  const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true } });
  if (!first) return { ok: false, reason: 'not_found' };
  // The provider's price is read before the transaction opens (a read that fails inside it would leave the transaction aborted)
  const provider = providerFor(await prisma.brickComputer.findUnique({ where: { botId: first.botId } }));
  // A take-over leader's stop may hold the computer's row, which this pause writes: the pause yields at once when it cannot take it and is tried again once the row is free (`pauseWhenRowFree`)
  const decided = await pauseWhenRowFree(first.botId, now, (clock) => prisma.$transaction((tx) => decidePauseIn(tx, jobId, why, now, provider, { ...options, clock }), TX));
  return afterPause(jobId, decided, now, options);
}

/**
 * Writes one pause's time to the books (once: the same event id, and the credit drawn under it once), then marks it booked. Only an event that is really there marks it: a write that failed is tried again by the sweep.
 * Never throws.
 */
export async function bookPause(jobId: string, n: number, now: Date = new Date()): Promise<boolean> {
  try {
    const pause = await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId, n } }, include: { job: { select: { botId: true, personId: true, runId: true } } } });
    if (!pause) return false;
    if (pause.bookedAt) return true;
    const eventId = pauseEventId(jobId, n);
    // A pause is the person's (their own Pause, or their month or their limit): never given back, so it is written as `paused` (no ending of ours)
    await controlInternals.recordComputerTime({ id: jobId, botId: pause.job.botId, personId: pause.job.personId, runId: pause.job.runId, startedAt: pause.startedAt, reservationKey: pause.roomKey }, pause.seconds, pause.at, { endedBy: null, status: 'paused' }, eventId, pause.pricedUntil);
    if (!(await prisma.meterEvent.findUnique({ where: { eventId }, select: { eventId: true } }))) return false;
    await prisma.computerJobPause.updateMany({ where: { id: pause.id, bookedAt: null }, data: { bookedAt: now } });
    return true;
  } catch (error) {
    console.error('[Computer] Could not write a pause’s time:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/** How long a pause is left to write its own time before the sweep writes it. */
const BOOK_GRACE_MS = 60_000;

/** The sweep: pauses whose time is not in the books yet (the server stopped between the pause and its write), oldest first. With `botId`, only that Brick's, and at once (before it is purged). */
export async function bookMissingPauses(now: Date, batch: number, botId?: string): Promise<number> {
  const due = await prisma.computerJobPause.findMany({
    where: { bookedAt: null, ...(botId ? { job: { botId } } : { at: { lte: new Date(now.getTime() - BOOK_GRACE_MS) } }) },
    orderBy: { at: 'asc' },
    take: batch,
    select: { jobId: true, n: true },
  });
  let booked = 0;
  for (const pause of due) if (await bookPause(pause.jobId, pause.n, now)) booked++;
  return booked;
}

const refusalOf = (result: PauseResult): Controlled | null => {
  if (result.ok) return null;
  return { ok: false, reason: result.reason === 'superseded' ? 'ending' : result.reason };
};

/**
 * Pause: the owner's tap or words. A job running or waiting for them (Brick in control) is paused with its time so far charged; a job in line just leaves the line until resumed.
 * `command` (finding 4): the tap's own id. Its row is written under the job's locks, in the transaction that decides the pause, with what it decided: the same id again answers that and writes nothing (no second
 * pause, stretch or time event, even after the job was resumed in between).
 */
export async function pauseJob(botId: string, ownerId: string, jobId: string, now: Date = new Date(), command?: Command): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const under = underOf(command, botId, ownerId, jobId, 'pause', {}, job.pauses);
  let result: PauseResult;
  if (under) {
    const seen = await seenCommand(under.command, under.row);
    if (seen) return 'reused' in seen || seen.replay !== null ? answerOf(botId, ownerId, seen, now) : answerPendingCommand(botId, ownerId, under, () => pendingOutcomeOf(under.command, jobId), now);
    // The provider's price is read before the transaction opens (a read that fails inside it would leave the transaction aborted)
    const provider = providerFor(await prisma.brickComputer.findUnique({ where: { botId } }));
    // A take-over leader's stop may hold the computer's row: the pause yields and is tried again once it is free (see `pauseWhenRowFree`)
    const done = await pauseWhenRowFree(botId, now, (clock) => prisma.$transaction(async (tx) => {
      // The job's locks first (the order used everywhere), then the command's row: a copy of this tap waits here for the first, then finds its row
      if (!(await lockJob(tx, jobId))) return { decided: { kind: 'not_found' } as PauseDecision };
      const claimed = await claimCommandIn(tx, under.command, under.row);
      if (!('fresh' in claimed)) return { seen: claimed };
      const decided = await decidePauseIn(tx, jobId, 'person', now, provider, { clock });
      // A pause of a job that held the machine is kept PENDING until its sign-ins are put away (after this commit): a copy never reads a success that does not yet say whether they were kept (CodeRabbit on #1025, 51). A pause that
      // only moved a job out of the line, or was refused, has nothing more to do: its answer is final here
      await keepOutcome(tx, under.command, decided.kind === 'held' ? { ok: true, pending: true, targets: [jobId], held: [{ jobId, n: decided.n }] } : decisionOutcome(decided));
      return { decided };
    }, TX));
    if (done.seen) return 'reused' in done.seen || done.seen.replay !== null ? answerOf(botId, ownerId, done.seen, now) : answerPendingCommand(botId, ownerId, under, () => pendingOutcomeOf(under.command, jobId), now);
    result = await afterPause(jobId, done.decided, now);
    if (result.ok && result.kind === 'held') {
      // Kept once over the pending mark: a copy that settled the command meanwhile has decided it, and that is what this returns too
      const final = await settleResume(under.command, { ok: true, signInsKept: result.signInsKept });
      result = { ...result, signInsKept: final.ok && final.signInsKept !== undefined ? final.signInsKept : result.signInsKept };
    }
  } else result = await pauseJobAs(jobId, 'person', now);
  const refusal = refusalOf(result);
  if (refusal) return refusal;
  const view = await viewOf(botId, ownerId, now);
  return view.ok && result.ok && result.kind === 'held' ? { ...view, signInsKept: result.signInsKept } : view;
}

/**
 * Resume: the paused job goes first in line and is tried at once, with a new reservation. It stays first in line when something else holds the computer. When the person's month, or a limit they set, does not let it
 * start, it stays paused and the answer says why (`allowance` / `rule`): it is the start that is refused, never the job.
 */
export async function resumeJob(botId: string, ownerId: string, jobId: string, now: Date = new Date(), command?: Command, as: { kind: CommandKind; args?: Record<string, unknown> } = { kind: 'resume' }): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const under = underOf(command, botId, ownerId, jobId, as.kind, as.args ?? {}, job.pauses);
  if (under) {
    const seen = await seenCommand(under.command, under.row);
    if (seen) return 'reused' in seen || seen.replay !== null ? answerOf(botId, ownerId, seen, now) : answerPendingCommand(botId, ownerId, under, async () => resumeDecidedOf(under.command, jobId), now);
  }
  let stretch: number | null = null;
  const moved = await prisma.$transaction(async (tx) => {
    const row = await lockJob(tx, jobId);
    if (!row) return 'not_found' as const;
    // The command's row after the job's locks, in the transaction that decides the resume (finding 4): a copy finds it and answers what this one decided. A resume that was taken is kept PENDING until its start has been tried: a copy
    // never reads a success the start may still turn into a refusal (CodeRabbit on #1025, 16 and 23)
    if (under) {
      // The pause number is read under the lock and stamped on the command: the fence its pending answer is read by (CodeRabbit on #1025, N1)
      const at = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { pauses: true } });
      stretch = at.pauses;
      const claimed = await claimCommandIn(tx, under.command, { ...under.row, stretch }, { ok: true, pending: true });
      if (!('fresh' in claimed)) return { seen: claimed };
    }
    const decided = isOver(row.status) ? ('over' as const) : await resumeIn(tx, botId, jobId, under?.command.id ?? null);
    if (under && decided !== 'ok') await keepOutcome(tx, under.command, refusalOutcome(decided));
    return decided;
  }, TX);
  if (typeof moved === 'object') return 'reused' in moved.seen || moved.seen.replay !== null ? answerOf(botId, ownerId, moved.seen, now) : answerPendingCommand(botId, ownerId, under!, async () => resumeDecidedOf(under!.command, jobId), now);
  if (moved !== 'ok') return { ok: false, reason: moved };
  await controlInternals.tryStart(jobId, now, { quiet: true, ...(under ? { decides: { commandId: under.command.id, stretch } } : {}) });
  // The month or a limit refused its start: tryStart put a job that ran before back as paused, with the reason. The start brings the job's own browser back before it answers, so a resume that got here has it: unless it could not
  // be settled (`recover`), and then the person is told so plainly. The sweep tries the restore again and empties the browser after the hours sign-ins are kept; until one of those works the job holds its room and its
  // place but is worked on by nobody (GPT round 6, finding 7)
  // What this Resume's own start came to was recorded the moment it returned: that is the answer, never the job as it stands now (a sweep, a newer Resume, a pause or a Cancel may have changed it since)
  const outcome = (under ? await decidedOfCommand(under.command) : null) ?? (await resumeOutcomeOf(jobId, stretch));
  // The answer is kept once (over the pending mark): a copy that settled the command while this waited for its start has decided it, and that is what this returns too
  const final = under ? await settleResume(under.command, outcome) : outcome;
  if (!final.ok) return { ok: false, reason: final.reason as ControlRefusal };
  return viewOf(botId, ownerId, now);
}

/** The resume itself, under the job's locks: only a paused job, put first in line. */
async function resumeIn(tx: Prisma.TransactionClient, botId: string, jobId: string, command: string | null): Promise<'ok' | 'not_paused'> {
  const current = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, queuedFor: true } });
  if (current.status !== 'queued' || current.queuedFor !== 'paused') return 'not_paused';
  // Resumes of this job that are still pending (their request stopped before it kept an answer) are settled from the job as it stands, before this one changes it: a start of this resume is never read as theirs (CodeRabbit on #1025, N1)
  await settlePendingResumesIn(tx, jobId, command);
  const rank = (await topRank(tx, botId)) + 1;
  await tx.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'turn', pausedAt: null, pausedWhy: null, queueRank: rank, lastTriedAt: null, startDecidedAt: null, leaseVersion: { increment: 1 } } });
  return 'ok';
}

/** A refusal decided inside a control's transaction: thrown so the whole transaction rolls back (nothing it wrote stays), then answered. */
class ControlRefused extends Error {
  constructor(readonly reason: ControlRefusal) {
    super(reason);
  }
}

/** The Brick's line, locked for the rest of the transaction: two "do this first" of one Brick are decided one after the other (finding 11). */
const lockLine = (tx: Prisma.TransactionClient, botId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`computer:line:${botId}`}, 0))`;

/**
 * Do this next: the job goes first in line. With `pauseRunning`, in one step: what holds the computer now is paused and put back in line right behind it as a job WAITING (not paused), so it carries on by itself after
 * this one, however this one ends (done, failed, cancelled). "Do this next" on a paused job is its resume.
 *
 * ATOMIC (GPT round 6, finding 11): ONE transaction decides it all, in this lock order: the Brick's line, then the target and every job holding the computer by id ascending (each under its cutoff lock). Every job
 * holding the computer is checked under those locks (the person's screen, a kept intent, a decided cutoff), then the target is ranked and each one is paused in the same transaction. Any refusal rolls ALL of it back:
 * the order and the stretches are as they were. The steps after a pause (Rule C) run only after the commit.
 */
export async function moveJobFirst(botId: string, ownerId: string, jobId: string, options: { pauseRunning?: boolean } = {}, now: Date = new Date(), command?: Command): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  // One command, one answer (finding 4): the same id is answered from its row FIRST, whatever the job is now (a replay after the job started is still the first request's answer)
  const args = { pauseRunning: options.pauseRunning === true };
  const under = underOf(command, botId, ownerId, jobId, 'first', args, job.pauses);
  if (under) {
    const seen = await seenCommand(under.command, under.row);
    if (seen) return 'reused' in seen || seen.replay !== null ? answerOf(botId, ownerId, seen, now) : answerPendingCommand(botId, ownerId, under, () => pendingOutcomeOf(under.command, jobId), now);
  }
  if (isOver(job.status)) return refused(botId, ownerId, under, 'over', now);
  if (job.status === 'queued' && job.queuedFor === 'paused') return resumeJob(botId, ownerId, jobId, now, command, { kind: 'first', args });
  if (job.status !== 'queued') return refused(botId, ownerId, under, 'not_queued', now);
  // The provider's price is read before the transaction opens (a read that fails inside it would leave the transaction aborted)
  const provider = options.pauseRunning ? providerFor(await prisma.brickComputer.findUnique({ where: { botId } })) : null;
  type FirstDecided = { seen: Exclude<Claimed, { fresh: true }> } | { refused: ControlRefusal } | { paused: Array<{ id: string; decided: PauseDecision }> };
  const decide = (clock: () => Date) => prisma.$transaction(async (tx): Promise<FirstDecided> => {
    await lockLine(tx, botId);
    const holding = options.pauseRunning ? (await tx.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] } }, select: { id: true } })).map((held) => held.id) : [];
    const rows = new Map<string, Awaited<ReturnType<typeof lockJob>>>();
    for (const id of [...new Set([jobId, ...holding])].sort()) rows.set(id, await lockJob(tx, id));
    // The command's row after every lock (finding 4); a copy of this request waits on the line, then finds it
    if (under) {
      const claimed = await claimCommandIn(tx, under.command, under.row);
      if (!('fresh' in claimed)) return { seen: claimed };
    }
    // Everything after this point is undone by a refusal (finding 11), and the refusal itself is kept as the command's outcome
    await tx.$executeRaw`SAVEPOINT "do_this_first"`;
    try {
      const paused = await firstIn(tx, botId, jobId, holding, rows, provider, now, clock);
      // What was paused has its sign-ins put away only after this commit: the answer stays pending until then (CodeRabbit on #1025, 51)
      if (under) await keepOutcome(tx, under.command, paused.length > 0 ? { ok: true, pending: true, targets: paused.map((one) => one.id), held: paused.flatMap((one) => (one.decided.kind === 'held' ? [{ jobId: one.id, n: one.decided.n }] : [])) } : { ok: true });
      return { paused };
    } catch (error) {
      if (!(error instanceof ControlRefused)) throw error;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT "do_this_first"`;
      if (under) await keepOutcome(tx, under.command, refusalOutcome(error.reason));
      return { refused: error.reason };
    }
  }, TX);
  // Pausing what holds the computer writes the computer's row, which a take-over leader's stop may hold: a pause that cannot take it yields at once (the line is let go) and is tried again once it is free. Without a pause the row is not written
  const decided = await (options.pauseRunning ? pauseWhenRowFree(botId, now, decide) : decide(() => now));
  if ('seen' in decided) return 'reused' in decided.seen || decided.seen.replay !== null ? answerOf(botId, ownerId, decided.seen, now) : answerPendingCommand(botId, ownerId, under!, () => pendingOutcomeOf(under!.command, jobId), now);
  if ('refused' in decided) return { ok: false, reason: decided.refused };
  const paused = decided.paused;
  // Rule C: only after the commit, for each pause it made
  let kept: boolean | undefined;
  for (const one of paused) {
    const after = await afterPause(one.id, one.decided, now, { advance: false });
    if (after.ok && after.kind === 'held') kept = (kept ?? true) && after.signInsKept;
  }
  // The next job starts when the pauses were written (the latest of them), never before: the wait for the computer's row is the paused job's time, not the next one's
  const started = paused.reduce((latest, one) => (one.decided.kind === 'held' && one.decided.at > latest ? one.decided.at : latest), now);
  await controlInternals.startNext(botId, started);
  if (under && paused.length > 0) {
    const final = await settleResume(under.command, kept === undefined ? { ok: true } : { ok: true, signInsKept: kept });
    if (final.ok && final.signInsKept !== undefined) kept = final.signInsKept;
  }
  const view = await viewOf(botId, ownerId, now);
  return view.ok && kept !== undefined ? { ...view, signInsKept: kept } : view;
}

/** "Do this first" itself, under the line's and every job's locks: refused by throwing `ControlRefused` (the caller undoes everything it wrote). */
async function firstIn(tx: Prisma.TransactionClient, botId: string, jobId: string, holding: string[], rows: Map<string, Awaited<ReturnType<typeof lockJob>>>, provider: Provider | null, now: Date, clock: () => Date): Promise<Array<{ id: string; decided: PauseDecision }>> {
      const target = rows.get(jobId);
      if (!target || target.botId !== botId) throw new ControlRefused('not_found');
      if (isOver(target.status)) throw new ControlRefused('over');
      const inLine = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, queuedFor: true } });
      if (inLine.status !== 'queued' || inLine.queuedFor === 'paused') throw new ControlRefused('not_queued');
      // Every job that still holds the computer, read under its locks: the same checks the pause makes, so a refusal is found before anything is written
      const held = holding.filter((id) => {
        const row = rows.get(id);
        return !!row && (row.status === 'running' || row.status === 'waiting');
      });
      for (const id of held) {
        if (rows.get(id)?.control !== 'brick') throw new ControlRefused('taken_over');
        if ((await hasFinishIntent(tx, id)) || (await hasPoolCutoff(tx, id))) throw new ControlRefused('ending');
      }
      const top = await topRank(tx, botId);
      // This job first, the paused ones right behind it, in this same transaction
      await tx.computerJob.update({ where: { id: jobId }, data: { queueRank: top + 2 } });
      const out: Array<{ id: string; decided: PauseDecision }> = [];
      for (const id of held) {
        const decided = await decidePauseIn(tx, id, 'person', now, provider, { backInLine: { rank: top + 1 }, advance: false, clock });
        if (decided.kind !== 'held') throw new ControlRefused(decided.kind === 'taken_over' ? 'taken_over' : decided.kind === 'over' ? 'over' : 'ending');
        out.push({ id, decided });
      }
      return out;
}

/** The state the person was asked about when they said Cancel. `not_started`: they were told the job had not started, so no question was asked; it is cancelled only while that is still true (a job that started in the gap is refused as `started`, nothing cancelled). Left out: cancelled whatever it is now (the person's own buttons, and callers that asked first). */
export type CancelExpectation = 'not_started';

/**
 * Cancel ONE job: running or waiting, it ends as the person's own Stop of that job only (charged the time it used, never given back) and the line moves on; waiting in line or paused, it leaves the line and nothing
 * is charged (a pause already wrote its own time). Every other job is left as it is.
 */
export async function cancelJob(botId: string, ownerId: string, jobId: string, now: Date = new Date(), command?: Command, expected?: CancelExpectation): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const first = await jobOnBrick(botId, jobId);
  if (!first) return { ok: false, reason: 'not_found' };
  // The command (finding 4): its row is committed FIRST, naming this job, and the ending runs in the finalizer's own transactions. The same id again answers what it came to, or, while the first request did not
  // keep that (it stopped half way), finishes ending THIS job, which ends a job once whoever asks.
  // The expectation is part of the command: the same id with another expectation is another control (a cancel without one keeps the key it always had)
  const under = underOf(command, botId, ownerId, jobId, 'cancel', expected ? { expected } : {}, first.pauses);
  if (under) {
    let seen = await seenCommand(under.command, under.row);
    if (!seen) {
      if (isOver(first.status)) return refused(botId, ownerId, under, 'over', now);
      if (expected === 'not_started' && !notStartedYet(first)) return refused(botId, ownerId, under, 'started', now);
      seen = await claimed(claimCommand(under.command, under.row, { ok: true, pending: true, targets: [jobId] }));
    }
    // Answered before (or another control's id); a first request that stopped half way leaves it pending: this one finishes ending the job
    if (seen && ('reused' in seen || seen.replay !== null)) return answerOf(botId, ownerId, seen, now);
  } else if (isOver(first.status)) return { ok: false, reason: 'over' };
  else if (expected === 'not_started' && !notStartedYet(first)) return { ok: false, reason: 'started' };
  // The job can change between the look and the ending (a job in line can start): the ending is asked again on what it is now
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await jobOnBrick(botId, jobId);
    if (!job || isOver(job.status)) break;
    // The person was told it had not started: a job that has started since (it was in line when they were asked) is never ended on that word, here or inside the ending's own write
    if (expected === 'not_started' && !notStartedYet(job)) return startedSince(botId, ownerId, under, now);
    if (job.status === 'queued') {
      const report: { started?: boolean } = {};
      await controlInternals.endByPerson(jobId, now, { advance: false, only: 'queued', ...(expected === 'not_started' ? { notStarted: true } : {}), report });
      if (report.started) return startedSince(botId, ownerId, under, now);
    }
    // A job that holds the machine: an ending already committed for it (the runner's kept intent, a decided pool cutoff) governs instead of the person's stop, decided under the finalizer's own lock
    else await controlInternals.endByPerson(jobId, now, { advance: true, held: true });
  }
  const after = await jobOnBrick(botId, jobId);
  // The last look found a job that started since the person was told it had not (the tries ran out on it starting): that is the refusal, not an ending that did not finish
  if (expected === 'not_started' && after && !isOver(after.status) && !notStartedYet(after)) return startedSince(botId, ownerId, under, now);
  // The parked browser is let go only once the job is over: a job that is still live (every ending lost its race) stays resumable with its saved sign-ins, and a retried Cancel drops it once the job is over (CodeRabbit on #1025, 14c4e407 pass, N8)
  if (after && after.pauses > 0 && isOver(after.status)) await dropProfile(botId, jobId, now).catch((error) => console.error('[Computer] Could not drop a cancelled job’s browser:', error instanceof Error ? error.message : 'unknown'));
  // The answer is kept only once the job is over: an ending that lost its race on every try (a concurrent write moved the job each time) leaves the command pending, and a retry under the same id ends it again, instead of
  // answering the stored success forever while the job still holds the machine (CodeRabbit on #1025, 53)
  // (kept only while nothing final is stored: a copy of this command that answered `started` first stays the answer, and is returned here too)
  if (under && (!after || isOver(after.status))) {
    const stored = await keepFinalOutcome(under.command, { ok: true, targets: [jobId] });
    if (stored && !stored.ok) return { ok: false, reason: stored.reason as ControlRefusal };
  }
  // A job that is still live is NOT told as cancelled: the person (or the Brick) would stop asking while it still holds the machine. The command stays pending and is asked again under the same id (CodeRabbit on #1025, N11)
  if (after && !isOver(after.status)) return { ok: false, reason: 'not_ended' };
  return viewOf(botId, ownerId, now);
}

/** A Cancel that was told "not started" found the job started: nothing was ended. The refusal is kept under its command, once, so a retry of the same id answers the same; a copy of the command that already stored its own final answer stays the answer. */
async function startedSince(botId: string, ownerId: string, under: { command: Command; row: CommandRow } | null, now: Date): Promise<Controlled> {
  const stored = under ? await keepFinalOutcome(under.command, refusalOutcome('started')) : null;
  return stored ? answerOf(botId, ownerId, { replay: stored, targets: null }, now) : { ok: false, reason: 'started' };
}

/** A claim in a transaction of its own, as a seen command (or null when it is this request's). */
async function claimed(claim: Promise<Claimed>): Promise<Exclude<Claimed, { fresh: true }> | null> {
  const got = await claim;
  return 'fresh' in got ? null : got;
}

/** Test seams: what a copy of a command reads while the first request has not answered. */
export const pendingOutcomeOfForTests = pendingOutcomeOf;
export const resumeDecidedOfForTests = resumeDecidedOf;
