import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { ownsBrick } from '@/lib/brick';
import { getComputerProvider, type ComputerProvider } from '@/lib/computer-provider';
import { isSafeJobId, readSignInsAnswer, signInsCommand, type SignInsAction, type SignInsAnswer } from '@/lib/computer-browser-profile-script';

/**
 * A paused job's own browser sign-ins (piece 4 of the computers plan; decisions 23 Nov, 3f). When a running job is paused, the browser it
 * was using (its sign-ins, its open pages) is put away on its Brick's computer where no agent can read it, and the next job gets an empty
 * browser. When the job carries on, it gets exactly its own browser back. Nothing of it ever goes to another job.
 *
 * The rules, and where each is kept:
 * - Kept out of every agent's reach: a root-only folder outside the home folder (lib/computer-browser-profile-script.ts), so never in the
 *   Files list and never in a cold-storage copy (a computer that comes back from cold storage has none: the job signs in again).
 * - Never restored into another job: each parked browser is kept under its own job's id, and only `restoreProfile` for that same job, on
 *   that job's Brick, while it is running for the Brick's owner, brings it back. A restore ALWAYS replaces the live browser, so a resumed
 *   job never inherits the browser of a job that ran in between, even when nothing of its own was kept.
 * - Dropped on any ending (piece 1 calls `dropProfile` after every ending of a job that was ever paused, and after a cancel), and dropped
 *   after the job has been paused longer than the Limits value `pausedSignInsHours` (24 by default): then the job stays paused and signs in
 *   again when it carries on. Every command on the machine also removes what it finds that is no longer allowed, so a drop that could not
 *   run (the machine was asleep) is made good by the next one, and the sweep does it for awake machines (`sweepPausedSignIns`).
 * - Only on an awake machine: a command would wake a sleeping one, so on a machine that is not awake nothing is run (what is parked there
 *   stays root-only, and goes with the machine if it is ever removed).
 * - Shared browser: a job that only looks may run beside the writing one and shares its browser. A writing job paused while only lookers
 *   stay on the machine has its browser emptied (`clear`), never kept, because part of it is theirs. A resumed job that finds another job
 *   on the machine gets nothing back (its kept browser is dropped) and the shared browser is left alone.
 *
 * Every function is best effort and never throws: a failure loses sign-ins (the job signs in again), it never shows them to another job.
 * The machine's command is cut off at the worst half way, and then the image's own "dirty" mark has the profile removed before any job uses it.
 */

export type SignInsState = 'parked' | 'restored' | 'fresh' | 'dropped' | 'cleared' | 'left' | 'failed';

export interface SignInsResult {
  /**
   * parked: the job's browser is put away. restored: it is back for the job. fresh: the job got an empty browser (nothing of its own was
   * kept, it was dropped for its age, or another job is on the machine): it will need to sign in again. dropped: thrown away. cleared: the
   * live browser was emptied, nothing kept. left: nothing was done (reason says why). failed: the machine did not do it.
   */
  state: SignInsState;
  reason: string | null;
  cookies: number;
  pages: number;
}

/** A park follows the pause of a running job straight away: a job whose last pause from running is older than this was not on the machine just now. */
const PARK_WINDOW_MS = 10 * 60_000;
/** How long a cleanup claim is believed (the same window as lib/computer.ts): a claim older than this was left by a server that stopped. */
const CLAIM_STALE_MS = 90_000;
/** How long one command may take on the machine: waiting for the lock, stopping the browser, starting it again and waiting for it to answer. */
const COMMAND_MS = 150_000;
/** The sweep looks at one machine at most this often for parked browsers that have been kept too long. */
const SWEEP_EVERY_MS = 60 * 60_000;
const HOUR_MS = 3600_000;

const result = (state: SignInsState, reason: string | null = null, answer?: SignInsAnswer): SignInsResult => ({ state, reason, cookies: answer?.cookies ?? 0, pages: answer?.pages ?? 0 });

/** A job that is on the machine now (running, or waiting for its person). */
const isHeld = (status: string) => status === 'running' || status === 'waiting';

interface Machine {
  ref: string;
  provider: ComputerProvider;
}

/** This Brick's machine, only when it is awake (a command would wake one that is not). */
async function awakeMachine(botId: string): Promise<Machine | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { provider: true, providerRef: true, machine: true } });
  const provider = getComputerProvider();
  if (!row?.providerRef || !provider || row.provider !== provider.kind || row.machine !== 'working') return null;
  return { ref: row.providerRef, provider };
}

/** When the job was last paused while it ran (its last pause row), or null when it never was. */
async function lastPausedFromRunning(jobId: string): Promise<Date | null> {
  const row = await prisma.computerJobPause.findFirst({ where: { jobId }, orderBy: { n: 'desc' }, select: { at: true } });
  return row?.at ?? null;
}

async function keepHours(): Promise<number> {
  return (await getBrickLimits()).pausedSignInsHours;
}

/**
 * The jobs of this Brick that may still have a parked browser: paused from running at least once, not over, and last paused within the
 * time sign-ins are kept. A running one is in it too, because it may be between its start and its restore.
 */
async function allowedToKeep(botId: string, now: Date, hours: number): Promise<string[]> {
  const jobs = await prisma.computerJob.findMany({
    where: { botId, status: { in: ['queued', 'running', 'waiting'] }, pauses: { gt: 0 } },
    select: { id: true, pauseRows: { orderBy: { n: 'desc' }, take: 1, select: { at: true } } },
  });
  const since = now.getTime() - hours * HOUR_MS;
  return jobs.filter((job) => job.pauseRows[0] && job.pauseRows[0].at.getTime() > since).map((job) => job.id);
}

/**
 * Holds the machine's cleanup claim (the one lib/computer.ts takes to clear the browser after a job, and that a starting job waits out)
 * while the command runs, so a cleanup and this never run at once and a job that starts waits for the browser to be put away first.
 * Waits for a claim another holds; a claim left by a server that stopped is taken over after a while.
 */
async function withClaim<T>(botId: string, work: () => Promise<T>): Promise<T | null> {
  let claimedAt: Date | null = null;
  for (let tries = 0; tries < 400 && !claimedAt; tries++) {
    const now = new Date();
    const claim = await prisma.brickComputer.updateMany({
      where: { botId, machine: 'working', OR: [{ cleanClaimedAt: null }, { cleanClaimedAt: { lte: new Date(now.getTime() - CLAIM_STALE_MS) } }] },
      data: { cleanClaimedAt: now },
    });
    if (claim.count === 1) claimedAt = now;
    else {
      const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { machine: true } });
      if (row?.machine !== 'working') return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!claimedAt) return null;
  try {
    return await work();
  } finally {
    await prisma.brickComputer.updateMany({ where: { botId, cleanClaimedAt: claimedAt }, data: { cleanClaimedAt: null } }).catch(() => undefined);
  }
}

/** Runs one action on the machine as root and reads its answer. A machine that cannot be reached is a failure, never an exception. */
async function onMachine(machine: Machine, action: SignInsAction, jobId: string, keep: string[], hours: number): Promise<SignInsAnswer> {
  try {
    const done = await machine.provider.exec(machine.ref, signInsCommand(action, jobId, keep, hours), { user: 'root', timeoutMs: COMMAND_MS });
    return readSignInsAnswer(action, done.exitCode, done.stdout);
  } catch (error) {
    console.error(`[Computer] Could not ${action} a job’s browser sign-ins:`, error instanceof Error ? error.message : 'unknown');
    return { done: 'failed', reason: 'unreachable', cookies: 0, pages: 0 };
  }
}

function logged(what: string, outcome: SignInsResult): SignInsResult {
  if (outcome.state === 'failed') console.error(`[Computer] A job’s browser sign-ins could not be ${what} (${outcome.reason ?? 'unknown'}); the job will sign in again`);
  return outcome;
}

/**
 * After a running (or waiting) job was paused and the pause committed, before the line moves and before the machine rests: its browser is
 * put away for it, and the machine's browser comes back empty for whatever runs next.
 */
export async function parkProfile(botId: string, jobId: string, now: Date = new Date()): Promise<SignInsResult> {
  try {
    if (!isSafeJobId(jobId)) return result('left', 'not_a_job');
    const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, status: true, writes: true } });
    if (!job || job.botId !== botId) return result('left', 'not_this_brick');
    if (job.status !== 'queued') return result('left', 'not_paused');
    // Only a job that was just on the machine: one paused while it waited in line never had the browser, and parking would take someone else's
    const paused = await lastPausedFromRunning(jobId);
    if (!paused || now.getTime() - paused.getTime() > PARK_WINDOW_MS) return result('left', 'not_on_machine');
    const machine = await awakeMachine(botId);
    if (!machine) return result('left', 'not_awake');
    const hours = await keepHours();
    const outcome = await withClaim(botId, async () => {
      const others = await prisma.computerJob.findMany({ where: { botId, id: { not: jobId }, status: { in: ['running', 'waiting'] } }, select: { writes: true } });
      if (others.length > 0) {
        // Another job is on the machine and shares this browser. A looker beside a paused writer: the browser is emptied, nothing kept (part of it is theirs).
        // A writer still on it (this job was only looking beside it): the browser is that job's, and is left alone.
        if (!job.writes || others.some((other) => other.writes)) return result('left', 'shared');
        const cleared = await onMachine(machine, 'clear', jobId, await allowedToKeep(botId, now, hours), hours);
        return cleared.done === 'dropped' ? result('cleared', 'shared') : result('failed', cleared.reason);
      }
      const keep = [...new Set([...(await allowedToKeep(botId, now, hours)), jobId])];
      const answer = await onMachine(machine, 'park', jobId, keep, hours);
      if (answer.done === 'kept') return result('parked', null, answer);
      if (answer.done === 'already') return result('left', 'already');
      return result('failed', answer.reason);
    });
    return logged('put away', outcome ?? result('left', 'not_awake'));
  } catch (error) {
    console.error('[Computer] Could not put a job’s browser sign-ins away:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

/**
 * When a job that was paused is running again (in tryStart, after the machine is up, before the runner has it): the live browser is replaced by
 * the job's own kept browser, or by an empty one when nothing of its own was kept (or it was kept too long). `fresh` means: sign in again.
 */
export async function restoreProfile(botId: string, jobId: string, now: Date = new Date()): Promise<SignInsResult> {
  try {
    if (!isSafeJobId(jobId)) return result('left', 'not_a_job');
    const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, personId: true, status: true } });
    if (!job || job.botId !== botId) return result('left', 'not_this_brick');
    if (!isHeld(job.status)) return result('left', 'not_running');
    const machine = await awakeMachine(botId);
    if (!machine) return result('left', 'not_awake');
    const hours = await keepHours();
    const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true, roomId: true, deletedAt: true } });
    const paused = await lastPausedFromRunning(jobId);
    const outcome = await withClaim(botId, async () => {
      const keep = await allowedToKeep(botId, now, hours);
      const others = await prisma.computerJob.count({ where: { botId, id: { not: jobId }, status: { in: ['running', 'waiting'] } } });
      if (others > 0) {
        // Another job is on the machine: its browser is not taken from under it, and this job's kept browser is never shown to it
        const dropped = await onMachine(machine, 'drop', jobId, keep, hours);
        return dropped.done === 'dropped' ? result('fresh', 'shared') : result('failed', dropped.reason);
      }
      // Kept only for the job it was kept for, while its Brick is still its owner's, and not longer than the Limits say
      const expired = !paused || now.getTime() - paused.getTime() > hours * HOUR_MS;
      const owner = !!bot && ownsBrick(bot, job.personId);
      if (expired || !owner) {
        const dropped = await onMachine(machine, 'drop', jobId, keep.filter((id) => id !== jobId), hours);
        if (dropped.done !== 'dropped') return result('failed', dropped.reason);
      }
      const answer = await onMachine(machine, 'restore', jobId, expired || !owner ? keep.filter((id) => id !== jobId) : keep, hours);
      if (answer.done === 'kept') return result('restored', null, answer);
      if (answer.done === 'none') return result('fresh', expired ? 'expired' : !owner ? 'owner' : 'none');
      return result('failed', answer.reason);
    });
    return logged('brought back', outcome ?? result('left', 'not_awake'));
  } catch (error) {
    console.error('[Computer] Could not bring a job’s browser sign-ins back:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

/** After any ending of a job that was ever paused, and after a cancel: its kept browser is thrown away (and anything else no longer allowed on that machine). */
export async function dropProfile(botId: string, jobId: string, now: Date = new Date()): Promise<SignInsResult> {
  try {
    if (!isSafeJobId(jobId)) return result('left', 'not_a_job');
    const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true } });
    if (job && job.botId !== botId) return result('left', 'not_this_brick');
    const machine = await awakeMachine(botId);
    if (!machine) return result('left', 'not_awake');
    const hours = await keepHours();
    const keep = (await allowedToKeep(botId, now, hours)).filter((id) => id !== jobId);
    const answer = await onMachine(machine, 'drop', jobId, keep, hours);
    return logged('dropped', answer.done === 'dropped' ? result('dropped') : result('failed', answer.reason));
  } catch (error) {
    console.error('[Computer] Could not drop a job’s browser sign-ins:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

const lastSwept = new Map<string, number>();

/** For tests: forget when each machine was last looked at. */
export function resetSignInsSweepForTests(): void {
  lastSwept.clear();
}

/**
 * Asked by the computer sweep: on every awake machine of a Brick with a job paused longer than sign-ins are kept, the parked browsers that
 * are no longer allowed are removed. A machine that is not awake is not woken for it (its next command does it). Never throws.
 */
export async function sweepPausedSignIns(now: Date = new Date()): Promise<{ looked: number; pruned: number }> {
  let looked = 0;
  let pruned = 0;
  try {
    const hours = await keepHours();
    const before = new Date(now.getTime() - hours * HOUR_MS);
    const stale = await prisma.computerJob.findMany({ where: { status: 'queued', pauses: { gt: 0 }, pausedAt: { lt: before } }, select: { botId: true, id: true }, distinct: ['botId'], take: 200 });
    for (const { botId, id } of stale) {
      if ((lastSwept.get(botId) ?? 0) > now.getTime() - SWEEP_EVERY_MS) continue;
      const machine = await awakeMachine(botId);
      if (!machine || !isSafeJobId(id)) continue;
      looked++;
      lastSwept.set(botId, now.getTime());
      const answer = await onMachine(machine, 'prune', id, await allowedToKeep(botId, now, hours), hours);
      if (answer.done === 'dropped') pruned++;
    }
  } catch (error) {
    console.error('[Computer] Could not look for paused sign-ins kept too long:', error instanceof Error ? error.message : 'unknown');
  }
  return { looked, pruned };
}

/**
 * For words after a pause: whether the paused job's sign-ins are kept for it. True when they were put away now, or were already put away;
 * false for every other answer (nothing could be kept, the browser was shared, the machine was not awake, or the machine did not do it).
 */
export function signInsKept(outcome: SignInsResult): boolean {
  return outcome.state === 'parked' || (outcome.state === 'left' && outcome.reason === 'already');
}

/** For words when a job carries on: true unless the job got its own sign-ins back ("I'll need you to sign in again when I get there"). */
export function needsSignInAgain(outcome: SignInsResult): boolean {
  return outcome.state !== 'restored';
}
