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
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { brickOf, computerView, controlInternals, providerFor, settleTurnHold, type ComputerView } from '@/lib/computer';
import { lockJob } from '@/lib/computer-owner';
import { hasFinishIntent, hasPoolCutoff } from '@/lib/computer-faults';
import { revokeJobTokens } from '@/lib/computer-token';
import { settleRoomIn } from '@/lib/meter-allowance';
import { pinnedMicrosPerMinute } from '@/lib/spend-rules-values';
import { costOfSeconds, isOver, type PausedWhy } from '@/lib/computer-values';
import { dropProfile, parkProfile, signInsKept } from '@/lib/computer-browser-profile';
import { grantsPrintIn, tellIn } from '@/lib/computer-tellings';
import { releaseIfUnheld } from '@/lib/computer-control';
import type { ComputerProvider as Provider } from '@/lib/computer-provider';

/** Why a control was not done. `not_found`: not the owner's Brick, or no such job on it. `over`: the job already ended. `taken_over`: the person has the screen. `ending`: its ending is already decided. `not_paused` / `not_queued`: the job is not in the state the tap was for. `allowance` / `rule`: a resume the person's month, or a limit they set, does not let start (the job stays paused). */
export type ControlRefusal = 'not_found' | 'over' | 'taken_over' | 'ending' | 'not_paused' | 'not_queued' | 'allowance' | 'rule';
/** `signInsKept` is said only when a job that held the machine was paused: false when its sign-ins could not be put away (it will need them again when it carries on). */
export type Controlled = { ok: true; view: ComputerView; signInsKept?: boolean } | { ok: false; reason: ControlRefusal };

const SECOND = 1000;
const TX = { timeout: 15_000, maxWait: 15_000 } as const;

/** The event a pause writes its time under: one per pause, so asked twice it is the same event. */
export const pauseEventId = (jobId: string, n: number): string => `computer:${jobId}:time:${n}`;

/** The job on this Brick, or null. */
async function jobOnBrick(botId: string, jobId: string) {
  return prisma.computerJob.findFirst({ where: { id: jobId, botId }, select: { id: true, botId: true, status: true, queuedFor: true, pauses: true } });
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

export type PauseResult =
  | { ok: true; kind: 'held'; n: number; signInsKept: boolean }
  | { ok: true; kind: 'queued' | 'already' }
  | { ok: false; reason: 'not_found' | 'over' | 'taken_over' | 'ending' | 'superseded' };

export interface PauseOptions {
  /** "Do this first": the job goes back in line at this rank as a job WAITING (not paused), so it carries on by itself after the job put ahead of it, however that one ends. */
  backInLine?: { rank: number };
  /** Only while this worker still owns the job (a pause decided for a worker, such as the month running out in its renewal): another owner's job is left alone (`superseded`). Left out for the person's own tap. */
  ownerEpoch?: number;
  /** False when the caller moves the line itself afterwards. */
  advance?: boolean;
}

/** What a pause decided inside its transaction: nothing (and why), or the pause of a job that held the machine, with what the steps after the commit need. */
export type PauseDecision =
  | { kind: 'not_found' | 'over' | 'superseded' | 'taken_over' | 'ending' | 'already' | 'queued' | 'key_gone' }
  | { kind: 'held'; n: number; botId: string; responseId: string | null; turnHold: boolean; /** The person held the screen: it was taken back in this write (released after the commit) */ heldScreen: boolean };

export interface PauseInOptions extends PauseOptions {
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
}

/**
 * The pause itself, inside the caller's transaction (Rule A): the job's cutoff lock and row lock are taken here (taken again when the caller already holds them, which Postgres allows), everything is read under them, and every
 * write lands in this one commit: the stretch counted and its room settled at that room's own terms, the pause row, the job back in line holding nothing, its owner epoch and lease version moved, every model key ended,
 * and, for the month or a limit, what Brick is to tell the person. Nothing is sent to the provider here: the caller runs `afterPause` once this commits (Rule C).
 * `provider`: the Brick computer's provider, read BEFORE the transaction opened (a read that fails inside it would leave the transaction aborted).
 */
export async function decidePauseIn(tx: Prisma.TransactionClient, jobId: string, why: PausedWhy, now: Date, provider: Provider | null, options: PauseInOptions = {}): Promise<PauseDecision> {
  const row = await lockJob(tx, jobId);
  if (!row) return { kind: 'not_found' };
  if (isOver(row.status)) return { kind: 'over' };
  if (options.ownerEpoch !== undefined && row.ownerEpoch !== options.ownerEpoch) return { kind: 'superseded' };
  if (row.status === 'queued') {
    if (options.heldOnly) return { kind: 'already' };
    if (options.backInLine) return { kind: 'already' };
    const inLine = await tx.computerJob.findUnique({ where: { id: jobId }, select: { queuedFor: true } });
    if (inLine?.queuedFor === 'paused') return { kind: 'already' };
    // Never started (or waiting again): nothing is held, so nothing is counted; it only leaves the line until resumed
    await tx.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'paused', pausedAt: now, pausedWhy: why, leaseVersion: { increment: 1 } } });
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
  const job = await tx.computerJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { botId: true, secondsRun: true, secondsBilled: true, stretchStarted: true, reservationKey: true, startedAt: true, pauses: true, firstTurnSentAt: true, agentResponseId: true },
  });
  const stretch = job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
  const seconds = job.secondsRun + stretch;
  const n = job.pauses + 1;
  // The time so far, priced as THIS stretch's room was held (its own terms: the same rule a job's ending uses), settles the room in this very commit: the unused part goes back at once
  if (job.reservationKey) {
    const lease = await tx.meterReservation.findUnique({ where: { reservationKey: job.reservationKey }, select: { terms: true } });
    const pinned = lease ? pinnedMicrosPerMinute(lease.terms, seconds, now.getTime()) : null;
    const cost = costOfSeconds(seconds, pinned ?? (provider ? provider.microsPerMinute() : null));
    await settleRoomIn(tx, { key: job.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now);
  }
  // A first turn that was sent and never named may still run with nothing to cancel it by: the machine is held until it is proved asleep (as a job's ending does), so nothing starts beside it
  const turnHold = !!job.firstTurnSentAt && !job.agentResponseId;
  if (turnHold) await tx.brickComputer.updateMany({ where: { botId: job.botId, turnUnprovenSince: null }, data: { turnUnprovenSince: now } });
  await tx.computerJob.update({
    where: { id: jobId },
    data: {
      status: 'queued',
      queuedFor: options.backInLine ? 'turn' : 'paused',
      pausedAt: options.backInLine ? null : now,
      pausedWhy: options.backInLine ? null : why,
      ...(options.backInLine ? { queueRank: options.backInLine.rank } : {}),
      pauses: n,
      // The time so far is the pause's (written below); the job counts again from 0 when it runs again
      secondsRun: 0,
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
      // The screen is taken back: the job is Brick's again (the computer itself goes back to Brick's after the commit, once no job is left in the person's hands)
      ...(heldScreen ? { control: 'brick' } : {}),
      ownerEpoch: { increment: 1 },
      leaseVersion: { increment: 1 },
    },
  });
  await revokeJobTokens(jobId, now, undefined, tx);
  // What the Brick's Apps were at this pause: the month or a limit carries the job on by itself only while they are the same (lib/computer-limit-pause)
  const grantsPrint = await grantsPrintIn(tx, job.botId);
  await tx.computerJobPause.create({ data: { jobId, n, why, roomKey: job.reservationKey, seconds, startedAt: job.startedAt, at: now, grantsPrint, heldScreen } });
  // The month or a limit: Brick tells the person once, from this very commit (their own tap is never told back to them); a screen taken back says so, in place of the usual line
  if (!options.backInLine && (why === 'allowance' || why === 'rule')) await tellIn(tx, jobId, 'paused', why, now, { heldScreen });
  return { kind: 'held', n, botId: job.botId, responseId: job.agentResponseId, turnHold, heldScreen };
}

/**
 * The steps after a pause committed (Rule C), in this order: the turn the commit read is cancelled (that one only), the stretch is written to the books under its own event, where the browser went so far is kept, the job's
 * sign-ins are put away for it alone, the machine rests (or is proved asleep under a turn hold), and the line moves. None of it can undo the pause.
 */
export async function afterPause(jobId: string, decided: PauseDecision, now: Date, options: PauseOptions = {}): Promise<PauseResult> {
  if (decided.kind !== 'held') {
    if (decided.kind === 'queued' || decided.kind === 'already') return { ok: true, kind: decided.kind };
    return { ok: false, reason: decided.kind === 'key_gone' ? 'superseded' : decided.kind };
  }
  const { botId, n } = decided;
  // Rule C: only now, and only the turn the commit read
  if (decided.responseId) await controlInternals.cancelAgentTurn(botId, decided.responseId);
  await bookPause(jobId, n, now);
  // Where its browser went so far is kept before anything can clear it
  await controlInternals.recordJobVisits({ id: jobId, botId, startedAt: (await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId, n } }, select: { startedAt: true } }))?.startedAt ?? null }, now);
  // Its sign-ins are put away for it alone, before anything else can run on the machine or it rests
  const parked = await parkProfile(botId, jobId, now).catch((error) => {
    console.error('[Computer] Could not put away a paused job’s browser:', error instanceof Error ? error.message : 'unknown');
    return null;
  });
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
  const decided = await prisma.$transaction((tx) => decidePauseIn(tx, jobId, why, now, provider, options), TX);
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
    await controlInternals.recordComputerTime({ id: jobId, botId: pause.job.botId, personId: pause.job.personId, runId: pause.job.runId, startedAt: pause.startedAt, reservationKey: pause.roomKey }, pause.seconds, pause.at, { endedBy: null, status: 'paused' }, eventId);
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

/** Pause: the owner's tap or words. A job running or waiting for them (Brick in control) is paused with its time so far charged; a job in line just leaves the line until resumed. */
export async function pauseJob(botId: string, ownerId: string, jobId: string, now: Date = new Date()): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const result = await pauseJobAs(jobId, 'person', now);
  const refused = refusalOf(result);
  if (refused) return refused;
  const view = await viewOf(botId, ownerId, now);
  return view.ok && result.ok && result.kind === 'held' ? { ...view, signInsKept: result.signInsKept } : view;
}

/**
 * Resume: the paused job goes first in line and is tried at once, with a new reservation. It stays first in line when something else holds the computer. When the person's month, or a limit they set, does not let it
 * start, it stays paused and the answer says why (`allowance` / `rule`): it is the start that is refused, never the job.
 */
export async function resumeJob(botId: string, ownerId: string, jobId: string, now: Date = new Date()): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const moved = await prisma.$transaction(async (tx) => {
    const row = await lockJob(tx, jobId);
    if (!row) return 'not_found' as const;
    if (isOver(row.status)) return 'over' as const;
    const current = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, queuedFor: true } });
    if (current.status !== 'queued' || current.queuedFor !== 'paused') return 'not_paused' as const;
    const rank = (await topRank(tx, botId)) + 1;
    await tx.computerJob.update({ where: { id: jobId }, data: { queuedFor: 'turn', pausedAt: null, pausedWhy: null, queueRank: rank, lastTriedAt: null, leaseVersion: { increment: 1 } } });
    return 'ok' as const;
  }, TX);
  if (moved !== 'ok') return { ok: false, reason: moved };
  await controlInternals.tryStart(jobId, now, { quiet: true });
  // The month or a limit refused its start: tryStart put a job that ran before back as paused, with the reason
  const after = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, queuedFor: true, pausedWhy: true } });
  if (after?.status === 'queued' && after.queuedFor === 'paused' && (after.pausedWhy === 'allowance' || after.pausedWhy === 'rule')) return { ok: false, reason: after.pausedWhy };
  return viewOf(botId, ownerId, now);
}

/**
 * Do this next: the job goes first in line. With `pauseRunning`, in one step: what holds the computer now is paused and put back in line right behind it as a job WAITING (not paused), so it carries on by itself after
 * this one, however this one ends (done, failed, cancelled). "Do this next" on a paused job is its resume.
 */
export async function moveJobFirst(botId: string, ownerId: string, jobId: string, options: { pauseRunning?: boolean } = {}, now: Date = new Date()): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await jobOnBrick(botId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (isOver(job.status)) return { ok: false, reason: 'over' };
  if (job.status === 'queued' && job.queuedFor === 'paused') return resumeJob(botId, ownerId, jobId, now);
  if (job.status !== 'queued') return { ok: false, reason: 'not_queued' };
  const holding = options.pauseRunning ? await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] } }, select: { id: true, control: true } }) : [];
  // Looked at first so a refusal changes nothing; each pause decides again under its own locks
  if (holding.some((held) => held.control !== 'brick')) return { ok: false, reason: 'taken_over' };
  for (const held of holding) if ((await hasFinishIntent(prisma, held.id)) || (await hasPoolCutoff(prisma, held.id))) return { ok: false, reason: 'ending' };
  const top = await topRank(prisma, botId);
  // This job first (ranked before the pauses, so the line they move can only pick this one), the paused ones right behind it
  const ranked = await prisma.computerJob.updateMany({ where: { id: jobId, botId, status: 'queued' }, data: { queueRank: top + 2 } });
  if (ranked.count === 0) {
    const now2 = await jobOnBrick(botId, jobId);
    return { ok: false, reason: now2 && isOver(now2.status) ? 'over' : 'not_queued' };
  }
  let kept: boolean | undefined;
  for (const held of holding) {
    const paused = await pauseJobAs(held.id, 'person', now, { backInLine: { rank: top + 1 }, advance: false });
    const refused = refusalOf(paused);
    if (refused) return refused;
    if (paused.ok && paused.kind === 'held') kept = (kept ?? true) && paused.signInsKept;
  }
  await controlInternals.startNext(botId, now);
  const view = await viewOf(botId, ownerId, now);
  return view.ok && kept !== undefined ? { ...view, signInsKept: kept } : view;
}

/**
 * Cancel ONE job: running or waiting, it ends as the person's own Stop of that job only (charged the time it used, never given back) and the line moves on; waiting in line or paused, it leaves the line and nothing
 * is charged (a pause already wrote its own time). Every other job is left as it is.
 */
export async function cancelJob(botId: string, ownerId: string, jobId: string, now: Date = new Date()): Promise<Controlled> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const first = await jobOnBrick(botId, jobId);
  if (!first) return { ok: false, reason: 'not_found' };
  if (isOver(first.status)) return { ok: false, reason: 'over' };
  // The job can change between the look and the ending (a job in line can start): the ending is asked again on what it is now
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await jobOnBrick(botId, jobId);
    if (!job || isOver(job.status)) break;
    if (job.status === 'queued') await controlInternals.endByPerson(jobId, now, { advance: false, only: 'queued' });
    else await controlInternals.endByPerson(jobId, now, { advance: true });
  }
  const after = await jobOnBrick(botId, jobId);
  if (after && after.pauses > 0) await dropProfile(botId, jobId, now).catch((error) => console.error('[Computer] Could not drop a cancelled job’s browser:', error instanceof Error ? error.message : 'unknown'));
  return viewOf(botId, ownerId, now);
}
