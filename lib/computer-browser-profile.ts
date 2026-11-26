import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { ownsBrick } from '@/lib/brick';
import { refreshMarkParts } from '@/lib/computer-mark';
import { getComputerProvider, type ComputerProvider } from '@/lib/computer-provider';
import { isSafeJobId, readSignInsAnswer, signInsCommand, type SignInsAction, type SignInsAnswer } from '@/lib/computer-browser-profile-script';
import { CLEAN_CLAIM_STALE_MS, MACHINE_COMMAND_MS } from '@/lib/computer-values';

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
/** How long a start is given to bring a resumed job's browser back before the sweep takes the job over: one command on the machine, with room to spare, so a live try is never cut across. */
const RESTORE_STALE_MS = 5 * 60_000;
/** How long a cleanup claim is believed, and how long one command may take: ONE pair of values for every holder of this claim (lib/computer-values), because a window shorter than a command lets a second command start beside the first (CodeRabbit N7). */
const CLAIM_STALE_MS = CLEAN_CLAIM_STALE_MS;
const COMMAND_MS = MACHINE_COMMAND_MS;
/** The sweep looks at one machine at most this often for parked browsers that have been kept too long. */
const SWEEP_EVERY_MS = 60 * 60_000;
const HOUR_MS = 3600_000;

const result = (state: SignInsState, reason: string | null = null, answer?: SignInsAnswer): SignInsResult => ({ state, reason, cookies: answer?.cookies ?? 0, pages: answer?.pages ?? 0 });

/**
 * Writes whether a pause put a browser away: the pause `pause` names (its number), or the job's LAST pause when none is named. A park or a wipe that settles
 * for one pause names it, so a stale one never writes onto a later pause of the same job (CodeRabbit A9). Never throws.
 */
async function recordKept(jobId: string, kept: boolean, pause?: number): Promise<boolean> {
  try {
    const target = pause ?? (await prisma.computerJobPause.findFirst({ where: { jobId }, orderBy: { n: 'desc' }, select: { n: true } }))?.n;
    if (target !== undefined) await prisma.computerJobPause.updateMany({ where: { jobId, n: target }, data: { signInsKept: kept } });
    return true;
  } catch (error) {
    console.error('[Computer] Could not keep what a pause put away:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * What a park came to, as it is kept on the pause's row: true when the browser was put away (or already was), false when there was nothing to put away or the park was left for the wipe, nothing when the outcome says nothing of
 * the pause's own browser. The marker the pause left on the machine is let go only once this is written: a park that was proved but whose record failed leaves the marker, and the next settlement writes it (a pause whose result is never
 * recorded would answer "not ready" for ever; CodeRabbit on #1025, Opus's O45 note).
 */
function keptOfPark(answer: SignInsResult): boolean | undefined {
  if (answer.state === 'parked' || (answer.state === 'left' && answer.reason === 'already')) return true;
  if (answer.state === 'left' && (answer.reason === 'nothing_saved' || answer.reason === 'wipe_later')) return false;
  return undefined;
}

/** A job that is on the machine now (running, or waiting for its person). */
const isHeld = (status: string) => status === 'running' || status === 'waiting';

interface Machine {
  botId: string;
  ref: string;
  provider: ComputerProvider;
}

/** This Brick's machine, only when it is awake (a command would wake one that is not). */
async function awakeMachine(botId: string): Promise<Machine | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { provider: true, providerRef: true, machine: true } });
  const provider = getComputerProvider();
  if (!row?.providerRef || !provider || row.provider !== provider.kind || row.machine !== 'working') return null;
  return { botId, ref: row.providerRef, provider };
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
async function withClaim<T>(botId: string, work: (renew: () => Promise<boolean>) => Promise<T>, /** How many times (a quarter second apart) to look for the claim: a best-effort caller gives up sooner. */ looks = 400): Promise<T | null> {
  let claimedAt: Date | null = null;
  for (let tries = 0; tries < looks && !claimedAt; tries++) {
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
  // Work that runs more than one command under the claim renews it before each next one: a claim is believed for ONE command and a little more, so a second command that began late must not run on a claim that has gone stale.
  // False when the claim is no longer ours (another holder took it over), and then no further command is run
  const renew = async (): Promise<boolean> => {
    const at = new Date();
    const held = await prisma.brickComputer.updateMany({ where: { botId, cleanClaimedAt: claimedAt }, data: { cleanClaimedAt: at } }).catch(() => ({ count: 0 }));
    if (held.count === 1) claimedAt = at;
    return held.count === 1;
  };
  try {
    return await work(renew);
  } finally {
    await prisma.brickComputer.updateMany({ where: { botId, cleanClaimedAt: claimedAt }, data: { cleanClaimedAt: null } }).catch(() => undefined);
  }
}

/** Runs one action on the machine as root and reads its answer. A machine that cannot be reached is a failure, never an exception. */
async function onMachine(machine: Machine, action: SignInsAction, jobId: string, keep: string[], hours: number, /** The pause a restore brings back, or a commit is for (N29). */ generation = 0, /** The claim's renewal: the parts are saved again only while the claim is still ours (Sentry on #1033). */ renew?: () => Promise<boolean>): Promise<SignInsAnswer> {
  try {
    const done = await machine.provider.exec(machine.ref, signInsCommand(action, jobId, keep, hours, undefined, generation), { user: 'root', timeoutMs: COMMAND_MS });
    const answer = readSignInsAnswer(action, done.exitCode, done.stdout);
    // These put a new browser up (park and clear start an empty one, a restore starts the job's own): the parts the take-over fence keeps are saved again. Best effort, never throws.
    if (answer.done !== 'failed' && (action === 'park' || action === 'restore' || action === 'clear')) await refreshMarkParts(machine.botId, machine.ref, machine.provider, renew);
    return answer;
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
export async function parkProfile(botId: string, jobId: string, now: Date = new Date(), /** The number of the pause this park settles (its pause row); read from the job when the caller does not know it. */ pause?: number): Promise<SignInsResult> {
  try {
    if (!isSafeJobId(jobId)) return result('left', 'not_a_job');
    const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, status: true, writes: true, pauses: true } });
    if (!job || job.botId !== botId) return result('left', 'not_this_brick');
    if (job.status !== 'queued') return result('left', 'not_paused');
    // Each park settles ONE pause: a job that paused again since is a later pause's to settle, and this one clears nothing of it (CodeRabbit A9)
    const generation = pause ?? job.pauses;
    if (job.pauses !== generation) return result('left', 'not_paused');
    // Two pauses left their marks together: the browser is part of both jobs, so it is never put away under either name; `settlePark` empties it. The pointer holds only the FIRST job's id, so the flag
    // is read for the whole Brick: the second job's settle, if it runs first, must not park the shared browser under its own name either (Opus on slice 1, S1-a)
    const marked = await prisma.brickComputer.findFirst({ where: { botId, parkPendingWipe: true }, select: { botId: true } });
    if (marked) return result('left', 'wipe_pending');
    // Only a job that was just on the machine: one paused while it waited in line never had the browser, and parking would take someone else's
    const paused = await lastPausedFromRunning(jobId);
    if (!paused || now.getTime() - paused.getTime() > PARK_WINDOW_MS) return result('left', 'not_on_machine');
    const machine = await awakeMachine(botId);
    if (!machine) return result('left', 'not_awake');
    const hours = await keepHours();
    const outcome = await withClaim(botId, async (renew) => {
      // Read AGAIN inside the claim: a job that started again, or paused again, while this waited for the claim is not the pause this park settles (the claim is what a start waits for too, so from here on it cannot move)
      if ((await prisma.computerJob.count({ where: { id: jobId, status: 'queued', pauses: generation } })) === 0) return result('left', 'not_paused');
      const others = await prisma.computerJob.count({ where: { botId, id: { not: jobId }, status: { in: ['running', 'waiting'] } } });
      if (others > 0) {
        // Another job is on the machine and shares this browser (only jobs that do not sign in can be beside each other: a job that may sign in has the browser alone). The browser is never put away under this job's name and never
        // emptied under the job beside it: the wipe is left for the moment no job is on the machine (`park_pending_wipe` with the pointer, which keeps every other job from starting until it is done), and this pause keeps nothing (round 8, F)
        await prisma.brickComputer.updateMany({ where: { botId, parkPendingJobId: { not: null } }, data: { parkPendingWipe: true } });
        return result('left', 'wipe_later');
      }
      // The wipe flag is read here, AFTER the jobs beside were counted and inside the claim (CodeRabbit A5). A second pause writes the flag and leaves the held states in ONE commit, so it either left the held states before the
      // count above (its flag is committed, and is seen now) or was still held at the count (the shared branch above, where nothing is put away). A job cannot start under the claim, so no other job can come into the held states after the count
      if (await prisma.brickComputer.findFirst({ where: { botId, parkPendingWipe: true }, select: { botId: true } })) return result('left', 'wipe_pending');
      const keep = [...new Set([...(await allowedToKeep(botId, now, hours)), jobId])];
      const answer = await onMachine(machine, 'park', jobId, keep, hours, 0, renew);
      if (answer.done === 'kept') return result('parked', null, answer);
      if (answer.done === 'already') return result('left', 'already');
      if (answer.done === 'none') return result('left', 'nothing_saved');
      return result('failed', answer.reason);
    });
    const answer = logged('put away', outcome ?? result('left', 'not_awake'));
    // What this pause came to is kept on its own row: a job that found nothing to put away has no browser of its own to wait for (`parkWorthWaitingFor`)
    const wasKept = keptOfPark(answer);
    const recorded = wasKept === undefined ? true : await recordKept(jobId, wasKept, generation);
    // The machine waits for no job's browser now (a park that FAILED, or a machine that was not awake, leaves the pointer: nothing else starts there until the sweep has put it right). A park whose result could not be recorded leaves it too
    if (parkDone(answer) && recorded) await clearParkPending(botId, jobId, { pauses: generation });
    return answer;
  } catch (error) {
    console.error('[Computer] Could not put a job’s browser sign-ins away:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

/**
 * What a resumed job's browser attempt still has to own, in the one write or the one check that lands it: the job is on the machine (running or waiting), still in the room the attempt started on, and still in the prep state the
 * attempt read. A late attempt (the sweep took over a start, or two sweeps read the same job) finds one of these gone and does nothing (CodeRabbit A6, A7).
 */
export interface ResumeFence {
  reservation?: string;
  from?: 'restoring' | 'recover';
}
/** What a park's or a wipe's job must be in for a wipe of the live browser: not on the machine (paused, or over) and on the pause the wipe settles. */
export interface PauseFence {
  pauses: number;
}
const prepWhere = (jobId: string, fence?: ResumeFence) => ({ id: jobId, status: { in: ['running', 'waiting'] }, ...(fence?.reservation ? { reservationKey: fence.reservation } : {}), ...(fence?.from ? { prepState: fence.from } : {}) });
async function fenceHolds(jobId: string, fence: ResumeFence | PauseFence): Promise<boolean> {
  if ('pauses' in fence) return (await prisma.computerJob.count({ where: { id: jobId, pauses: fence.pauses, status: { notIn: ['running', 'waiting'] } } })) === 1;
  return (await prisma.computerJob.count({ where: prepWhere(jobId, fence) })) === 1;
}

/** What the claim holder has in hand while it settles inside the claim. */
interface Under {
  machine: Machine;
  hours: number;
  renew: () => Promise<boolean>;
}
/** Runs inside the claim of a restore, with the restore's own answer: the settlement of the job lands under the same claim as the command, so no second attempt can restore in between (CodeRabbit A7). */
export type SettleUnderClaim = (back: SignInsResult, under: Under) => Promise<void>;

/**
 * When a job that was paused is running again (in tryStart, after the machine is up, before the runner has it): the live browser is replaced by
 * the job's own kept browser, or by an empty one when nothing of its own was kept (or it was kept too long). `fresh` means: sign in again.
 */
export async function restoreProfile(botId: string, jobId: string, now: Date = new Date(), /** Only while the job is still the attempt's own (see `ResumeFence`): checked under the claim that issues the command. */ fence?: ResumeFence, /** Run under the same claim, with this restore's answer. */ settle?: SettleUnderClaim): Promise<SignInsResult> {
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
    const outcome = await withClaim(botId, async (renew) => {
      // The state is read under the claim that issues the command, never before it: a restore that was already done by an earlier attempt is never repeated (a second one finds no parked copy and empties the live browser)
      if (fence && !(await fenceHolds(jobId, fence))) return result('left', 'superseded');
      const back = await restoreUnder(machine, botId, jobId, job.personId, bot, paused, now, hours, renew);
      if (settle) await settle(back, { machine, hours, renew });
      return back;
    });
    return logged('brought back', outcome ?? result('left', 'not_awake'));
  } catch (error) {
    console.error('[Computer] Could not bring a job’s browser sign-ins back:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

/** The restore itself, under the claim. */
async function restoreUnder(machine: Machine, botId: string, jobId: string, personId: string, bot: Parameters<typeof ownsBrick>[0] | null, paused: Date | null, now: Date, hours: number, renew: () => Promise<boolean>): Promise<SignInsResult> {
  const keep = await allowedToKeep(botId, now, hours);
  const others = await prisma.computerJob.count({ where: { botId, id: { not: jobId }, status: { in: ['running', 'waiting'] } } });
  if (others > 0) {
    // Another job is on the machine: its browser is not taken from under it, and this job's kept browser is never shown to it. Its park is LEFT WHERE IT IS: a job whose park is still
    // valid waits for the machine instead of coming here (`parkWorthWaitingFor`, read by tryStart), and throwing it away here would lose the person's sign-ins for a job that is
    // allowed to keep them (GPT round 6, finding 7, Opus's ruling 23 Nov)
    return result('fresh', 'shared');
  }
  // Kept only for the job it was kept for, while its Brick is still its owner's, and not longer than the Limits say
  const expired = !paused || now.getTime() - paused.getTime() > hours * HOUR_MS;
  const owner = !!bot && ownsBrick(bot, personId);
  if (expired || !owner) {
    const dropped = await onMachine(machine, 'drop', jobId, keep.filter((id) => id !== jobId), hours);
    if (dropped.done !== 'dropped') return result('failed', dropped.reason);
  }
  // The claim was stamped before the drop, and a drop can take long: it is renewed before the restore, and the restore does not run when the claim is no longer held (another operation on the browser may have taken it; CodeRabbit on #1025, I5)
  if (!(await renew())) return result('left', 'superseded');
  // The number of the pause this restore brings back goes into the machine's note of it: the commit that follows names the same number (CodeRabbit on #1025, N29)
  const generation = await pauseNumberOf(jobId);
  // No number, no note: a number that cannot be read is never replaced by a shared stand-in (0), because an older commit and a newer restore would then carry the same one and the older could remove the newer note. The restore is not run, the
  // machine's note is left as it is for the recovery, and the sweep tries again (CodeRabbit on #1025, d522f4b3 pass, N24)
  if (generation === null) return result('failed', 'error');
  const answer = await onMachine(machine, 'restore', jobId, expired || !owner ? keep.filter((id) => id !== jobId) : keep, hours, generation, renew);
  if (answer.done === 'kept') return result('restored', null, answer);
  if (answer.done === 'none') return result('fresh', expired ? 'expired' : !owner ? 'owner' : 'none');
  return result('failed', answer.reason);
}

/**
 * Whether this job has a browser of its own that it is still allowed to get back: it was paused from running within the hours sign-ins are kept, and its Brick is still its person's. A job
 * with one does NOT share a machine another job holds — it waits for the machine alone, so its own sign-ins are never thrown away to let it run in somebody else's browser (GPT round 6,
 * finding 7, Opus's ruling 23 Nov). A job that kept nothing (its park expired, was dropped, or there was never one) runs beside another job as any new job does. Never throws: a question
 * that cannot be answered is answered "no", which is how a resumed job behaved before.
 */
export async function parkWorthWaitingFor(botId: string, jobId: string, now: Date = new Date()): Promise<boolean> {
  try {
    if (!isSafeJobId(jobId)) return false;
    const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, personId: true } });
    if (!job || job.botId !== botId) return false;
    const last = await prisma.computerJobPause.findFirst({ where: { jobId }, orderBy: { n: 'desc' }, select: { at: true, signInsKept: true } });
    const paused = last?.at ?? null;
    if (!paused || now.getTime() - paused.getTime() > (await keepHours()) * HOUR_MS) return false;
    // A pause that found nothing to put away (no profile, no readable session) left this job no browser of its own to wait for: it runs beside another job as any new job does (CodeRabbit on #1025)
    if (last?.signInsKept === false) return false;
    const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true, roomId: true, deletedAt: true } });
    return !!bot && ownsBrick(bot, job.personId);
  } catch (error) {
    console.error('[Computer] Could not tell whether a job has a browser of its own to wait for:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * Empties the live browser on the machine and proves it empty. Used when a resumed job could not have its OWN browser brought back (nothing of its own was kept, or it was kept too long): a clean
 * browser that needs signing in again is valid, one that may still hold what another job left is not. Also used by the sweep for a pause whose park never ran (GPT round 6, finding 7).
 */
export async function wipeLiveProfile(botId: string, jobId: string, now: Date = new Date(), /** The job must still be in this state when the command is about to run, checked under the claim (CodeRabbit A6, A8). */ fence?: ResumeFence | PauseFence): Promise<SignInsResult> {
  try {
    if (!isSafeJobId(jobId)) return result('left', 'not_a_job');
    const machine = await awakeMachine(botId);
    if (!machine) return result('left', 'not_awake');
    const hours = await keepHours();
    const outcome = await withClaim(botId, async (renew) => wipeUnder(machine, botId, jobId, now, hours, fence, renew));
    return logged('emptied', outcome ?? result('left', 'not_awake'));
  } catch (error) {
    console.error('[Computer] Could not empty the live browser:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

/** The emptying itself, under the claim. */
async function wipeUnder(machine: Machine, botId: string, jobId: string, now: Date, hours: number, fence?: ResumeFence | PauseFence, renew?: () => Promise<boolean>): Promise<SignInsResult> {
  // Read INSIDE the claim, so a job that starts in between is seen (the claim that starts a job and this one exclude each other): the browser of a job that runs beside is its own, and is never emptied under it
  const beside = await prisma.computerJob.count({ where: { botId, id: { not: jobId }, status: { in: ['running', 'waiting'] } } });
  if (beside > 0) return result('left', 'shared');
  // And the job this is for: its reservation and prep state (or its pause) are checked before the command, never after it, because a clear that already ran cannot be undone by a check that comes later (CodeRabbit A6)
  if (fence && !(await fenceHolds(jobId, fence))) return result('left', 'superseded');
  const cleared = await onMachine(machine, 'clear', jobId, await allowedToKeep(botId, now, hours), hours, 0, renew);
  return cleared.done === 'dropped' ? result('cleared', null, cleared) : result('failed', cleared.reason);
}

/**
 * What a resumed job's browser came back as decides whether the job may be worked on at all (GPT round 6, finding 7): its own browser back is ready, and so is a clean one (it signs in again), but
 * only once the live browser has been emptied and proved empty — a browser whose state we cannot tell may still hold what another job left. The browser SHARED with a job that is on the machine is
 * left exactly as it is (the sign-in rules: a looker beside a writer shares it), and is ready. Anything else leaves the job `recover`: nothing runs it, no call of it is authorized, and the sweep
 * tries again. Written only while `reservation` is still the job's room, so a late try settles nothing for a stretch that moved on without it (finding 3b).
 */
export async function settleResumedBrowser(jobId: string, botId: string, back: SignInsResult, /** The clock of the ready write: a function is read in `writePrep` right before the write, after any browser clear, so the billable stretch never starts before the clear ends (CodeRabbit on #1025, I6); a Date is that moment. */ now: Date | (() => Date) = new Date(), reservation?: string, /** The state the attempt read: written only while the job still holds it, so a late second attempt never undoes what a faster one settled (CodeRabbit on #1025). */ from?: 'restoring' | 'recover'): Promise<'ready' | 'recover'> {
  const fence: ResumeFence = { reservation, from };
  const needsWipe = back.state === 'fresh' && back.reason !== 'shared';
  if (needsWipe) {
    try {
      const machine = await awakeMachine(botId);
      const hours = await keepHours();
      // The check, the emptying and the write are one claim: a ready job's browser is never emptied by an attempt that was late (CodeRabbit A6)
      const settled = machine ? await withClaim(botId, (renew) => settleUnder({ machine, hours, renew }, jobId, botId, back, now, fence)) : null;
      if (settled) return settled;
    } catch (error) {
      console.error('[Computer] Could not empty the live browser for a resumed job:', error instanceof Error ? error.message : 'unknown');
    }
    await writePrep(jobId, false, fence, now);
    return 'recover';
  }
  const ready = back.state === 'restored' || (back.state === 'fresh' && back.reason === 'shared');
  // Read before the write that makes the job ready, which holds only while the job's room is this attempt's (no pause in between): the pause the note was made for
  const generation = await pauseNumberOf(jobId);
  const written = (await writePrep(jobId, ready, fence, now)) && ready;
  // A commit without a readable number removes nothing: the note stays for the recovery (N24)
  if (written && back.state === 'restored' && generation !== null) await commitRestore(botId, jobId, generation);
  return written ? 'ready' : 'recover';
}

/**
 * The restore is over for good once the database says the job is ready: the machine's note of it (kept so a retry after a failed ready write never empties the browser that was just put back) is let go. Best effort: a note that
 * stays is removed with the next command that replaces the browser, or by the hours it is kept (CodeRabbit on #1025, I4). Never throws.
 */
async function commitRestore(botId: string, jobId: string, generation: number): Promise<void> {
  try {
    const machine = await awakeMachine(botId);
    const hours = await keepHours();
    // Under the same claim every park and restore of the browser runs under, and only while it is still held: a commit never lands in the middle of another operation on the browser (CodeRabbit on #1025, N29). Best effort, so it gives up
    // after a few looks; the note it leaves is removed by the next command that replaces the browser or by the hours it is kept
    if (machine) await withClaim(botId, async (renew) => ((await renew()) ? onMachine(machine, 'commit', jobId, [], hours, generation) : null), 20);
  } catch (error) {
    console.error('[Computer] Could not let go of the note of a restored browser:', error instanceof Error ? error.message : 'unknown');
  }
}

/** The number of the job's last pause (what a restore brings back); null when it cannot be read (the read failed, or the job is gone): there is NO shared stand-in number, every caller leaves the machine's note as it is then (N24). */
async function pauseNumberOf(jobId: string): Promise<number | null> {
  return (await prisma.computerJob.findUnique({ where: { id: jobId }, select: { pauses: true } }).catch(() => null))?.pauses ?? null;
}

/** The emptying a fresh result needs (when it does) and the job's write, with the claim already held. */
async function settleUnder(under: Under, jobId: string, botId: string, back: SignInsResult, now: Date | (() => Date), fence: ResumeFence): Promise<'ready' | 'recover'> {
  let ready = back.state === 'restored' || (back.state === 'fresh' && back.reason === 'shared');
  if (!ready && back.state === 'fresh' && (await under.renew())) {
    // A browser a job beside it is using is left exactly as it is, and the job is ready (the wipe decides this inside its claim)
    const wiped = logged('emptied', await wipeUnder(under.machine, botId, jobId, typeof now === 'function' ? now() : now, under.hours, fence, under.renew));
    ready = wiped.state === 'cleared' || (wiped.state === 'left' && wiped.reason === 'shared');
  }
  const generation = await pauseNumberOf(jobId);
  const written = (await writePrep(jobId, ready, fence, now)) && ready;
  // The claim is renewed before this further command (it has been held since the restore), and the command runs only while it is still ours (CodeRabbit on #1025, N29)
  if (written && back.state === 'restored' && generation !== null && (await under.renew())) await onMachine(under.machine, 'commit', jobId, [], under.hours, generation);
  return written ? 'ready' : 'recover';
}

/** Writes whether the job is ready, only while the attempt still owns it. True only when a row was written: a failed write, or a job that moved on (a later room, a later pause, settled by a faster attempt), is not a settlement (CodeRabbit B/C19, A12). */
async function writePrep(jobId: string, ready: boolean, fence: ResumeFence, at: Date | (() => Date)): Promise<boolean> {
  try {
    // The stretch starts at the moment of this write, read here (after any clear that was needed), never at a moment sampled before the claim was waited for
    const done = await prisma.computerJob.updateMany({ where: prepWhere(jobId, fence), data: ready ? { prepState: null, stretchStarted: typeof at === 'function' ? at() : at } : { prepState: 'recover' } });
    return done.count === 1;
  } catch (error) {
    console.error('[Computer] Could not write whether a resumed job is ready:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * The sweep: jobs whose browser could not be settled when they carried on (`prep_state` = `recover`). The restore is tried again; once the job has been paused longer than sign-ins are kept (its own
 * browser is no longer allowed anyway) the live browser is emptied instead, which makes the job ready to sign in again. A job whose result cannot be read is left as it is for the next pass: it is
 * never made runnable on an unknown browser. Never throws.
 */
let recoverAfter: string | null = null;
/** For tests: the recovery pass starts from the first job again. */
export const resetRecoveryCursorForTests = (): void => {
  recoverAfter = null;
};
export async function recoverResumedBrowsers(now: Date = new Date(), batch = 5): Promise<{ looked: number; ready: number }> {
  let looked = 0;
  let ready = 0;
  // The clock of a settlement is the sweep's own plus the time it really spent: a job made ready starts its billable stretch then, never at the start of the pass (round 8, B2)
  const began = Date.now();
  const readyAt = (): Date => new Date(now.getTime() + (Date.now() - began));
  try {
    const hours = await keepHours();
    const after = recoverAfter;
    const jobs = await prisma.computerJob.findMany({
      where: {
        status: { in: ['running', 'waiting'] },
        ...(after ? { id: { gt: after } } : {}),
        OR: [
          { prepState: 'recover' },
          // A try that died between writing `restoring` and settling the browser would leave the job out of everyone's reach for good: nobody lists it, nobody claims it, no call of it is authorized. Past the
          // longest one command may take on the machine no try is still working on it, so the sweep settles it like any other (GPT round 6, finding 7)
          { prepState: 'restoring', startedAt: { lt: new Date(now.getTime() - RESTORE_STALE_MS) } },
        ],
      },
      select: { id: true, botId: true, reservationKey: true, prepState: true },
      // A stable order and a cursor: jobs whose commands keep failing never hold up the ones behind them (CodeRabbit on #1025); a short page is the end, and the next pass starts again from the first
      orderBy: { id: 'asc' },
      take: batch,
    });
    recoverAfter = jobs.length >= batch ? jobs[jobs.length - 1].id : null;
    for (const job of jobs) {
      looked++;
      // A try that died while bringing the browser back left an UNKNOWN result: the sweep never reads that as ready. It is written down as `recover` (fenced to that try's own room, as every
       // write about a start is) and settled on a later pass through the recover path alone (Opus's ruling 23 Nov)
      if (job.prepState === 'restoring') {
        await prisma.computerJob
          .updateMany({ where: { id: job.id, prepState: 'restoring', ...(job.reservationKey ? { reservationKey: job.reservationKey } : {}) }, data: { prepState: 'recover' } })
          .catch((error) => console.error('[Computer] Could not take over a start that died while bringing a browser back:', error instanceof Error ? error.message : 'unknown'));
        continue;
      }
      const paused = await lastPausedFromRunning(job.id);
      const tooOld = !paused || now.getTime() - paused.getTime() > hours * HOUR_MS;
      // Past the hours its own browser may be kept there is nothing of its own left to bring back: a clean browser, proved clean, is what makes it ready
      // The restore and the settlement are ONE claim, checked there: two sweeps that read the same job never both restore it, and the later one finds it settled and does nothing (CodeRabbit A7)
      const fence: ResumeFence = { reservation: job.reservationKey ?? undefined, from: 'recover' };
      let settledUnder: 'ready' | 'recover' | undefined;
      const back = tooOld
        ? result('fresh', 'expired')
        : await restoreProfile(job.botId, job.id, now, fence, async (restored, under) => {
            settledUnder = await settleUnder(under, job.id, job.botId, restored, readyAt, fence);
          });
      if ((settledUnder ?? (await settleResumedBrowser(job.id, job.botId, back, readyAt, fence.reservation, 'recover'))) === 'ready') ready++;
    }
  } catch (error) {
    console.error('[Computer] Could not put a resumed job’s browser right:', error instanceof Error ? error.message : 'unknown');
  }
  return { looked, ready };
}

/**
 * The sweep: a machine whose pause never got as far as putting the job's browser away (the server stopped between the two). While
 * `park_pending_job_id` is set no other job starts on that machine, so the park is finished here; a machine that will not do it has its live
 * browser emptied instead (those sign-ins are lost, never shown to another job) and the pointer let go (GPT round 6, finding 7).
 */
let pendingAfter: string | null = null;
/** For tests: the pending-park pass starts from the first machine again. */
export const resetPendingCursorForTests = (): void => {
  pendingAfter = null;
};
/**
 * One machine's unfinished park, finished: put away, or emptied once no job is on the machine (a pause beside a job that was still working left `park_pending_wipe`, and the wipe waits for the last job). The sweep calls it for every machine that
 * has a marker, and a job's ending calls it for its own Brick, so the jobs in line start when the last job is gone and not a sweep later (round 8, F).
 */
export async function finishParkOf(botId: string, jobId: string, now: Date = new Date()): Promise<'settled' | 'wiped' | 'waiting'> {
  // The pause this park and its settlement are for is read once, so a pause that lands between the two is never settled by them (CodeRabbit A9)
  const pause = (await prisma.computerJob.findUnique({ where: { id: jobId }, select: { pauses: true } }))?.pauses;
  return settlePark(botId, jobId, await parkProfile(botId, jobId, now, pause), now, pause);
}

/** The marker a Brick's machine carries (the job whose browser is still to be put away or emptied), or null. */
export async function pendingParkOf(botId: string): Promise<string | null> {
  return (await prisma.brickComputer.findUnique({ where: { botId }, select: { parkPendingJobId: true } }))?.parkPendingJobId ?? null;
}

export async function finishPendingParks(now: Date = new Date(), batch = 5): Promise<{ looked: number; parked: number; wiped: number }> {
  let looked = 0;
  let parked = 0;
  let wiped = 0;
  try {
    // A stable order and a cursor: machines that keep failing never hold up a healthy one behind them (CodeRabbit on #1025). No marker is let go without its park or its wipe being proved; a short page is the end
    const waiting = await prisma.brickComputer.findMany({ where: { NOT: { parkPendingJobId: null }, ...(pendingAfter ? { botId: { gt: pendingAfter } } : {}) }, select: { botId: true, parkPendingJobId: true }, orderBy: { botId: 'asc' }, take: batch });
    pendingAfter = waiting.length >= batch ? waiting[waiting.length - 1].botId : null;
    for (const machine of waiting) {
      if (!machine.parkPendingJobId) continue;
      looked++;
      const settled = await finishParkOf(machine.botId, machine.parkPendingJobId, now);
      if (settled === 'settled') parked++;
      if (settled === 'wiped') wiped++;
    }
  } catch (error) {
    console.error('[Computer] Could not finish putting a paused job’s browser away:', error instanceof Error ? error.message : 'unknown');
  }
  return { looked, parked, wiped };
}

/**
 * Whether a park left the machine with nothing of this job's in the live browser: it was put away or emptied (proved), there was never anything there to put away (`nothing_saved`), a parked copy was already made
 * (`already`), or the browser belongs to a job that runs beside (`shared`). A job that "was not on the machine", "is not paused" or is not found says nothing about the LIVE browser: the pause committed, so its sign-ins may
 * still be there, and the browser is emptied (proved) before the marker goes (CodeRabbit on #1025).
 */
const PARK_SETTLED_REASONS = ['shared', 'already', 'nothing_saved'];
const parkDone = (outcome: SignInsResult): boolean => outcome.state === 'parked' || outcome.state === 'cleared' || (outcome.state === 'left' && PARK_SETTLED_REASONS.includes(outcome.reason ?? ''));

/**
 * What a pause does with the mark it left on the machine (`park_pending_job_id`, GPT round 6, finding 7). Settled by the park: the machine
 * stops waiting and the jobs behind it start at once. Not settled: the live browser is emptied here and now, because those sign-ins are the
 * paused job's and the next job on that machine must never find them; only if that fails too does the machine keep waiting, and then the
 * sweep owns it (`finishPendingParks`). Called by the pause itself and by the sweep, so both settle a park exactly the same way.
 * Two pauses that left their marks together (one command paused a writer and a looker) leave `park_pending_wipe`: the browser is never put away under either name, it is emptied.
 */
export async function settlePark(botId: string, jobId: string, outcome: SignInsResult | null, now: Date = new Date(), /** The number of the pause this settles; read from the job when the caller does not know it. */ pause?: number): Promise<'settled' | 'wiped' | 'waiting'> {
  const machine = await prisma.brickComputer.findUnique({ where: { botId }, select: { parkPendingWipe: true } });
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, prepState: true, pauses: true } });
  const generation = pause ?? job?.pauses;
  // The job paused again since this pause: the marker is the later pause's now, and the later pause settles it (CodeRabbit A9)
  if (job && generation !== undefined && job.pauses !== generation) return 'waiting';
  // A job that is on the machine again owns the live browser (its own restore replaced it): nothing of its pause is left to clean up. Only once that restore is settled (CodeRabbit A8): while it is `restoring` or
  // `recover` the browser is not the job's yet, and the marker and the wipe it may carry stay until it is (the start's own settlement, or the sweep, lets them go)
  if (job && (job.status === 'running' || job.status === 'waiting')) {
    if (job.prepState !== null) return 'waiting';
    await clearParkPending(botId, jobId, generation === undefined ? undefined : { pauses: generation });
    return 'settled';
  }
  if (outcome && parkDone(outcome) && !machine?.parkPendingWipe) {
    // The result is written again here (the same value, for the same pause): the park's own write may have failed, and the marker stays until it is on the row (the sweep finishes it otherwise)
    const wasKept = keptOfPark(outcome);
    if (wasKept !== undefined && !(await recordKept(jobId, wasKept, generation))) return 'waiting';
    await clearParkPending(botId, jobId, generation === undefined ? undefined : { pauses: generation });
    return 'settled';
  }
  const cleared = await wipeLiveProfile(botId, jobId, now, generation === undefined ? undefined : { pauses: generation });
  // A job on the machine uses the browser: nothing is emptied under it, and the marker (with the wipe it carries) stays until none is left, when the pass that follows its ending (or the sweep) empties it (round 8, F)
  if (cleared.state !== 'cleared') return 'waiting';
  // The browser was emptied: this pause kept nothing, so the job has no browser of its own to wait for when it carries on
  if (cleared.state === 'cleared' && !(await recordKept(jobId, false, generation))) return 'waiting';
  await clearParkPending(botId, jobId, generation === undefined ? undefined : { pauses: generation });
  return 'wiped';
}

/**
 * The machine no longer waits for this job's browser to be put away: whatever was to be done on it is done (or was never there to do). With `bound` it lets go only while the job is still on the pause (and, for a start, the room)
 * the caller settled: the job's row is read under a share lock, which a pause's own lock on the job (it is taken first, at the top of its commit) excludes, so a pause that lands between the caller's decision and this write is either
 * seen here or waits for it, and its new marker is never cleared by an older settlement (CodeRabbit A9, A12). A job whose row is locked by someone else is left for the next settlement: nothing is cleared on a guess.
 */
export async function clearParkPending(botId: string, jobId: string, bound?: { pauses: number; reservation?: string }): Promise<void> {
  const fail = (error: unknown) => console.error('[Computer] Could not let go of a park that is done:', error instanceof Error ? error.message : 'unknown');
  if (!bound) {
    await prisma.brickComputer.updateMany({ where: { botId, parkPendingJobId: jobId }, data: { parkPendingJobId: null, parkPendingWipe: false } }).catch(fail);
    return;
  }
  await prisma
    .$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pauses: number; status: string; reservation_key: string | null }>>`SELECT "pauses", "status", "reservation_key" FROM "computer_jobs" WHERE "id" = ${jobId} FOR SHARE SKIP LOCKED`;
        // A row that is locked by another write is skipped, and then none is read: that is not a job that is gone
        const locked = rows.length === 0 && (await tx.computerJob.count({ where: { id: jobId } })) > 0;
        if (locked) return;
        const row = rows[0];
        if (row && (row.pauses !== bound.pauses || (bound.reservation !== undefined && (row.reservation_key !== bound.reservation || !isHeld(row.status))))) return;
        await tx.brickComputer.updateMany({ where: { botId, parkPendingJobId: jobId }, data: { parkPendingJobId: null, parkPendingWipe: false } });
      },
      { timeout: 15_000, maxWait: 15_000 },
    )
    .catch(fail);
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
    // Only this job's PARKED copy is thrown away: the live browser may still hold its sign-ins (a pause that committed and was never put away), so the marker goes only once the live browser is proved empty (CodeRabbit on #1025)
    if (answer.done === 'dropped') {
      const mark = (await prisma.brickComputer.findUnique({ where: { botId }, select: { parkPendingJobId: true } }))?.parkPendingJobId;
      if (mark === jobId) await settlePark(botId, jobId, null, now);
    }
    return logged('dropped', answer.done === 'dropped' ? result('dropped') : result('failed', answer.reason));
  } catch (error) {
    console.error('[Computer] Could not drop a job’s browser sign-ins:', error instanceof Error ? error.message : 'unknown');
    return result('failed', 'error');
  }
}

const lastSwept = new Map<string, number>();
/** The Brick the last sweep stopped at: the next one starts after it, so no page of Bricks can hold up the ones behind it. Null = start from the first. */
let sweptAfter: string | null = null;
/** How many Bricks one sweep looks at in a page, and how many pages it takes before it leaves the rest to the next sweep. */
const SWEEP_PAGE = 200;
const SWEEP_PAGES = 2;
/** The page size in use. Only a test lowers it, so that the cursor's wrapping can be shown with a handful of Bricks instead of hundreds. */
let sweepPage = SWEEP_PAGE;

/** For tests: forget when each machine was last looked at, start again from the first Brick, and (with `page`) make a page that small. */
export function resetSignInsSweepForTests(page?: number): void {
  lastSwept.clear();
  sweptAfter = null;
  sweepPage = page ?? SWEEP_PAGE;
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
    // Bricks are taken in order of their id, from where the last sweep stopped: without that, a page of Bricks that are all inside the hour would be
    // read again every sweep and the ones behind them would keep their expired sign-ins for good (CodeRabbit on #1025, lib/computer-browser-profile.ts:256).
    // The cursor wraps, so every Brick is reached however many there are, and a sweep that finds nothing after it starts again from the beginning
    for (let page = 0; page < SWEEP_PAGES; page++) {
      const stale = await prisma.computerJob.findMany({
        where: { status: 'queued', pauses: { gt: 0 }, pausedAt: { lt: before }, ...(sweptAfter ? { botId: { gt: sweptAfter } } : {}) },
        select: { botId: true, id: true },
        distinct: ['botId'],
        orderBy: { botId: 'asc' },
        take: sweepPage,
      });
      if (stale.length === 0) {
        // The end of the Bricks: the next sweep starts from the first one again
        if (!sweptAfter) break;
        sweptAfter = null;
        continue;
      }
      sweptAfter = stale[stale.length - 1].botId;
      for (const { botId, id } of stale) {
        if ((lastSwept.get(botId) ?? 0) > now.getTime() - SWEEP_EVERY_MS) continue;
        const machine = await awakeMachine(botId);
        if (!machine || !isSafeJobId(id)) continue;
        // Read AGAIN after the wait: a sweep running beside this one may have taken this Brick while this one waited for the machine, and two prunes
        // an hour apart is the whole point of the throttle. The write below happens before the next wait, so this closes the window (CodeRabbit N on #1025)
        if ((lastSwept.get(botId) ?? 0) > now.getTime() - SWEEP_EVERY_MS) continue;
        looked++;
        lastSwept.set(botId, now.getTime());
        const answer = await onMachine(machine, 'prune', id, await allowedToKeep(botId, now, hours), hours);
        if (answer.done === 'dropped') pruned++;
      }
      if (stale.length < sweepPage) {
        sweptAfter = null;
        break;
      }
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
