import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import type { MeterEventInput } from '@/lib/meter-values';
import { getBrickLimits } from '@/lib/bot-limits';
import { drawComputerCredit } from '@/lib/computer-credit';
import { DISK_ROOM_PREFIX, diskRoomKey, lockPool, memberAllowance, releaseRoom, renewRoomIn, reserveDiskRoom, reserveRoom, settleRoom, type NoRoom } from '@/lib/meter-allowance';
import { monthOf } from '@/lib/meter-values';
import { checkSpend } from '@/lib/spend-rules';
import { priceChanges, pinnedMicrosPerMinute } from '@/lib/spend-rules-values';
import { getComputerProvider, type ComputerProvider } from '@/lib/computer-provider';
import { renewJobTokens, revokeJobTokens, TOKEN_RENEW_EVERY_SECONDS } from '@/lib/computer-token';
import {
  beginTransition,
  CONTROL_TIMING,
  drainHumanInput,
  finishTransition,
  humanHasControl,
  leaseLapsed,
  readControl,
  releaseIfUnheld,
  releaseLease,
  renewTransition,
  resumeTransition,
  sleep,
} from '@/lib/computer-control';
import { cleanStepLabel } from '@/lib/computer-redact';
import { appendStep } from '@/lib/computer-job-steps';
import { CALL_IN_LAST_STRETCH, HOLD_IN_LAST_STRETCH } from '@/lib/computer-stretch';
import { tellIn } from '@/lib/computer-tellings';
import { callRoomKey, endIfCutoffDecided, endStuckCutoffs, giveBackModelCalls, releaseUnadmittedCallRoom, settleModelCall } from '@/lib/computer-calls';
import { recordKeptBytes } from '@/lib/computer-disk';
import { reconcileComputers } from '@/lib/computer-reconcile';
import { bringBackFromCold, coldStep, dropColdCopiesIfNewer } from '@/lib/computer-cold';
import { computerQuote, connectedApp, routeJob, stepsReview, type RoutePlan } from '@/lib/computer-route';
import { parseFilesList, readFilesList, type FilesList } from '@/lib/computer-files';
import { computersArePaused } from '@/lib/capability-pause';
import { noteHands, recordVisits } from '@/lib/computer-visits';
import { HAND_OVER_ALIVE_MS, HAND_OVER_BEAT_MS, HAND_OVER_LATEST_MS, handOverFiles } from '@/lib/computer-file-cards';
import { cleanEndNote } from '@/lib/computer-report';
import { hasFinishIntent, hasPoolCutoff, hasTurnAdmitted, lockCutoff, lockRelayReach } from '@/lib/computer-faults';
import { extendHoldIn } from '@/lib/computer-lease';
import { epochMatches, leaseUntil, lockJob, lockJobRow, noEndingWhere, ownerWhere, SUPERSEDED, type EpochSaid } from '@/lib/computer-owner';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { recordRefundObligationsForBrick, sweepRefundObligations } from '@/lib/computer-refunds';
import { decidePendingForPurge, decideRunnerFinish, lockPerson, readGiveBackLimits, writeDecision, writeOrbitDecision, markDeliveredLate, noteEffectSettled, sweepGiveBackDecisions, sweepLateEvidence, type Verdict } from '@/lib/computer-giveback';
import {
  AFTER_TAKE_OVER,
  HOLDS_MACHINE,
  PERSON_ONLY,
  costOfSeconds,
  givenBackJob,
  type FinishCause,
  isOver,
  roomFor,
  silentEnding,
  startStateOf,
  type StartState,
  type EffectKind,
  type EndedBy,
  type MachineState,
  type QueuedFor,
  type WaitingFor,
  NOT_PAUSED,
  type PausedWhy,
  CLEAN_CLAIM_STALE_MS,
} from '@/lib/computer-values';
import {
  clearParkPending,
  dropProfile,
  finishPendingParks,
  parkWorthWaitingFor,
  parkProfile,
  recoverResumedBrowsers,
  restoreProfile,
  settlePark,
  settleResumedBrowser,
} from '@/lib/computer-browser-profile';
import { carryOnFrom, type FreshBecause, type NamedJob } from '@/lib/computer-continue';
import { claimCommandIn, commandRow, keepOutcome, seenCommand, type Command } from '@/lib/computer-commands';

/**
 * A Brick's computer, and the jobs on it (game #2000, Brick 9).
 *
 * What this keeps, in one place:
 *  - One lasting computer per Brick. Giving a Brick a computer makes no machine; the machine is made by the first job that
 *    needs it, once, and is never copied, replaced or reset after.
 *  - No switch per person. The owner gives their own Brick a computer, and the meter's allowance (game #1998) is the bound:
 *    room is reserved before a job runs and renewed while it does, and when it is used up the job stays queued with its work
 *    saved and the person can "Ask for more".
 *  - One WRITING job at a time (the database holds it: computer_jobs_one_writer). Later jobs queue. A job proven read-only
 *    (`writes` false) may overlap.
 *  - Choosing a route wakes nothing, and neither does watching: only starting a job calls `create` or `wake`.
 *  - Brick hands over before it sends the person's details, signs in, uploads, pays or submits, and never pays or submits itself.
 *  - An effect outside the computer is written before it is tried and once per key, so a retry never does it twice.
 */

const SECOND = 1000;

type Provider = ComputerProvider;

export type JobStatusWord = 'queued' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed';

export interface JobView {
  id: string;
  title: string;
  status: JobStatusWord;
  queuedFor: QueuedFor | null;
  endedBy: EndedBy | null;
  writes: boolean;
  stepDone: number;
  stepTotal: number | null;
  stepLabel: string | null;
  waitingFor: WaitingFor | null;
  control: 'brick' | 'person';
  /** What Brick is ready to put in at the hand-over and where, as it named it: the person's one tap fills in this and nothing else. */
  ready: { what: string; where: string } | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** Details the person asked Brick to fill in, still to be done: what and where. Brick does only these, and only now. */
  detailsToFill: { key: string; what: string; where: string }[];
  /** A paused job (status `queued`, queuedFor `paused`): when and why (the person's own Pause, their month used up, or a limit they set). Null for every other job. */
  pausedAt: Date | null;
  pausedWhy: PausedWhy | null;
  /** The job was paused before and has its work so far (a job "Do this next" put back in line carries on by itself, next). */
  pausedBefore: boolean;
}

export interface ComputerView {
  /** False on a server with no computer provider: nothing is made and the page says computers are not open yet. */
  available: boolean;
  /** The owner gave this Brick a computer and has not turned it off. */
  on: boolean;
  machine: MachineState;
  /** The job that has the machine (running, or waiting for its person); null when it rests. */
  job: JobView | null;
  /** Jobs in line behind it, or waiting for the person's allowance. */
  queued: JobView[];
  /** The person's month for computers: the share left (0 to 1), or null when no allowance is set up yet. Never a count or a price. */
  month: { leftFraction: number; unlimited: boolean; endsAt: Date } | null;
  files: { bytes: number; savedAt: Date | null; /** What was on the computer when its last job ended; null until one has. */ list: FilesList | null };
  /** The day its files came from, after a restore from a backup. */
  restoredFrom: Date | null;
  /** True after a return from cold storage that had to use the copy before the newest one: the person is told which day their files are from. */
  olderCopyUsed: boolean;
  /** The day the computer was packed away into cold storage; null unless it is cold now. */
  packedAt: Date | null;
  /**
   * How the last job ended, when the person should be told: it waited for them and nobody answered in time, or this month's computer
   * time ran out. Only while it is the Brick's latest job and has not been dismissed: a newer job, or "dismiss", takes it away,
   * and it is never asked again for an old job. Null for every other ending (done, stopped by the person, failed).
   */
  notice: { jobId: string; how: 'unanswered' | 'month'; endedAt: Date | null } | null;
}

/** The endings the person is told about; every other way a job ends says nothing. */
const NOTICE_BY_ENDING: Partial<Record<EndedBy, 'unanswered' | 'month'>> = { unanswered: 'unanswered', allowance: 'month' };

const toNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

type JobRow = {
  id: string;
  title: string;
  status: string;
  queuedFor: string | null;
  endedBy: string | null;
  writes: boolean;
  stepDone: number;
  stepTotal: number | null;
  stepLabel: string | null;
  waitingFor: string | null;
  readyWhat: string | null;
  readyWhere: string | null;
  control: string;
  startedAt: Date | null;
  endedAt: Date | null;
  pausedAt?: Date | null;
  pausedWhy?: string | null;
  pauses?: number;
  effects?: { effectKey: string; kind: string; state: string; evidence: string | null }[];
};

/**
 * What and where are kept apart by a character that cannot be in either (they are cleaned of control characters when Brick names them),
 * and the key of an approval is a hash of the pair, so "A:B" with "C" and "A" with "B:C" never share one and no value can pass for two.
 */
const DETAILS_SEPARATOR = '\u001f';
const cleanDetail = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
export const detailsKey = (what: string, where: string) => `details:${createHash('sha256').update(JSON.stringify([what, where])).digest('hex').slice(0, 40)}`;

/** What the owner is told about a job. The evidence of an effect is where it went, never what was in it. */
function jobView(row: JobRow): JobView {
  const detailsToFill = (row.effects ?? [])
    .filter((effect) => effect.kind === 'details' && effect.state === 'approved')
    .map((effect) => {
      const [what, where] = (effect.evidence ?? '').split(DETAILS_SEPARATOR);
      return { key: effect.effectKey, what: what ?? '', where: where ?? '' };
    });
  return {
    id: row.id,
    title: row.title,
    status: row.status as JobStatusWord,
    queuedFor: row.queuedFor as QueuedFor | null,
    endedBy: row.endedBy as EndedBy | null,
    writes: row.writes,
    stepDone: row.stepDone,
    stepTotal: row.stepTotal,
    // Read through the same rule it is written with: a label stored before the rule, or by any other route, never shows a secret
    stepLabel: cleanStepLabel(row.stepLabel),
    waitingFor: row.waitingFor as WaitingFor | null,
    control: row.control === 'person' ? 'person' : 'brick',
    ready: row.readyWhat && row.readyWhere ? { what: row.readyWhat, where: row.readyWhere } : null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    detailsToFill,
    pausedAt: row.queuedFor === 'paused' ? (row.pausedAt ?? null) : null,
    pausedWhy: row.queuedFor === 'paused' ? ((row.pausedWhy ?? null) as PausedWhy | null) : null,
    pausedBefore: (row.pauses ?? 0) > 0,
  };
}

const JOB_INCLUDE = { effects: { select: { effectKey: true, kind: true, state: true, evidence: true } } } as const;

export async function brickOf(botId: string, ownerId: string) {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  return bot && ownsBrick(bot, ownerId) ? bot : null;
}

/** The provider for this computer: the server's, when it is the one that holds the machine. A machine of another provider is not reached. */
export function providerFor(row: { provider: string } | null): Provider | null {
  const provider = getComputerProvider();
  if (!provider) return null;
  return row && row.provider !== provider.kind ? null : provider;
}

/** A person's month as the owner is shown it: a share, never a count or a price. */
async function monthOfPerson(personId: string, now: Date): Promise<ComputerView['month']> {
  const settings = await getMeterSettings();
  const state = await memberAllowance(personId, now, settings);
  if (!state || settings.memberAllowanceMicros === null) return null;
  const endsAt = monthOf(now).end;
  if (state.unlimited || state.leftMicros === null) return { leftFraction: 1, unlimited: true, endsAt };
  // Against what they have now: their month (the default, or what an exception says for them) and credit given to them for computers
  const total = state.baseMicros + state.creditTotalMicros;
  return { leftFraction: total > 0 ? Math.max(0, Math.min(1, state.leftMicros / total)) : 0, unlimited: false, endsAt };
}

/** What the owner sees about a Brick's computer. Null when the Brick is not theirs. Reads only: it never makes or wakes anything. */
export async function computerView(botId: string, ownerId: string, now: Date = new Date()): Promise<ComputerView | null> {
  if (!(await brickOf(botId, ownerId))) return null;
  const available = getComputerProvider() !== null;
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  // In the order the line is taken (paused jobs keep their place in it): the highest rank first, then the oldest
  const jobs = await prisma.computerJob.findMany({
    where: { botId, status: { in: ['running', 'waiting', 'queued'] } },
    orderBy: [{ queueRank: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: JOB_INCLUDE,
  });
  const holding = jobs.find((job) => HOLDS_MACHINE.includes(job.status as never)) ?? null;
  return {
    available,
    on: !!row && row.enabled,
    machine: (row?.machine ?? 'none') as MachineState,
    job: holding ? jobView(holding) : null,
    queued: jobs.filter((job) => job.status === 'queued').map(jobView),
    month: row?.enabled ? await monthOfPerson(ownerId, now) : null,
    files: { bytes: toNumber(row?.filesBytes), savedAt: row?.filesSavedAt ?? null, list: readFilesList(row?.filesList) },
    restoredFrom: row?.restoredFrom ?? null,
    olderCopyUsed: !!row && row.olderCopyUsed,
    packedAt: row?.machine === 'cold' ? (row.packedAt ?? null) : null,
    notice: await noticeOf(botId, row?.noticeDismissedJobId ?? null),
  };
}

/** The ending to tell the person about: the Brick's latest job, only if it ended for a reason they should hear and was not dismissed. */
async function noticeOf(botId: string, dismissedJobId: string | null): Promise<ComputerView['notice']> {
  const latest = await prisma.computerJob.findFirst({ where: { botId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, endedBy: true, endedAt: true } });
  if (!latest || latest.status !== 'stopped' || latest.id === dismissedJobId) return null;
  const how = NOTICE_BY_ENDING[latest.endedBy as EndedBy];
  return how ? { jobId: latest.id, how, endedAt: latest.endedAt } : null;
}

export type Dismissed = { ok: true; view: ComputerView } | { ok: false; reason: 'not_found' };

/**
 * "Dismiss" on the notice: that job's ending is not shown again, on the page or in the chat. It names the job it was shown for, so a
 * newer ending that arrived in between is not dismissed by mistake. Asked twice, or for a job that is not the notice, it changes nothing.
 */
export async function dismissComputerNotice(botId: string, ownerId: string, jobId: string, now: Date = new Date()): Promise<Dismissed> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const view = await computerView(botId, ownerId, now);
  if (view?.notice?.jobId === jobId) await prisma.brickComputer.updateMany({ where: { botId }, data: { noticeDismissedJobId: jobId } });
  return { ok: true, view: (await computerView(botId, ownerId, now)) as ComputerView };
}

export type Given = { ok: true; view: ComputerView } | { ok: false; reason: 'not_found' | 'not_open' };

/**
 * "Give Brick a computer": the owner turns it on for their own Brick. No machine is made: that waits for a job that needs one.
 * Asked twice it is the same computer. Nothing here is per person, and nothing the owner does here costs anything.
 */
export async function giveComputer(botId: string, ownerId: string, now: Date = new Date()): Promise<Given> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const provider = getComputerProvider();
  if (!provider || (await isWindingDown())) return { ok: false, reason: 'not_open' };
  const existing = await prisma.brickComputer.findUnique({ where: { botId } });
  if (existing && existing.provider !== provider.kind) return { ok: false, reason: 'not_open' };
  await prisma.brickComputer.upsert({ where: { botId }, create: { botId, enabled: true, provider: provider.kind }, update: { enabled: true } });
  return { ok: true, view: (await computerView(botId, ownerId, now)) as ComputerView };
}

/**
 * "Turn off computer": whatever it was doing stops at once and its files are saved and kept. Brick goes back to answers and
 * apps. Asked twice it is the same.
 */
export async function turnOffComputer(botId: string, ownerId: string, now: Date = new Date()): Promise<ComputerView | null> {
  if (!(await brickOf(botId, ownerId))) return null;
  // Off first: the sweep starts nothing for a computer that is off, so no queued job can slip in while the work is being stopped
  await prisma.brickComputer.updateMany({ where: { botId }, data: { enabled: false } });
  await stopComputerWork(botId, 'off', now);
  return computerView(botId, ownerId, now);
}

/**
 * Every job of this Brick stops and the machine rests, for a reason that is not the person's tap: the computer was turned off,
 * or the Brick was deleted (every right it held is withdrawn at once). Never throws: a delete or a switch must not fail over it.
 */
export async function stopComputerWork(botId: string, why: 'off' | 'deleted', now: Date = new Date()): Promise<void> {
  try {
    const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['queued', 'running', 'waiting'] } }, select: { id: true } });
    for (const job of jobs) await endJob(job.id, 'stopped', why, now);
    const row = await prisma.brickComputer.findUnique({ where: { botId } });
    const provider = providerFor(row);
    // A computer being packed away or brought back is in the hands of that step, which also stops for a deleted Brick
    if (row && row.providerRef && provider && row.machine !== 'none' && row.machine !== 'stopped' && row.machine !== 'packing' && row.packStage !== 'returning') {
      // Stopping keeps the disk, and the files are saved first so Files can show the last saved copy
      await saveCopy(botId, row.providerRef, provider);
      await stopMachine(botId, row.providerRef, provider);
    }
  } catch (error) {
    console.error('[Computer] Could not stop a Brick’s work:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * Saves the machine's home folder and remembers when. A copy that failed says nothing: the last saved day stays as it was, and
 * "saved" is never claimed for a save that did not happen.
 */
async function saveCopy(botId: string, ref: string, provider: Provider): Promise<boolean> {
  try {
    const copy = await provider.saveFiles(ref);
    await prisma.brickComputer.updateMany({ where: { botId }, data: { filesBytes: BigInt(Math.max(0, Math.trunc(copy.bytes))), filesSavedAt: copy.savedAt } });
    // The copy is kept in our own storage, beside the machine's disk: what is kept is written when its size changes
    await recordKeptBytes({ botId, reason: 'saved', machineBytes: provider.diskBytes?.() ?? null, copyBytes: Math.max(0, Math.trunc(copy.bytes)) });
    // A plain copy newer than the cold-storage ones now exists, so those are not kept (they cost bucket space and say nothing newer)
    await dropColdCopiesIfNewer(botId);
    return true;
  } catch (error) {
    console.error('[Computer] Could not save a copy of the files:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * Puts a machine to sleep and says so only when the provider proves it. A stop that was refused, or a look that could not be made, leaves it
 * `stopping`: nothing uses it, it still counts as awake for the wind-down, and every sweep tries again. `only` limits which stored states this
 * may rewrite (the caller knows what it saw). Returns whether the machine is proved asleep.
 */
async function stopMachine(botId: string, ref: string, provider: Provider, only?: string[]): Promise<boolean> {
  const proven = await stopAtProvider(ref, provider);
  await noteStopped(botId, ref, proven, only);
  return proven;
}

/** Stops the machine at the provider and says whether it is proved asleep. Writes nothing. */
async function stopAtProvider(ref: string, provider: Provider): Promise<boolean> {
  try {
    await provider.stop(ref);
  } catch (error) {
    console.error('[Computer] Could not stop a machine:', error instanceof Error ? error.message : 'unknown');
  }
  return provider
    .awake(ref)
    .then((awake) => !awake)
    .catch(() => false);
}

async function noteStopped(botId: string, ref: string, proven: boolean, only?: string[], db: Pick<typeof prisma, 'brickComputer'> = prisma): Promise<void> {
  await db.brickComputer.updateMany({ where: { botId, providerRef: ref, ...(only ? { machine: { in: only } } : {}) }, data: { machine: proven ? 'stopped' : 'stopping', restClaimedAt: null } });
}

/** Whether the take-over leader still leads. Given a connection, it asks through that one (the stop is made while that connection holds the computer's row). */
type StillLeader = (db?: Pick<typeof prisma, 'brickComputer'>) => Promise<boolean>;

/**
 * Stops the machine for a take-over leader that could not prove its fence, only while it is still the leader, and with the stop held inside the
 * lock on the computer's row. Every change of hands (a leader that took the transition over, the move to `human_ready`, a hand-back) writes that
 * row, so none can happen between the leadership check and the end of the stop: the stop can never take effect after the person was given the
 * screen. False when it was no longer the leader (nothing was stopped).
 */
async function stopMachineWhileLeader(botId: string, ref: string, provider: Provider, stillLeader?: StillLeader): Promise<boolean> {
  // The provider's calls are inside the lock, so they are given less time than the transaction has: a stop that takes longer is not proved (the machine is
  // `stopping` and every sweep tries again), and the record is still written before the transaction ends, never rolled back with it
  let stopped = false;
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
        // Asked through this transaction's own connection (it holds the row, so another connection's write to it would wait for this one)
        if (stillLeader && !(await stillLeader(tx))) return null;
        stopped = true;
        const proven = await withinMs(stopAtProvider(ref, provider), leaderStop.deadlineMs, false);
        // Written before the lock is let go: a replacement transition that sets this machine's state waits for the lock and comes after this record, so this
        // record can never overwrite what it wrote
        await noteStopped(botId, ref, proven, undefined, tx);
        return true;
      },
      { timeout: leaderStop.transactionMs, maxWait: 10_000 },
    );
    return outcome === true;
  } catch (error) {
    // The transaction ended badly (a database that did not answer in time, a lost connection) after the stop was sent: the record may have been rolled back
    // with it, so it still says `working` for a machine that may be asleep. It is written again, outside the lock and only where it still says `working`
    // (a change of hands that came after has its own state and is not overwritten): `stopping`, which nothing uses and the sweep proves or tries again.
    if (!stopped) throw error;
    console.error('[Computer] A leader’s stop did not finish in its transaction, the machine is marked to be proved asleep:', error instanceof Error ? error.message : 'unknown');
    Sentry.captureException(error, { tags: { area: 'computer', step: 'leader-stop' } });
    await noteStopped(botId, ref, false, ['working']);
    return true;
  }
}

/** How long a leader's stop may hold the computer's row: the provider's calls get the first part of it, the record the rest. Changed only by tests. */
const leaderStop = { deadlineMs: 90_000, transactionMs: 120_000 };
export function setLeaderStopTimesForTests(times: { deadlineMs: number; transactionMs: number } | null): void {
  leaderStop.deadlineMs = times?.deadlineMs ?? 90_000;
  leaderStop.transactionMs = times?.transactionMs ?? 120_000;
}

/** What a promise says, or `fallback` when it has not said it within `ms`. The promise is left to finish on its own; a throw from it is the fallback too. */
async function withinMs<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- Jobs ----------

/** The earlier start an `earlier` answer names: the job, how it stands now, and the key it was made under (so the game adopts it as its open start). */
export interface EarlierStart {
  /** Null for an earlier start that is still going on and has made no job yet (`state: 'starting'`): the game adopts its key and looks it up. */
  id: string | null;
  status: string | null;
  state: StartState | 'starting';
  attempt: string | null;
}

export type Started =
  /** `continued`: the job carries on in the conversation of the ended job the start named ("try again", piece 8): a new job, its own reservation and receipt. */
  | { ok: true; job: JobView; restoredFrom: Date | null; continued?: true }
  /** Not the owner's Brick, or not theirs to ask: only the owner starts computer work on their Brick. */
  | { ok: false; reason: 'not_owner' | 'off' | 'not_open' | 'broken_start' | 'no_run' | 'paused' }
  /** A connected app would do this for less than the computer: nothing is started, and the Brick is told which app to use. */
  | { ok: false; reason: 'cheaper_route'; app: string }
  /** The meter's controls are not set up yet: a computer does not open before they do. */
  | { ok: false; reason: 'not_set' }
  /** The start says it acks, and an earlier start of this person on this Brick has not been confirmed by the game yet: nothing was made, and the OLDEST such job is named with the key it was made under. Not a refusal of the ask: the game reads it as the earlier job it asked for. Returning it acks nothing. */
  | { ok: false; reason: 'earlier'; job: EarlierStart }
  /** A rule the person said in chat does not let this job take room: nothing is left behind, and the rule's own words come with it. */
  | { ok: false; reason: 'rule'; words: string }
  /** This start was delayed past its life (it stopped beating) and no job may be made for it now: the game starts afresh under a new key. */
  | { ok: false; reason: 'expired' }
  /**
   * "Try again" named a job that cannot be carried on (GPT round 6, finding 6): NOTHING was made or reserved. `why` says which (lib/computer-continue `FreshBecause`); `job` is the named job's title and how it stands
   * (only the asker's own: never for not_found / not_theirs). Brick says so and offers "Start a new job" as its own choice: an ordinary start under a new key, with no continuation header.
   */
  | { ok: false; reason: 'cannot_continue'; why: FreshBecause; job?: NamedJob };

/** Room is asked for once for each try to run a job: room that was released stays closed, so a later try asks under a new key. */
/** The longest a disk's room is kept for a job that is still starting its machine (the job's own room renews each few minutes, this one does not). */
const DISK_ROOM_MAX_HOLD_MS = 30 * 60 * 1000;
const roomKey = (jobId: string, now: Date) => `computer:job:${jobId}:${now.getTime()}`;

const queueReasonOf = (no: NoRoom): QueuedFor | null => (no.reason === 'allowance' ? 'allowance' : no.reason === 'busy' ? 'busy' : no.reason === 'pool' ? 'pool' : null);

/**
 * The review at 20 app steps (the bot server counts them): whether the steps an app has taken so far cost as much as the whole job is expected
 * to cost on this Brick's computer, so the Brick should weigh moving the rest there. Advice only: it reads, never makes, wakes, reserves or
 * writes anything, and says no where there is no computer to move to (not the owner, off, not open, or a wind-down).
 */
export async function reviewAppSteps(botId: string, personId: string, input: { app: string; steps: number }): Promise<{ review: boolean }> {
  if (!(await brickOf(botId, personId))) return { review: false };
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = row?.enabled ? providerFor(row) : null;
  if (!row || !provider || (await isWindingDown())) return { review: false };
  // A name that matches no connected app (it was disconnected since, or the bot server names it differently) is still steps that were taken, at a
  // rate we cannot read: it is priced at the dearest tier like any unknown rate, never as nothing. The only result is a line of advice.
  const app = await connectedApp(botId, input.app);
  const computer = computerQuote({ awakeMicrosPerMinute: provider.microsPerMinute() ?? null, hasMachine: !!row.providerRef });
  return { review: stepsReview({ steps: input.steps, stepMicros: app ? app.stepMicros : null, computer }) };
}

/**
 * Starts a job on a Brick's computer. Only its owner starts work on it. The job is saved first and then tried: if another job
 * is writing it waits its turn, if the person's allowance or our room is used up it waits with its work saved (and the first
 * leads to "Ask for more"), and otherwise it runs and the machine is made or woken, here and nowhere else.
 */
/**
 * Whether a start the bot server could not see the answer of did reach Orbit: the newest job of this Brick for this person that began in the direct chat `originRef` with this title (as `startJob` stores it:
 * trimmed, at most 200 characters), made no longer ago than `sinceSeconds` by Orbit's OWN clock (an elapsed time, so the two servers never compare clocks). Another person's or another Brick's job never matches.
 * Read only. Answers its id and status, or null.
 */
export async function startedJobFor(botId: string, personId: string, startKey: string, now: Date = new Date()): Promise<{ id: string; status: string } | { inProgress: true } | null> {
  // A start with this key that is still going on comes first: it has not saved its job yet, so "nothing found" is not a miss while the start can still make it. Only once no start is going on is the job this key made
  // (or nothing) the answer, and a start that finished in between has saved its job before it removed its mark, so the look made after the mark is gone sees it. The key alone says which start: never a job of the
  // same chat or title, however recent
  if (await startIsGoingOn(startFenceOf(botId, personId, startKey), now, { botId, personId, startKey })) return { inProgress: true };
  const own = await prisma.computerJob.findUnique({ where: { botId_personId_startKey: { botId, personId, startKey } }, select: { id: true, status: true } });
  if (own) return own;
  // Finding 1 (GPT round 6): a start that was answered with another start's job (`earlier`) is answered with THAT job, for as long as it exists: the look never says "no job" for a request a job answered
  const answered = await attemptAnswer(botId, personId, startKey, now);
  if (answered && 'job' in answered) return { id: answered.job.id, status: answered.job.status };
  if (answered && 'starting' in answered) return { inProgress: true };
  return null;
}

/**
 * The game confirms it has the answer of the start it made under `startKey` (its own word, sent only once it holds the answer: a look-up never confirms, it is read only): the job's start is confirmed, once, by this person on this Brick. Idempotent. A key that made no job, or
 * another person's or Brick's key, changes nothing (never learned apart). Answers whether this key has a job of this person's on this Brick.
 */
export async function ackStart(botId: string, personId: string, startKey: string, now: Date = new Date()): Promise<boolean> {
  // Under the same person lock the keyed start makes its job under, in one transaction: an ack that arrives while that start is still deciding waits for it, then confirms the job it made (never `true` with the job left unconfirmed)
  return prisma.$transaction(
    async (tx) => {
      await lockPerson(tx, personId);
      await tx.computerJob.updateMany({ where: { botId, personId, startKey, startAckedAt: null }, data: { startAckedAt: now } });
      return (await tx.computerJob.count({ where: { botId, personId, startKey } })) > 0;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

/**
 * The oldest start of this person on this Brick that the game has not confirmed, when a start under ANOTHER key would meet it (`earlier`), or null. Read only: the route asks it BEFORE the spend rule, so a retry under a new key
 * is answered with the job the game asked for earlier even when that job used what a chat-stated rule leaves (never a false `rule`). The decision that makes or refuses a job stays the one under the person's lock in `beginJob`.
 */
export async function earlierUnconfirmedStart(botId: string, personId: string, startKey: string): Promise<EarlierStart | null> {
  const same = await prisma.computerJob.findUnique({ where: { botId_personId_startKey: { botId, personId, startKey } }, select: { id: true } });
  if (same) return null;
  // An older start of this person on this Brick that is still going on (its attempt is open and beating, no job yet) is the earlier start too: the game adopts its key and looks it up
  const mine = await prisma.computerStartAttempt.findUnique({ where: { botId_personId_startKey: { botId, personId, startKey } } });
  if (mine && mine.state === 'open') {
    const going = await prisma.computerStartAttempt.findFirst({
      where: { botId, personId, state: 'open', jobId: null, beatAt: { gt: new Date(Date.now() - attemptLifeMs()) }, id: { not: mine.id }, OR: [{ createdAt: { lt: mine.createdAt } }, { createdAt: mine.createdAt, id: { lt: mine.id } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, startKey: true },
    });
    if (going) {
      // Finding 1: the answer is kept BEFORE it is given, so a retry of this key is answered with that start (whatever it comes to), never makes a job of its own
      if (await answerAttemptIn(prisma, { botId, personId, startKey }, { aliasAttemptId: going.id })) return { id: null, status: null, state: 'starting', attempt: going.startKey };
      return keptAnswerOf(botId, personId, startKey);
    }
  }
  const earlier = await prisma.computerJob.findFirst({ where: { botId, personId, startAckedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, startKey: true } });
  if (!earlier) return null;
  // Finding 1: kept before it is answered (it acknowledges nothing: the earlier job stays unconfirmed until ITS key is acknowledged)
  if (await answerAttemptIn(prisma, { botId, personId, startKey }, { jobId: earlier.id })) return { id: earlier.id, status: earlier.status, state: startStateOf(earlier.status), attempt: earlier.startKey };
  return keptAnswerOf(botId, personId, startKey);
}

/**
 * The answer the key's attempt row durably records, read again after an answer write that stored nothing (a concurrent start under the same key made its own job first, or answered otherwise): that is what the start returns,
 * never the earlier start the write was meant to record. Null when the row records no earlier start (the start goes on and meets the key's own job, or makes one) (CodeRabbit on #1025, 36).
 */
async function keptAnswerOf(botId: string, personId: string, startKey: string): Promise<EarlierStart | null> {
  const answered = await attemptAnswer(botId, personId, startKey);
  if (!answered || 'expired' in answered) return null;
  if ('starting' in answered) return { id: null, status: null, state: 'starting', attempt: answered.starting };
  return { id: answered.job.id, status: answered.job.status, state: startStateOf(answered.job.status), attempt: answered.job.startKey };
}

/**
 * Keeps, durably, that the start under `key` was answered with another start (finding 1, GPT round 6): state `answered`, with the job that answered it, or the attempt it waits for while that one has no job yet.
 * Written before the answer is given. The FIRST answer stored for a key stays: it never touches a start that made its own job (`made`), was superseded or was already answered (a caller that gets `false` reads the stored answer and gives that one: two requests that chose different earlier jobs must not hand the caller two answers), and it acknowledges nothing: the answering job's `start_acked_at` is left as it is.
 */
async function answerAttemptIn(db: Pick<Prisma.TransactionClient, '$executeRaw'>, key: { botId: string; personId: string; startKey: string }, by: { jobId: string } | { aliasAttemptId: string }): Promise<boolean> {
  const jobId = 'jobId' in by ? by.jobId : null;
  const alias = 'aliasAttemptId' in by ? by.aliasAttemptId : null;
  const written = await db.$executeRaw`
    INSERT INTO "computer_start_attempts" ("id", "bot_id", "person_id", "start_key", "state", "job_id", "alias_attempt_id", "beat_at", "created_at")
    VALUES (${randomUUID()}, ${key.botId}, ${key.personId}, ${key.startKey}, 'answered', ${jobId}, ${alias}, NOW(), NOW())
    ON CONFLICT ("bot_id", "person_id", "start_key") DO UPDATE SET "state" = 'answered', "job_id" = EXCLUDED."job_id", "alias_attempt_id" = EXCLUDED."alias_attempt_id"
    WHERE "computer_start_attempts"."state" IN ('open', 'expired')`;
  return written > 0;
}

/** Whether the key's attempt row already holds an answer (state `answered`), read in the caller's transaction after an answer write stored nothing. */
async function storedAnswerIn(tx: Pick<Prisma.TransactionClient, 'computerStartAttempt'>, key: { botId: string; personId: string; startKey: string }): Promise<boolean> {
  const row = await tx.computerStartAttempt.findUnique({ where: { botId_personId_startKey: key }, select: { state: true } });
  return row?.state === 'answered';
}

/** What a start's own attempt row says it was answered with (finding 1): a job, an older start still going on (its key), or a start that ended with no job (`expired`). Null when the row decides nothing (none, open, made, expired on its own). */
type AttemptAnswer = { job: { id: string; status: string; startKey: string | null; startAckedAt: Date | null } } | { starting: string } | { expired: true };

async function attemptAnswer(botId: string, personId: string, startKey: string, now: Date = new Date()): Promise<AttemptAnswer | null> {
  const select = { id: true, state: true, jobId: true, aliasAttemptId: true, startKey: true, beatAt: true } as const;
  let row = await prisma.computerStartAttempt.findUnique({ where: { botId_personId_startKey: { botId, personId, startKey } }, select });
  // Only a start that was answered with another (`answered`, or `superseded` by a job made after it began) is answered from its row. Its own open, made or expired attempt is decided as before
  if (!row || (row.state !== 'answered' && row.state !== 'superseded')) return null;
  // The chain is followed through any number of links (an alias of an alias). Its order is acyclic (an alias is only ever set to an open start made earlier than the one answered), so it ends at a job, a start still going on, or one that ended with no job
  for (let hop = 0; row; hop++) {
    if (row.jobId) {
      const job = await prisma.computerJob.findUnique({ where: { id: row.jobId }, select: { id: true, status: true, startKey: true, startAckedAt: true } });
      return job ? { job } : { expired: true };
    }
    if (row.aliasAttemptId) {
      row = await prisma.computerStartAttempt.findUnique({ where: { id: row.aliasAttemptId }, select });
      continue;
    }
    if (hop > 0 && row.state === 'open' && row.beatAt.getTime() > now.getTime() - attemptLifeMs()) return { starting: row.startKey };
    return { expired: true };
  }
  return { expired: true };
}

/**
 * A start under a key that was ANSWERED before (finding 1): the same answer again, before anything else, whatever happened since (the answering job was acknowledged, ended, or the game forgot its key).
 * While the answering job is unconfirmed it is `earlier` (acknowledging nothing); once it is confirmed it is that job, as a repeated start of it would be. Null when the key's row decides nothing.
 */
export async function startAnsweredBefore(botId: string, personId: string, startKey: string, now: Date = new Date()): Promise<Started | null> {
  const answered = await attemptAnswer(botId, personId, startKey, now);
  if (!answered) return null;
  if ('expired' in answered) return { ok: false, reason: 'expired' };
  if ('starting' in answered) return { ok: false, reason: 'earlier', job: { id: null, status: null, state: 'starting', attempt: answered.starting } };
  const { job } = answered;
  if (!job.startAckedAt) return { ok: false, reason: 'earlier', job: { id: job.id, status: job.status, state: startStateOf(job.status), attempt: job.startKey } };
  return (await reuseJob(botId, { id: job.id }, now)) ?? { ok: false, reason: 'expired' };
}

/** What a start with a key is for: the sha-256 of the Brick, the person and the key. */
export const startFenceOf = (botId: string, personId: string, startKey: string): string => createHash('sha256').update(`${botId}\n${personId}\n${startKey}`).digest('hex');

/**
 * How long a start's mark counts without being renewed, and how often a start that is still working renews it. A start whose process died never removes its mark and never renews it, so it stops counting after
 * `lifeMs` (the sweep deletes it later). A start that is still going on renews it every `beatMs` (a quarter of the life) from the moment it is made until its job is saved or it ends, so it counts for as long
 * as the start can still make its job, however long that takes (a start has no time limit of its own: nothing can cancel the reads and writes it is in the middle of). The numbers are fields, so a test can shorten them.
 */
export const START_MARK_MS = 2 * 60_000;
export const startMarkTiming = { lifeMs: START_MARK_MS, beatMs: START_MARK_MS / 4 };

/** Whether a start for this fence has begun and has not saved its job (or ended without one) within the mark's life. Reads only. */
async function startIsGoingOn(fence: string, now: Date, key?: { botId: string; personId: string; startKey: string }): Promise<boolean> {
  if ((await prisma.computerStartMark.count({ where: { fence, startedAt: { gt: new Date(now.getTime() - startMarkTiming.lifeMs) } } })) > 0) return true;
  // The start's attempt is durable before its job: one that is open and still beating is a start that can still make its job
  return !!key && (await prisma.computerStartAttempt.count({ where: { ...key, state: 'open', beatAt: { gt: new Date(now.getTime() - attemptLifeMs()) } } })) > 0;
}

/** How long a start's attempt counts without a beat: three beats. A start that stopped beating can no longer make a job (a delayed request of it finds its attempt expired, or superseded by the job another start made). */
const attemptLifeMs = (): number => startMarkTiming.beatMs * 3;

/**
 * Opens the start's attempt BEFORE it reads anything, durably, so a start exists before its job row does. The same key again (a retry, a redelivery) that finds its attempt open keeps it beating; one already made, expired or superseded is
 * left as it is (its answer is decided in the transaction that makes the job). Throws when it could not be kept. Answers whether THIS request made the attempt: only the request that made it lets it go when it fails (the same key said
 * twice shares one attempt, and the second request's own trouble must never end the first one's start).
 */
async function openAttempt(botId: string, personId: string, startKey: string, began: Date): Promise<boolean> {
  try {
    // The attempt's time is when the START began, never when this insert ran: an insert that is delayed past another start's job must still sort before that job (CodeRabbit on #1025)
    await prisma.computerStartAttempt.create({ data: { botId, personId, startKey, state: 'open', beatAt: new Date(), createdAt: began } });
    return true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    await prisma.computerStartAttempt.updateMany({ where: { botId, personId, startKey, state: 'open' }, data: { beatAt: new Date() } });
    return false;
  }
}

/** The attempt is still beating: renewed with the start's mark. Never throws. */
const beatAttempt = (botId: string, personId: string, startKey: string) =>
  prisma.computerStartAttempt.updateMany({ where: { botId, personId, startKey, state: 'open' }, data: { beatAt: new Date() } }).catch((error) => console.error('[Computer] Could not renew the attempt of a start:', error instanceof Error ? error.message : 'unknown'));

/** A start that ended with no job made (refused, expired, answered as an earlier one) lets its attempt go: it can make none any more. Never throws. */
const closeAttempt = (botId: string, personId: string, startKey: string) =>
  prisma.computerStartAttempt.updateMany({ where: { botId, personId, startKey, state: 'open' }, data: { state: 'expired' } }).catch((error) => console.error('[Computer] Could not close the attempt of a start:', error instanceof Error ? error.message : 'unknown'));

/** Keeps that a start has begun, BEFORE it reads anything (so the look for it never finds neither the mark nor the job while it can still make the job). Throws when it could not be kept: the start is not made without it. The time is the app's clock, as the renewals and the look use (never the database's own default). */
async function markStart(fence: string): Promise<string> {
  return (await prisma.computerStartMark.create({ data: { fence, startedAt: new Date() }, select: { id: true } })).id;
}

/** Renews a start's mark: it is still going on. Never throws: a beat that is missed is made up by the next one, and a start that dies stops beating (its mark then ages out). */
async function renewStartMark(id: string): Promise<void> {
  await prisma.computerStartMark.updateMany({ where: { id }, data: { startedAt: new Date() } }).catch((error) => console.error('[Computer] Could not renew the mark of a start:', error instanceof Error ? error.message : 'unknown'));
}

/** Removes a start's mark once its job is saved or it ended without one. Never throws: a mark that stays stops counting by itself. */
async function forgetStartMark(id: string): Promise<void> {
  await prisma.computerStartMark.deleteMany({ where: { id } }).catch((error) => console.error('[Computer] Could not remove the mark of a start:', error instanceof Error ? error.message : 'unknown'));
}

/** How long a start that ended with no job is kept while other starts' answers wait on it (they answer `expired` all that time): about a week, far past any retry of the game. */
export const DEAD_ANSWER_MS = 7 * 24 * 60 * 60_000;

/** Marks that were never removed (their process died) are deleted. Returns how many. */
export async function forgetOldStartMarks(now: Date = new Date(), olderThanMs: number = 60 * 60_000): Promise<number> {
  // A start's attempt is the record that its key was answered (a job, another start's job, or `expired`): a delayed copy of a start that finds no row would make a job of its own (CodeRabbit N15 on #1025, Opus's ruling).
  // So no attempt goes after an hour, whatever its state: the one rule is that one with NO job (let go, superseded, answered, or its job taken away: the foreign key leaves it with none) goes a week after its last
  // beat, and the answers that wait on it keep their state (the foreign key leaves them waiting on nothing, which answers `expired`). A start bound to a job stays as long as the job does
  // An alias (a start answered with another start that had no job yet) is kept for as long as the attempt it follows, through any number of hops, leads to a job: it answers that job for the job's whole life, so a
  // key resubmitted after a week never makes a second paid job (CodeRabbit on #1025). Only attempts that lead to no job are let go
  await prisma.$executeRaw`
    DELETE FROM "computer_start_attempts" WHERE "beat_at" < ${new Date(now.getTime() - DEAD_ANSWER_MS)} AND "job_id" IS NULL AND "id" NOT IN (
      WITH RECURSIVE walk("id", "next", "depth") AS (
        SELECT "id", "alias_attempt_id", 1 FROM "computer_start_attempts" WHERE "job_id" IS NULL AND "alias_attempt_id" IS NOT NULL
        UNION ALL
        SELECT walk."id", t."alias_attempt_id", walk."depth" + 1 FROM walk JOIN "computer_start_attempts" t ON t."id" = walk."next" WHERE t."job_id" IS NULL AND t."alias_attempt_id" IS NOT NULL
      )
      SELECT walk."id" FROM walk JOIN "computer_start_attempts" t ON t."id" = walk."next" WHERE t."job_id" IS NOT NULL
    )`;
  return (await prisma.computerStartMark.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - olderThanMs) } } })).count;
}

/** The conversation a job began in: only a direct chat, by its id. A job always goes back to where it began; one with no conversation (a goal's run) goes to the person's own direct chat. */
export interface JobOrigin {
  kind: 'dm';
  ref: string;
}

type StartInput = { botId: string; /** The start says the game acks it (header `X-Computer-Start-Acks`): its job is made unconfirmed, and a start under another key meets an unconfirmed one as `earlier`. Without it the job is confirmed when it is made, as before. */ acks?: boolean; personId: string; title: string; brief?: string | null; writes?: boolean; runId?: string | null; /** The caller's key for this one start: a start repeating it answers the job it made. */ startKey?: string | null; plan?: RoutePlan | null; origin?: JobOrigin | null; /** "Try again" of an ended job (piece 8): the job to carry on in the conversation of. Orbit decides from its own record whether it does (lib/computer-continue); when it does not, the start is an ordinary fresh job. */ continuesJobId?: string | null };
type Begun = { done: Started } | { created: { id: string } };

export async function startJob(input: StartInput, now: Date = new Date()): Promise<Started> {
  // A start with a key opens its attempt FIRST, in one statement, before anything else is written or read (finding 1, GPT round 6): there is no moment where only its mark is visible, so a reworded retry that
  // decides while this one is held sees it (and waits for it), and a job another start made after this one began supersedes it (decided in the transaction that makes the job). Kept beating with the mark
  const began = new Date();
  const opened = input.startKey ? await openAttempt(input.botId, input.personId, input.startKey, began) : false;
  // ...then its mark, from before its first read until its job is saved, or it ends without one, so the look for it (`startedJobFor`) can say it is still going on. A start with no key is never asked about
  const mark = input.startKey
    ? await markStart(startFenceOf(input.botId, input.personId, input.startKey)).catch(async (error) => {
        if (input.startKey && opened) await closeAttempt(input.botId, input.personId, input.startKey);
        throw error;
      })
    : null;
  // The mark is renewed for as long as the start is going on, so a start that takes longer than the mark's life (a slow database, a pool that is busy) is still found to be going on by the look for it,
  // never read as "no job can still reach Orbit". The beat is a timer, not a wait: it never holds the start, and it ends with the start, before the mark is removed
  const beat = mark ? setInterval(() => void Promise.all([renewStartMark(mark), input.startKey ? beatAttempt(input.botId, input.personId, input.startKey) : undefined]), startMarkTiming.beatMs) : null;
  beat?.unref?.();
  let begun: Begun;
  try {
    begun = await beginJob(input, now);
  } catch (error) {
    // A start that failed before its job was saved can make none: its attempt goes (the start is asked again under a key of its own). Only when THIS request made the attempt: the same key said twice shares one, and a
    // second request that met a trouble of its own (a read that failed) must not end the start of the first, which is still going on
    if (input.startKey && opened) await closeAttempt(input.botId, input.personId, input.startKey);
    throw error;
  } finally {
    if (beat) clearInterval(beat);
    if (mark) await forgetStartMark(mark);
  }
  if ('done' in begun) {
    // No job was made by this start (refused, found one that was made earlier, or told it is `earlier`/`expired`): its attempt is over
    if (input.startKey && opened && !(begun.done.ok)) await closeAttempt(input.botId, input.personId, input.startKey);
    return begun.done;
  }
  return tryNewJob(input, now, begun.created);
}

/** Whether a job already exists that THIS start key made (a replay of the key: the start answers with that job, whatever became of the job it continued). */
export async function startKeyHasJob(botId: string, personId: string, startKey: string): Promise<boolean> {
  return !!(await prisma.computerJob.findUnique({ where: { botId_personId_startKey: { botId, personId, startKey } }, select: { id: true } }));
}

/** Everything a start does before its job exists, and the saving of the job: the part its mark covers. */
async function beginJob(input: StartInput, now: Date): Promise<Begun> {
  // Finding 1: a key that was answered with another start's job is answered from its row before anything else: never a job of its own, after acknowledgement, ending or the game forgetting its key
  if (input.startKey) {
    const answered = await startAnsweredBefore(input.botId, input.personId, input.startKey, now);
    if (answered) return { done: answered };
  }
  const bot = await brickOf(input.botId, input.personId);
  if (!bot) return { done: { ok: false, reason: 'not_owner' } };
  const row = await prisma.brickComputer.findUnique({ where: { botId: input.botId } });
  if (!row || !row.enabled) return { done: { ok: false, reason: 'off' } };
  if (!providerFor(row)) return { done: { ok: false, reason: 'not_open' } };
  // A wind-down is on (the team's command): computers take no new work
  if (await isWindingDown()) return { done: { ok: false, reason: 'not_open' } };
  // A run of a goal or task (game #2002) starts one job, ever: the same run again (it was handed out again) finds that job, whatever it
  // came to, and takes no second room. The run must be this person's, on this Brick.
  if (input.runId) {
    if (!(await runIsTheirs(input.botId, input.personId, input.runId))) return { done: { ok: false, reason: 'no_run' } };
    const again = await reuseJob(input.botId, { botId_runId: { botId: input.botId, runId: input.runId } }, now);
    if (again) return { done: again };
  }
  // A start with a key that was already made (the caller asked again: its first answer was lost) finds the job that key made, whatever it came to, and takes no second room
  if (input.startKey) {
    const again = await reuseJob(input.botId, { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey } }, now);
    if (again) return { done: again };
  }
  // "Try again" of an ended job (piece 8): carried on in its conversation only when Orbit's record says so, once per job. The job that already carries it on is the answer, whatever it came to,
  // as the job a run made is (one that is not confirmed yet is answered `earlier` by the person's lock below, never a second job)
  const carry = input.continuesJobId ? await carryOnFrom(input.botId, input.personId, input.continuesJobId) : null;
  if (carry && 'existing' in carry) {
    const unconfirmed = input.acks && input.startKey ? await prisma.computerJob.count({ where: { id: carry.existing.id, startAckedAt: null } }) : 0;
    if (unconfirmed === 0) {
      const again = await reuseJob(input.botId, { id: carry.existing.id }, now);
      if (again) return { done: again };
    }
  }
  // Finding 6: a "try again" that cannot carry on makes nothing at all. It never falls back to a fresh paid job: the person chooses "Start a new job" separately (an ordinary start, under its own key)
  if (carry && 'fresh' in carry) return { done: { ok: false, reason: 'cannot_continue', why: carry.fresh, ...(carry.job ? { job: carry.job } : {}) } };
  const link = carry && 'link' in carry ? carry.link : null;
  // The way: a connected app that would do this for less is used instead, before anything is made, woken or reserved
  const routed = await routeJob({ botId: input.botId, personId: input.personId, plan: input.plan, awakeMicrosPerMinute: providerFor(row)?.microsPerMinute() ?? null, hasMachine: !!row.providerRef }, now);
  if (!routed.ok) return { done: { ok: false, reason: 'cheaper_route', app: routed.app } };
  // The team paused computers: no new job starts (one already going finishes, and a job already in line waits with its work saved).
  // A retry of a run that already has its job was answered above, so a pause never hides the job a run already made
  if (await computersArePaused()) return { done: { ok: false, reason: 'paused' } };
  let created;
  try {
    const data = { botId: input.botId, personId: input.personId, title: input.title.trim().slice(0, 200) || 'A job', brief: input.brief?.trim().slice(0, 4000) || null, writes: input.writes !== false, runId: input.runId ?? null, startKey: input.startKey ?? null, route: routed.route, expectedMicros: BigInt(routed.expectedMicros), originKind: input.origin?.kind ?? null, originRef: input.origin?.ref.slice(0, 255) ?? null, ...(link ? { continuesJobId: link.continuesJobId, agentSessionId: link.agentSessionId } : {}) };
    if (input.acks && input.startKey) {
      // A start that acks: decided under the person's lock in the SAME transaction that makes the job, so two starts at once cannot both pass. An earlier start of this person on this Brick that the game has not confirmed
      // (the oldest is named) makes this one make nothing; a job this very key made (a start of it at the same moment) is the answer instead
      const decided = await prisma.$transaction(
        async (tx) => {
          await lockPerson(tx, input.personId);
          const same = await tx.computerJob.findUnique({ where: { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey as string } }, select: { id: true } });
          if (same) return { same: true as const };
          // This start's own attempt decides first: one that was superseded by a job another start made answers that job (`earlier`), one that stopped beating (or was let go) answers `expired`, and neither makes anything
          const mine = await tx.computerStartAttempt.findUnique({ where: { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey as string } } });
          const asked = new Date();
          const alive = (beat: Date) => beat.getTime() > asked.getTime() - attemptLifeMs();
          const ownKey = { botId: input.botId, personId: input.personId, startKey: input.startKey as string };
          // Answered meanwhile (another request of this same key was answered with an earlier start while this one waited): the same answer, decided from the row after the lock
          if (mine && mine.state === 'answered') return { reanswer: true as const };
          // The start that MADE a job whose job was taken away since (Brick purge, the job's removal): its attempt stays as `made` with no job. A delayed copy of it makes nothing: it answers `expired`, never a second paid
          // job for a request that was already answered (Opus's ruling N15-a)
          if (mine && mine.state === 'made' && !mine.jobId) return { expired: true as const };
          // Finding 1 (GPT's second order): an OLDER open attempt loses to a job another keyed start made after it began. That start could not see this one (it was not committed yet when it decided),
          // so this one is superseded by that job now and answers it: never a second job for one request
          if (mine && mine.state === 'open') {
            const after = await tx.computerJob.findFirst({
              where: { botId: input.botId, personId: input.personId, runId: null, startKey: { not: null }, NOT: { startKey: input.startKey as string }, createdAt: { gte: mine.createdAt } },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true },
            });
            if (after) {
              await tx.computerStartAttempt.updateMany({ where: { id: mine.id, state: 'open' }, data: { state: 'superseded', jobId: after.id } });
              return { reanswer: true as const };
            }
          }
          if (mine && mine.state === 'superseded' && mine.jobId) {
            const by = await tx.computerJob.findUnique({ where: { id: mine.jobId }, select: { id: true, status: true, startKey: true } });
            if (by) return { earlier: { id: by.id, status: by.status, state: startStateOf(by.status), attempt: by.startKey } };
          }
          if (mine && (mine.state === 'expired' || mine.state === 'superseded' || (mine.state === 'open' && !alive(mine.beatAt)))) {
            await tx.computerStartAttempt.updateMany({ where: { id: mine.id, state: 'open' }, data: { state: 'expired' } });
            return { expired: true as const };
          }
          // An OLDER start of this person on this Brick that is still going on (open and beating, no job yet): this one waits for it, naming its key (the game adopts it and looks it up)
          if (mine) {
            const older = await tx.computerStartAttempt.findFirst({
              where: { botId: input.botId, personId: input.personId, state: 'open', jobId: null, beatAt: { gt: new Date(asked.getTime() - attemptLifeMs()) }, id: { not: mine.id }, OR: [{ createdAt: { lt: mine.createdAt } }, { createdAt: mine.createdAt, id: { lt: mine.id } }] },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, startKey: true },
            });
            if (older) {
              // Finding 1: kept before it is answered, in this same transaction
              if (!(await answerAttemptIn(tx, ownKey, { aliasAttemptId: older.id })) && (await storedAnswerIn(tx, ownKey))) return { reanswer: true as const };
              return { earlier: { id: null, status: null, state: 'starting' as const, attempt: older.startKey } };
            }
          }
          const earlier = await tx.computerJob.findFirst({ where: { botId: input.botId, personId: input.personId, startAckedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, startKey: true } });
          if (earlier) {
            // Finding 1: kept before it is answered; it acknowledges nothing (the earlier job stays unconfirmed until its own key is acknowledged)
            if (!(await answerAttemptIn(tx, ownKey, { jobId: earlier.id })) && (await storedAnswerIn(tx, ownKey))) return { reanswer: true as const };
            return { earlier: { id: earlier.id, status: earlier.status, state: startStateOf(earlier.status), attempt: earlier.startKey } };
          }
          const made = await tx.computerJob.create({ data: { ...data, startAckedAt: null } });
          // The attempt is made, and every older attempt of this person on this Brick that stopped beating is superseded by this job (a delayed request of it will be answered with it, and can make none of its own)
          if (mine) await tx.computerStartAttempt.updateMany({ where: { id: mine.id }, data: { state: 'made', jobId: made.id } });
          await tx.computerStartAttempt.updateMany({ where: { botId: input.botId, personId: input.personId, state: 'open', jobId: null, ...(mine ? { id: { not: mine.id } } : {}), beatAt: { lte: new Date(asked.getTime() - attemptLifeMs()) } }, data: { state: 'superseded', jobId: made.id } });
          return { made };
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
      if ('expired' in decided) return { done: { ok: false, reason: 'expired' } };
      if ('reanswer' in decided) return { done: (await startAnsweredBefore(input.botId, input.personId, input.startKey, now)) ?? { ok: false, reason: 'expired' } };
      if ('earlier' in decided && decided.earlier) return { done: { ok: false, reason: 'earlier', job: decided.earlier } };
      if ('same' in decided) {
        const winner = await reuseJob(input.botId, { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey } }, now);
        if (winner) return { done: winner };
        // The same key made a job and took it away again before this one could look (controls not set up, or a rule the person said): the same answer as the first ask
        const words = await ruleWordsOf(input.botId, input.personId, now);
        return { done: words !== null ? { ok: false, reason: 'rule', words } : { ok: false, reason: 'not_set' } };
      } else created = decided.made;
    } else {
      // The same rule without an ack: a keyed start whose own attempt MADE a job that was taken away since makes nothing (N15-a)
      if (input.startKey) {
        const own = await prisma.computerStartAttempt.findUnique({ where: { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey } }, select: { state: true, jobId: true } });
        if (own && own.state === 'made' && !own.jobId) return { done: { ok: false, reason: 'expired' } };
      }
      // The job and the link from its attempt are ONE commit (as the acknowledgement path does): a link that could not be written leaves no job behind that the key's answers cannot find
      const key = input.startKey;
      created = await prisma.$transaction(async (tx) => {
        const made = await tx.computerJob.create({ data: { ...data, startAckedAt: now } });
        if (key) await tx.computerStartAttempt.updateMany({ where: { botId: input.botId, personId: input.personId, startKey: key, state: { in: ['open', 'expired'] }, jobId: null }, data: { state: 'made', jobId: made.id } });
        return made;
      });
    }
  } catch (error) {
    // Two asks for the same run, or with the same key, or carrying on the same ended job, at once: the first made the job, the second finds it
    if ((input.runId || input.startKey || link) && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner =
        (input.runId ? await reuseJob(input.botId, { botId_runId: { botId: input.botId, runId: input.runId } }, now) : null) ??
        (input.startKey ? await reuseJob(input.botId, { botId_personId_startKey: { botId: input.botId, personId: input.personId, startKey: input.startKey } }, now) : null) ??
        (link ? await reuseJob(input.botId, { continuesJobId: link.continuesJobId }, now) : null);
      if (winner) return { done: winner };
      // The first ask made the job and took it away again before this one could look: that is "controls not set up" or a rule the person
      // said (both leave no job behind). Whichever it was, this ask gets the same answer, not an error
      const words = await ruleWordsOf(input.botId, input.personId, now);
      return { done: words !== null ? { ok: false, reason: 'rule', words } : { ok: false, reason: 'not_set' } };
    }
    throw error;
  }
  if (!created) throw new Error('A start made no job and found none');
  return { created: { id: created.id } };
}

/** What a start does once its job is saved: the first try, and the answer. */
async function tryNewJob(input: StartInput, now: Date, created: { id: string }): Promise<Started> {
  const outcome = await tryStart(created.id, now);
  if (typeof outcome === 'object') {
    // Refused by a rule the person said in chat: no job was ever going to run, so none is left behind, and the answer carries the rule's words
    await prisma.computerJob.deleteMany({ where: { id: created.id, status: 'stopped', endedBy: 'rule', startedAt: null } });
    return { ok: false, reason: 'rule', words: outcome.rule };
  }
  if (outcome === 'not_set') {
    // Controls that are not set up: no job was ever going to run, so none is left behind (a second ask for the same run may have taken it away already)
    await prisma.computerJob.deleteMany({ where: { id: created.id } });
    return { ok: false, reason: 'not_set' };
  }
  const job = await prisma.computerJob.findUnique({ where: { id: created.id }, include: JOB_INCLUDE });
  // A second ask for the same run found this job while it waited for its first try, saw the controls not set up (or a rule the person said
  // stop it) and took it away: this ask gets the same answer
  if (!job) {
    const words = await ruleWordsOf(input.botId, input.personId, now, created.id);
    return words !== null ? { ok: false, reason: 'rule', words } : { ok: false, reason: 'not_set' };
  }
  // The same, seen after that ask stopped the job and before it took it away
  if (job.status === 'stopped' && job.endedBy === 'rule' && job.startedAt === null) {
    await prisma.computerJob.deleteMany({ where: { id: job.id, status: 'stopped', endedBy: 'rule', startedAt: null } });
    return { ok: false, reason: 'rule', words: (await ruleWordsOf(input.botId, input.personId, now, job.id)) ?? 'A rule you said stopped this job' };
  }
  if (job.status === 'failed') return { ok: false, reason: 'broken_start' };
  const after = await prisma.brickComputer.findUnique({ where: { botId: input.botId } });
  return { ok: true, job: jobView(job), restoredFrom: job.status === 'running' ? (after?.restoredFrom ?? null) : null, ...(job.continuesJobId ? { continued: true as const } : {}) };
}

/**
 * The rule's own words when the rules the person said stop a first stretch of room for this Brick's computer now, or null when none does:
 * asked the way the start asks it (a whole stretch), so it gives the same words the refused ask gave.
 */
async function ruleWordsOf(botId: string, personId: string, now: Date, taskKey: string | null = null): Promise<string | null> {
  const provider = providerFor(await prisma.brickComputer.findUnique({ where: { botId } }));
  if (!provider) return null;
  const settings = await getMeterSettings();
  const ruled = await checkSpend({ payerPersonId: personId, botId, taskKey, chargeClass: 'computer', amountMicros: roomFor(settings.renewMinutes, provider.microsPerMinute()) }, now);
  return ruled.ok ? null : ruled.words;
}

/**
 * The job a run (or a start key) already made, or null when it has none. Never a job that is still waiting for its first try or is being taken away:
 * a job still queued is tried again here (a try is safe to repeat, and only one claims the machine), and one the first ask removed
 * ("controls not set up") answers the same way for this ask. A job that is running, over or in line is returned as it stands.
 */
async function reuseJob(botId: string, where: Prisma.ComputerJobWhereUniqueInput, now: Date): Promise<Started | null> {
  let found = await prisma.computerJob.findUnique({ where, include: JOB_INCLUDE });
  if (!found) return null;
  const owner = found.personId;
  const jobId = found.id;
  if (found.status === 'queued') {
    const tried = await tryStart(found.id, now);
    if (typeof tried === 'object') {
      // A rule the person said stops it on this try: nothing ran, so none is left behind, the same answer as the first ask
      await prisma.computerJob.deleteMany({ where: { id: found.id, status: 'stopped', endedBy: 'rule', startedAt: null } });
      return { ok: false, reason: 'rule', words: tried.rule };
    }
    if (tried === 'not_set') {
      await prisma.computerJob.deleteMany({ where: { id: found.id, status: 'queued' } });
      return { ok: false, reason: 'not_set' };
    }
    found = await prisma.computerJob.findUnique({ where, include: JOB_INCLUDE });
    // The first ask took it away while this one looked again: the controls are not set up, or a rule the person said stopped it
    if (!found) {
      const words = await ruleWordsOf(botId, owner, now, jobId);
      return words !== null ? { ok: false, reason: 'rule', words } : { ok: false, reason: 'not_set' };
    }
  }
  // A job a rule the person said has just stopped at the start (it never ran), seen before the ask that stopped it took it away: the same
  // answer as that ask. A job that ran and was stopped later by a rule is over like any other and is returned as it stands, never removed
  if (found.status === 'stopped' && found.endedBy === 'rule' && found.startedAt === null) {
    await prisma.computerJob.deleteMany({ where: { id: found.id, status: 'stopped', endedBy: 'rule', startedAt: null } });
    return { ok: false, reason: 'rule', words: (await ruleWordsOf(botId, found.personId, now, found.id)) ?? 'A rule you said stopped this job' };
  }
  if (found.status === 'failed') return { ok: false, reason: 'broken_start' };
  return { ok: true, job: jobView(found), restoredFrom: null, ...(found.continuesJobId ? { continued: true as const } : {}) };
}

/** Whether the run is one of this person's goals or tasks on this Brick. */
async function runIsTheirs(botId: string, personId: string, runId: string): Promise<boolean> {
  const run = await prisma.brickItemRun.findUnique({ where: { id: runId }, select: { item: { select: { botId: true, ownerId: true } } } });
  return !!run && run.item.botId === botId && run.item.ownerId === personId;
}

/**
 * The claim that puts a job on the machine, decided in ONE transaction under the Brick's line lock (the one "do this first" takes) and the machine's own row (a command on the browser takes it to write its claim): nothing is still being
 * done to the browser, a job that must have the browser alone has no other job beside it, and no job beside it is still waiting for its browser (the restore replaces the browser: nobody starts under it, and it starts under nobody).
 * `count` is 0 when the job was claimed by another try meanwhile, as before.
 */
async function claimMachineFor(job: { id: string; botId: string }, key: string, now: Date, options: { restoring: boolean; exclusive: boolean }): Promise<{ ok: true; count: number } | { ok: false }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`computer:line:${job.botId}`}, 0))`;
      const rows = await tx.$queryRaw<Array<{ claimed: Date | null }>>`SELECT "clean_claimed_at" AS claimed FROM "brick_computers" WHERE "bot_id" = ${job.botId} FOR UPDATE`;
      const claimed = rows[0]?.claimed ?? null;
      if (claimed && now.getTime() - claimed.getTime() < CLEAN_CLAIM_STALE_MS && Date.now() - claimed.getTime() < CLEAN_CLAIM_STALE_MS) return { ok: false as const };
      const beside = await tx.computerJob.findMany({ where: { botId: job.botId, id: { not: job.id }, status: { in: ['running', 'waiting'] } }, select: { prepState: true } });
      if (beside.some((other) => other.prepState !== null) || (options.exclusive && beside.length > 0)) return { ok: false as const };
      const done = await tx.computerJob.updateMany({
        where: { id: job.id, status: 'queued', ...NOT_PAUSED },
        // A job that carries on is not ready to be worked on until its own browser is back (or a clean one is proved clean): `prep_state` keeps it out of the runnable list, refuses a claim and refuses every call until then (GPT round 6, finding 7)
        data: { status: 'running', queuedFor: null, reservationKey: key, startedAt: now, stretchStarted: now, ...(options.restoring ? { prepState: 'restoring' as const } : {}) },
      });
      return { ok: true as const, count: done.count };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

/**
 * A pause left its mark and the machine is not awake: the machine is woken for it (no job holds it), the paused job's browser is put away first, or emptied with proof, and only then is the mark let go. False when the machine cannot be
 * woken or the browser cannot be settled (the mark stays, the machine is put to rest again when nothing holds it, and the job waits in line: the sweep settles it once the machine can be reached).
 */
async function settleAsleepPark(botId: string, provider: Provider, markJobId: string, now: Date): Promise<boolean> {
  try {
    await bringUp(botId, provider, now);
    const settled = await settlePark(botId, markJobId, await parkProfile(botId, markJobId, now), now);
    if (settled !== 'waiting') return true;
  } catch (error) {
    console.error('[Computer] Could not wake a machine to put a paused job’s browser away:', error instanceof Error ? error.message : 'unknown');
  }
  await restIfUnheld(botId, now).catch(() => false);
  return false;
}

type Tried = 'running' | 'queued' | 'failed' | 'not_set' | 'gone' | { rule: string };

/** One try to put a queued job on the machine. Safe to ask again: a job that is no longer queued is left as it is. */
async function tryStart(jobId: string, now: Date, options: { /** The person's own Resume: they are answered at once, so a pause for their month or a limit is not told to them again. */ quiet?: boolean } = {}): Promise<Tried> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'queued') return job ? (job.status === 'running' ? 'running' : 'gone') : 'gone';
  // A paused job is skipped until it is resumed: a repeated ask for it, the sweep and the line never start it
  if (job.queuedFor === 'paused') return 'queued';
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row || !row.enabled || !provider) {
    await endJob(job.id, 'stopped', 'off', now);
    return 'gone';
  }
  // A wind-down is on: a job in line never starts, it ends (the wind-down would end it next anyway)
  if (await isWindingDown()) {
    await endJob(job.id, 'stopped', 'off', now, false);
    return 'gone';
  }
  // Never over a pause that landed since this try looked (it would undo the pause)
  // ...and marks the try as DECIDED (`lastTriedAt`): a Resume's copy reads a job still queued with no try on record as one whose start has not reached its decision yet (CodeRabbit on #1025)
  const queue = (queuedFor: QueuedFor) => prisma.computerJob.updateMany({ where: { id: job.id, status: 'queued', ...NOT_PAUSED }, data: { queuedFor, lastTriedAt: now } });

  // The team paused computers: a job in line stays in line with its work saved, and starts by itself when they are back
  if (await computersArePaused()) {
    // Waiting in line, nothing to ask for: not the "allowance" or "turn" reason an earlier try may have left
    await queue('busy');
    return 'queued';
  }

  // A turn of a job that ended may still run on this machine: nothing starts beside it until the machine is proved asleep (tried again here and by every sweep)
  if (!(await settleTurnHold(job.botId))) {
    await queue('turn');
    return 'queued';
  }

  // The person has the machine: nothing starts under Brick's hands until they hand it back. Nothing is reserved while waiting in line.
  if ((await prisma.computerJob.count({ where: { botId: job.botId, status: 'waiting', control: 'person' } })) > 0) {
    await queue('turn');
    return 'queued';
  }
  // A take over or a hand back is on its way (or the person still holds the screen with their jobs over, which this puts right): the agent is
  // not admitted until control is Brick's again, so a job never begins in the middle of a change of hands.
  if (!(await releaseIfUnheld(job.botId))) {
    await queue('turn');
    return 'queued';
  }

  // The computer is being packed away into cold storage: the job waits in line, and the sweep tries it again once it is cold (it is then brought back) or put back
  if (row.machine === 'packing') {
    await queue('busy');
    return 'queued';
  }

  // Another job is writing: wait for it.
  if (job.writes) {
    const writing = await prisma.computerJob.count({ where: { botId: job.botId, writes: true, status: { in: ['running', 'waiting'] } } });
    if (writing > 0) {
      await queue('turn');
      return 'queued';
    }
  }

  // A pause whose park never ran leaves the paused job's own browser live on the machine: nothing else starts there until it is put away or emptied (the sweep does it), so no job ever
  // inherits another's sign-ins (GPT round 6, finding 7)
  // Another job's pause still has its browser to put away. On an AWAKE machine the pause's own park, or the sweep, settles it and the line moves on (this job waits). On a machine that is NOT awake (waking, resting, restarted)
  // nobody can settle it until it is woken, and a job waiting for that would wait for ever: this job wakes it, the browser is put away (or emptied, proved) FIRST, and only then does this job go on to take the machine.
  // Never by letting the pointer go because the machine sleeps: a sleeping machine still holds the paused job's sign-ins on its disk (Opus, 23 Nov)
  const parking = await prisma.brickComputer.findUnique({ where: { botId: job.botId }, select: { parkPendingJobId: true } });
  if (parking?.parkPendingJobId && parking.parkPendingJobId !== job.id) {
    if (row.machine === 'working' || !(await settleAsleepPark(job.botId, provider, parking.parkPendingJobId, now))) {
      await queue('busy');
      return 'queued';
    }
  }

  // A job that carries on and still has a browser of its own to get back does not start BESIDE another job: it would have to run in that job's browser, and its own sign-ins would be thrown
  // away to let it. It waits for the machine alone (nothing reserved, its park untouched) and the line starts it when the other job is done. A job that kept nothing runs beside another as any
  // new job does (GPT round 6, finding 7, Opus's ruling 23 Nov)
  const beforeClaim = { exclusive: false };
  if (job.pauses > 0) {
    beforeClaim.exclusive = await parkWorthWaitingFor(job.botId, job.id, now);
    const beside = await prisma.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: { in: ['running', 'waiting'] } } });
    if (beside > 0 && beforeClaim.exclusive) {
      await queue('busy');
      return 'queued';
    }
  }

  const settings = await getMeterSettings();
  const key = roomKey(job.id, now);
  const room = await reserveRoom({ key, personId: job.personId, amountMicros: roomFor(settings.renewMinutes, provider.microsPerMinute()), botId: job.botId, jobId: job.id }, now);
  if (!room.ok) {
    if (room.reason === 'not_set') return 'not_set';
    // A job that already ran and was paused (its time so far is charged) does not end because its month or a limit it was resumed under refuses its next start: it stays paused, saying why, and is carried on later
    if ((room.reason === 'rule' || room.reason === 'allowance') && job.pauses > 0) {
      const why = room.reason;
      // Brick tells the person once, in the same commit (piece 3): not for their own Resume, which is answered at once
      await prisma.$transaction(async (tx) => {
        const moved = await tx.computerJob.updateMany({ where: { id: job.id, status: 'queued', ...NOT_PAUSED }, data: { queuedFor: 'paused', pausedAt: now, pausedWhy: why, leaseVersion: { increment: 1 } } });
        if (moved.count === 1 && !options.quiet) await tellIn(tx, job.id, 'paused', why, now);
      });
      return 'queued';
    }
    // A rule the person said is not a wait in line: waiting would not change it, and a job that keeps being retried would hold up the Brick. It ends,
    // saying why, and the jobs behind it meet the same rule when their turn comes
    if (room.reason === 'rule') {
      await endJob(job.id, 'stopped', 'rule', now, false, 'queued');
      // Another try may have claimed the job while this one was refused: that one runs and is left alone, only a job this try ended is a refusal
      const after = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true, endedBy: true } });
      if (after?.status === 'stopped' && after.endedBy === 'rule') {
        // Its words are kept for the report back, as the renew path does: without them the report says only that it stopped
        const kept = cleanEndNote(room.words);
        if (kept) await prisma.computerJob.updateMany({ where: { id: job.id, status: 'stopped', endedBy: 'rule', endNote: null }, data: { endNote: kept } });
        return { rule: room.words };
      }
      return after && !isOver(after.status) ? 'running' : 'gone';
    }
    const reason = queueReasonOf(room);
    if (reason) {
      await queue(reason);
      return 'queued';
    }
    // Room that was held, lapsed and closed: this is another try, not the same room
    await queue('busy');
    return 'queued';
  }

  // A machine that is not made yet takes its disk's room in the pool first (a disk is bought whole the moment it is made): a pool that cannot
  // carry it makes no machine, and this job waits in line with its work saved, as for any other room the pool lacks
  const diskBytes = !row.providerRef ? provider.diskBytes?.() ?? null : null;
  if (diskBytes !== null && diskBytes > 0) {
    const disk = await reserveDiskRoom({ botId: job.botId, jobId: job.id, bytes: diskBytes, attempt: now.getTime() }, now);
    if (!disk.ok) {
      await releaseRoom({ key }, now);
      if (disk.reason === 'not_set') return 'not_set';
      await queue('pool');
      return 'queued';
    }
  }
  // Set by bringUp when the machine was made but its disk could not be written to the books: the room stays held, and the sweep gives it back after writing
  const kept = { ok: true };
  const dropDiskRoom = async () => {
    if (!kept.ok) return;
    if (diskBytes !== null && diskBytes > 0) await releaseRoom({ key: diskRoomKey(job.botId, job.id, now.getTime()) }, now);
  };

  // Take the writer's place. The database lets only one writing job hold it; a second one arriving at the same moment queues.
  let carriedOnSeq: number | null = null;
  try {
    // A cleanup of the browser is waited out first (as before); the claim below then DECIDES, in one transaction under the Brick's line lock and the machine's row, whether anything is still on the browser (CodeRabbit on #1025)
    if (row.machine === 'working') await untilCleaned(job.botId);
    const taking = await claimMachineFor(job, key, now, { restoring: job.pauses > 0, exclusive: job.pauses > 0 && beforeClaim.exclusive });
    if (!taking.ok) {
      // Something is still being done to the browser (a command, another job's restore, a job that waits for its browser) or the job would have to share a browser it must have alone: this one goes back in line with nothing held
      await releaseRoom({ key }, now);
      await dropDiskRoom();
      await queue('busy');
      return 'queued';
    }
    const claimed = { count: taking.count };
    // A job its month or a limit paused that was put back in line by itself is told `carried_on` right as it takes the machine, once (finding 5, GPT round 6): never while it still waits in line. The mark is
    // cleared and the telling written in one conditional write on the job that is now running (UPDATE ... RETURNING), so it is said once however many tries race
    if (claimed.count === 1 && job.carryOnPending) {
      // Never throws: the job has its place and its room whatever becomes of the message
      carriedOnSeq = await prisma
        .$transaction(async (tx) => {
          const pending = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "computer_jobs" SET "carry_on_pending" = false WHERE "id" = ${job.id} AND "carry_on_pending" = true AND "status" IN ('running', 'waiting') RETURNING "id"`;
          return pending.length === 1 ? tellIn(tx, job.id, 'carried_on', null, now) : null;
        })
        .catch((error) => {
          console.error('[Computer] Could not tell a job carried on:', error instanceof Error ? error.message : 'unknown');
          return null;
        });
    }
    if (claimed.count === 0) {
      // Two tries in the same millisecond share one room: it is given back only when the job that won did not take it
      const holder = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { reservationKey: true } });
      if (holder?.reservationKey !== key) {
        await releaseRoom({ key }, now);
        // The disk's room is this try's own (it carries the try's moment), and when the winner shares the moment it shares the room too: given back only with it
        await dropDiskRoom();
      }
      return 'gone';
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await releaseRoom({ key }, now);
      await dropDiskRoom();
      await queue('turn');
      return 'queued';
    }
    await dropDiskRoom();
    throw error;
  }

  /**
   * Whether the job is still on THIS try's room (GPT round 6, finding 3b). Every write this try makes after a wait is conditional on it, in the write itself where it can be, and read through
   * this where a provider call stands between: a pause and a resume in between give the job another room, and the outcome of this try must then land on nothing, never on the job that runs now.
   */
  const stillThisTry = async (): Promise<boolean> => (await prisma.computerJob.findUnique({ where: { id: job.id }, select: { reservationKey: true } }))?.reservationKey === key;

  // The person may have taken over at the same moment: a job that began now joins them rather than run under Brick's hands. Their
  // take over looks again for running jobs after it ends the ones it saw, so one of the two always sees the other.
  if ((await prisma.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: 'waiting', control: 'person' } })) > 0) {
    await prisma.computerJob.updateMany({ where: { id: job.id, status: 'running', reservationKey: key }, data: { status: 'waiting', waitingFor: null, control: 'person', stretchStarted: now, readyWhat: null, readyWhere: null, leaseVersion: { increment: 1 } } });
    // The person may have handed back in between: with nobody else holding the machine for them there is nothing to join, so it runs as it was
    if ((await prisma.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: 'waiting', control: 'person' } })) === 0) {
      await prisma.computerJob.updateMany({ where: { id: job.id, status: 'waiting', control: 'person', reservationKey: key }, data: { status: 'running', control: 'brick', waitingFor: null, leaseVersion: { increment: 1 } } });
    }
  }

  // A pack-away may have taken the computer in the same moment: this job goes back in line with nothing held, and the pack-away (which checks for a
  // running job before it removes anything) goes on; the job is brought a computer from cold storage when its turn comes
  const taken = await prisma.brickComputer.findUnique({ where: { botId: job.botId }, select: { machine: true } });
  if (taken?.machine === 'packing') {
    const back = await prisma.computerJob.updateMany({ where: { id: job.id, status: 'running', reservationKey: key }, data: { status: 'queued', queuedFor: 'busy', lastTriedAt: now, reservationKey: null, startedAt: null, stretchStarted: null, prepState: null, ...(carriedOnSeq !== null ? { carryOnPending: true } : {}) } });
    if (back.count === 1) {
      // It did not carry on after all: the `carried_on` this try wrote is not said (it is told again when it really runs)
      if (carriedOnSeq !== null) await prisma.computerJobTelling.updateMany({ where: { jobId: job.id, seq: carriedOnSeq, toldAt: null }, data: { staleAt: now } });
      await releaseRoom({ key }, now);
      await dropDiskRoom();
      return 'queued';
    }
  }

  // The Brick may have been deleted after the claim: deletion marks it first, then stops the jobs it can see, so this sees the mark
  const brick = await prisma.bot.findUnique({ where: { id: job.botId }, select: { deletedAt: true } });
  if (!brick || brick.deletedAt !== null) {
    await endJob(job.id, 'stopped', 'deleted', now, true, undefined, true, null, false, { reservation: key });
    await dropDiskRoom();
    return 'gone';
  }

  // The machine: made once, here, or woken. A start that breaks leaves the job over, its room given back and the machine "broken".
  try {
    await bringUp(job.botId, provider, now, kept);
    // The disk is in the books as kept storage now: the room held for it is given back
    await dropDiskRoom();
  } catch (error) {
    await dropDiskRoom();
    console.error('[Computer] A machine did not start:', error instanceof Error ? error.message : 'unknown');
    // Another job holds this machine (it is waking it, or working on it): its state is theirs, and this failure does not rewrite it.
    // Only when this job was the only one asking is the machine marked, so a failed second start never breaks a machine that works
    // and never resets one that is still being made.
    // A pause and a resume (or another try) gave the job another room while the machine was being made or woken: this try's failure is not the job's. The job that runs now is not ended, and the
    // machine's state is not rewritten under it: the replacement is on that machine (GPT round 6, finding 3b)
    // The job's row is locked while the machine is written, so a pause and a resume cannot give the job another room between the look at its room and the write (CodeRabbit on #1025, 8)
    const mine = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ reservation_key: string | null }>>`SELECT "reservation_key" FROM "computer_jobs" WHERE "id" = ${job.id} FOR UPDATE`;
      if (rows[0]?.reservation_key !== key) return false;
      const others = await tx.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: { in: ['running', 'waiting'] } } });
      if (others === 0) {
        // A machine that was never made is not "broken": it is still just not made, and the next job tries again
        // A computer that is cold, being packed away or being brought back is in its own hands: a failed start does not rewrite it
        await tx.brickComputer.updateMany({ where: { botId: job.botId, NOT: { providerRef: null }, machine: { notIn: ['stopping', 'packing', 'cold'] }, OR: [{ packStage: null }, { packStage: { not: 'returning' } }] }, data: { machine: 'broken' } });
        await tx.brickComputer.updateMany({ where: { botId: job.botId, providerRef: null, machine: { notIn: ['cold', 'packing', 'restoring'] } }, data: { machine: 'none' } });
      }
      return true;
    });
    if (!mine) return 'gone';
    // The line does not move on from a start that broke: the jobs behind it stay queued for the next sweep, so one broken start is one
    // failed job and never every job in line failing one after another
    await endJob(job.id, 'failed', 'error', now, false, undefined, true, null, false, { reservation: key });
    return 'failed';
  }
  // Turned off, deleted or stopped while the machine was being made or woken: the job is over and nobody holds the machine, so it
  // is put to rest at once rather than left awake with no one paying for it
  const after = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true } });
  if (!after || (after.status !== 'running' && after.status !== 'waiting')) {
    await restIfUnheld(job.botId, now);
    return 'gone';
  }
  // A job that was paused gets its own browser back (and never the one of a job that ran in between) before its runner takes it up
  // Each of these is this try's own: a job that was paused and resumed again while the machine came up is on another room, and this try marks nothing for it (finding 3b)
  if (job.pauses > 0) await prisma.computerJobPause.updateMany({ where: { jobId: job.id, n: job.pauses, resumedAt: null, job: { reservationKey: key } }, data: { resumedAt: now } }).catch(() => undefined);
  if (job.pauses > 0 && (await stillThisTry())) {
    // What the browser came back as decides whether the job may be worked on: its own back, or a clean one proved clean, is ready; anything else leaves it `recover` for the sweep (finding 7)
    // The restore and the settlement are this try's own: the command is run only while the job is still on this room and `restoring`, and the settlement writes only while that is true (a job that paused again meanwhile is no longer this try's)
    const back = await restoreProfile(job.botId, job.id, now, { reservation: key, from: 'restoring' }).catch((error) => {
      console.error('[Computer] Could not bring back a resumed job’s browser:', error instanceof Error ? error.message : 'unknown');
      return { state: 'failed' as const, reason: 'error', cookies: 0, pages: 0 };
    });
    // Its own browser is back (or a clean one is proved clean): the machine waits for nobody's park any more. Only when this try's own settlement was written (a settlement that matched no row is not "ready"), and only for the pause and
    // the room this try carried on from: a later pause of the same job leaves its own marker, and that one is never cleared from here (CodeRabbit A12)
    if ((await settleResumedBrowser(job.id, job.botId, back, now, key, 'restoring')) === 'ready') await clearParkPending(job.botId, job.id, { pauses: job.pauses, reservation: key });
  }
  // What is on the machine before this job works on it: only so the message can name files the job saved outside its own output folder (those are never handed over)
  if (job.writes) await takeBaseline(job.id, job.botId, provider, key);
  return 'running';
}

/**
 * The list of files on the machine as the job begins, kept on the job. Best effort: a list that could not be taken is left empty, and then nothing is
 * attributed to the job (nothing can be proved), never a wrong file handed over. It never holds up the start for long (one quick command).
 */
async function takeBaseline(jobId: string, botId: string, provider: Provider, /** The start's own room key: the list is kept only while that try is still the job's (finding 3b). */ reservation?: string): Promise<void> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { providerRef: true } });
    if (!row?.providerRef) return;
    const listed = await provider.exec(row.providerRef, 'universe-files', { timeoutMs: 20_000 });
    if (listed.exitCode !== 0 || listed.truncated) return;
    await prisma.computerJob.updateMany({ where: { id: jobId, ...(reservation ? { reservationKey: reservation } : {}) }, data: { startFiles: parseFilesList(listed.stdout, new Date()) as unknown as Prisma.InputJsonValue } });
  } catch (error) {
    console.error('[Computer] Could not list the files a job began with:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * Puts the machine of a Brick to rest when no job holds it. The rest is claimed first (working -> resting) so only one caller does it,
 * and a job that starts meanwhile finds a resting machine and wakes it. Returns whether it rested one.
 */
async function restIfUnheld(botId: string, now: Date, exceptJobId?: string): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row || !row.providerRef || !provider) return false;
  // A job that is done but has not handed its files over yet holds the machine too (it may be waiting for another hand-over's claim): resting it now would lose those files
  const holders = async () => (await prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } })) + (await pendingHandOvers(botId, now, exceptJobId));
  if ((await holders()) > 0) return false;
  // Files of a job that just finished are being read off this machine: it is not put to rest under them (the job that reads them rests it when they are done)
  if (row.filesClaimedAt && Date.now() - row.filesClaimedAt.getTime() < FILES_CLAIM_MS) return false;
  const claim = await prisma.brickComputer.updateMany({ where: { botId, machine: 'working' }, data: { machine: 'resting', restClaimedAt: now } });
  if (claim.count !== 1) return false;
  if ((await holders()) > 0) {
    // A job took its place between the count and the claim: the machine is still working
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting', restClaimedAt: now }, data: { machine: 'working', restClaimedAt: null } });
    return false;
  }
  // Its work is saved before it rests, and a save that failed is not claimed
  await saveCopy(botId, row.providerRef, provider);
  try {
    await provider.rest(row.providerRef);
  } catch (error) {
    console.error('[Computer] Could not rest a machine:', error instanceof Error ? error.message : 'unknown');
    // Still awake: it is "working" again, so the sweep finds it and tries once more
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting', restClaimedAt: now }, data: { machine: 'working', restClaimedAt: null } });
    return false;
  }
  // The rest is done: no longer claimed, so the sweep never mistakes it for one that was left half way
  await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting', restClaimedAt: now }, data: { restClaimedAt: null } });
  if ((await holders()) > 0) {
    // A job started while the machine was resting and its wake may have come before the rest: wake it again, so it works
    await provider.wake(row.providerRef).catch((error) => console.error('[Computer] Could not wake a machine:', error instanceof Error ? error.message : 'unknown'));
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting', restClaimedAt: now }, data: { machine: 'working', lastWorkedAt: now, restClaimedAt: null } });
  }
  return true;
}

/**
 * A machine that was just made (new, or brought back from cold storage) costs from now on: its disk goes into the books as kept storage, tried a few
 * times. When the books will not take it the caller is told (`kept.ok` false) and keeps the room it held for the disk until the sweep has written it.
 */
async function writeKeptDisk(botId: string, provider: Provider, kept?: { ok: boolean }): Promise<void> {
  let written = false;
  for (let tries = 0; tries < 3 && !written; tries++) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    // The clock at the moment of writing, never the job's start: the newest line stands, so a disk that exists now must sort after any line written while the Brick was cold
    written = await recordKeptBytes({ botId, reason: 'made', machineBytes: provider.diskBytes?.() ?? null, now: new Date() });
  }
  if (!written && kept) kept.ok = false;
}

/**
 * Jobs that finished well and write files, whose ending is not closed yet and not older than the longest hand-over (and the minute the sweep leaves it): their
 * files may still be waiting to be read off the machine, so it is not put to rest under them. `exceptJobId` is the job asking, which is about to close its own ending.
 */
async function pendingHandOvers(botId: string, now: Date, exceptJobId?: string): Promise<number> {
  return prisma.computerJob.count({
    where: {
      botId,
      status: 'done',
      writes: true,
      endClosedAt: null,
      // Not older than the longest hand-over, or one that is still waiting in line for it (it beats while it waits, so a job behind several others, and the gap
      // between one hand-over letting go of the machine and the next taking it, are never taken for nobody waiting)
      OR: [{ endedAt: { gt: new Date(now.getTime() - 60 * 1000 - HAND_OVER_LATEST_MS) } }, { handOverAliveAt: { gt: new Date(now.getTime() - HAND_OVER_ALIVE_MS) } }],
      ...(exceptJobId ? { id: { not: exceptJobId } } : {}),
    },
  });
}

/**
 * Makes the machine if this Brick has none yet, and wakes it. Asked while it already works, it does nothing more. The making is
 * claimed in one write before the provider is called, so two jobs starting at the same moment make ONE computer, never two.
 */
async function bringUp(botId: string, provider: Provider, now: Date, kept?: { ok: boolean }): Promise<void> {
  let row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
  if (row.machine === 'working') {
    // A cleanup of the browser holds the machine for a moment: a job that arrives waits it out, so its browser is never cleared under it
    await untilCleaned(botId);
    return;
  }
  // A pack-away that was just starting is putting the computer back (a job is on it): wait for that, never wake it under the pack-away
  for (let tries = 0; row.machine === 'packing' && tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
  }
  if (row.machine === 'packing') throw new Error('The computer is being packed away');
  // Cold storage: no computer exists. One is made again and the newest proved copy put on it (the one before it if that fails); this is measured, never promised
  let cameBack: { from: Date; olderCopyUsed: boolean } | null = null;
  let returnStarted: number | null = null;
  if (row.machine === 'cold' || (row.machine === 'restoring' && row.packStage === 'returning')) {
    returnStarted = row.machine === 'cold' ? Date.now() : null;
    const back = await bringBackFromCold(botId, provider, now);
    cameBack = { from: back.from, olderCopyUsed: back.olderCopyUsed };
    row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
    // The computer made for the return costs from now on, like any new one: its disk goes into the books the same way (tried a few times, and the room held for it kept when the books will not take it)
    if (returnStarted !== null) await writeKeptDisk(botId, provider, kept);
  }
  // A machine that was to be put to sleep and is not proved asleep is not woken on top of what may still run: it is stopped first
  if (row.machine === 'stopping' && row.providerRef && !(await stopMachine(botId, row.providerRef, provider, ['stopping']))) throw new Error('The computer could not be put to sleep yet');
  if (!row.providerRef) {
    const claim = await prisma.brickComputer.updateMany({ where: { botId, providerRef: null, machine: 'none' }, data: { machine: 'waking', makeTriedAt: now } });
    if (claim.count === 1) {
      try {
        const info = await provider.create(botId);
        row = await prisma.brickComputer.update({ where: { botId }, data: { providerRef: info.ref, madeAt: now, machine: 'waking' } });
        // The machine exists and costs from now on: its disk goes into the books as kept storage, tried a few times. When the books will not take it the
        // caller is told, and keeps the room it held for the disk until the sweep has written it (the job is not failed for the books)
        await writeKeptDisk(botId, provider, kept);
      } catch (error) {
        await prisma.brickComputer.updateMany({ where: { botId, providerRef: null }, data: { machine: 'none' } });
        throw error;
      }
    } else {
      // Another job is making it right now: wait for it to finish rather than make a second one
      for (let tries = 0; tries < 20 && !row.providerRef; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
      }
      if (!row.providerRef) throw new Error('The computer is still being made by another job');
    }
  }
  const ref = row.providerRef as string;
  // A broken machine comes back from its last saved copy, and the person is told which day that was
  const restoring = row.machine === 'broken';
  await prisma.brickComputer.update({ where: { botId }, data: { machine: restoring ? 'restoring' : 'waking' } });
  await provider.wake(ref);
  // The image current, the screen and the browser up, the model address listening: a job never starts on a machine that is not ready
  try {
    await provider.ready(ref);
  } catch (error) {
    // Awake and not ready: no job will use it, so it is put to sleep (and tried again by the sweep until proved) instead of left running
    await stopMachine(botId, ref, provider, ['waking', 'restoring']);
    throw error;
  }
  // Back from cold storage on the older copy: the person is told which day their files are from (restoredFrom); the newest copy is no event to tell
  let from: Date | null = restoring ? (row.filesSavedAt ?? now) : cameBack?.olderCopyUsed ? cameBack.from : null;
  let older = cameBack?.olderCopyUsed ?? false;
  if (!restoring && cameBack === null) {
    // This call restored nothing: a second job that came in while the machine was waking after a return keeps what that return said, as the files on the machine are still those.
    // It is cleared only when the files were saved after the return finished: the saved-copy date that stood when the return began (the newest copy's, which an older-copy
    // return leaves in place) is not a save made since.
    const kept = await prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { restoredFrom: true, olderCopyUsed: true, filesSavedAt: true, returnedAt: true } });
    const outOfDate = !!kept.returnedAt && !!kept.filesSavedAt && kept.filesSavedAt.getTime() > kept.returnedAt.getTime();
    if (!outOfDate) {
      from = kept.restoredFrom;
      older = kept.olderCopyUsed;
    }
  }
  await prisma.brickComputer.update({
    where: { botId },
    data: { machine: 'working', lastWorkedAt: now, restClaimedAt: null, restoredFrom: from, olderCopyUsed: older, ...(returnStarted !== null ? { returnMs: Date.now() - returnStarted } : {}) },
  });
}

/**
 * Progress a running job reports: step n of m. Only the job's own running or waiting state may report it, and only its OWNER: the write is conditional on the owner epoch (a worker that was replaced never overwrites the owner's step), and
 * answers whether it landed (`applied`); `superseded` says the worker that asked does not own the job.
 */
export async function reportProgressAs(jobId: string, progress: { stepDone: number; stepTotal?: number | null; label?: string | null }, owner: { epoch?: EpochSaid } = {}): Promise<{ job: JobView | null; applied: boolean; superseded: boolean }> {
  const stepDone = Math.max(0, Math.trunc(progress.stepDone));
  const stepTotal = progress.stepTotal === null || progress.stepTotal === undefined ? undefined : Math.max(1, Math.trunc(progress.stepTotal));
  const done = await prisma.computerJob.updateMany({
    where: { id: jobId, status: { in: ['running', 'waiting'] }, ...ownerWhere(owner.epoch) },
    data: { stepDone, ...(stepTotal !== undefined ? { stepTotal } : {}), ...(progress.label !== undefined ? { stepLabel: cleanStepLabel(progress.label) } : {}) },
  });
  // Activity: a new step the owner reported is kept in the job's list of steps (the same owner rule, in its own conditional write)
  if (done.count === 1) await appendStep(jobId, progress.label, owner);
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return { job: job ? jobView(job) : null, applied: done.count === 1, superseded: !!job && !epochMatches(job.ownerEpoch, owner.epoch) };
}

/** `reportProgressAs` for a caller that only wants the job as it stands. */
export async function reportProgress(jobId: string, progress: { stepDone: number; stepTotal?: number | null; label?: string | null }, owner: { epoch?: EpochSaid } = {}): Promise<JobView | null> {
  return (await reportProgressAs(jobId, progress, owner)).job;
}

/**
 * A job that keeps running renews its room each stretch. If the allowance or our room is used up, or the room is gone, it saves
 * and stops safely: what it did stays, nothing new starts and no step is cut in half by this call.
 *
 * The whole decision is ONE transaction, under the job's cutoff lock with its row locked (GPT round 5, E3/E6): the worker that asks still OWNS the job (`owner.epoch` is the job's owner epoch: an older worker's renewal is `stale`/`superseded`
 * and adds zero room), no finish intent is kept and no pool cutoff is decided (then the finalizer owns the ending: `ending`, zero room, nothing written), and only then is the room renewed in that same transaction. A refusal ends the
 * job only as the owner it was decided for (the ending's own write is conditional on the owner epoch, with no intent or cutoff kept), and the slow end runs after the lock is let go.
 */
export async function renewJob(
  jobId: string,
  now: Date = new Date(),
  /** The worker that renews (the epoch it won by its claim; none = a worker that knows none, good only while the job has none). Orbit's own renewal of a waiting job names the epoch it read. */
  owner: { epoch?: EpochSaid } = {},
): Promise<
  | { ok: true; renewInSeconds: number }
  | { ok: false; reason: 'allowance' | 'pool' | 'closed' | 'over' | 'unanswered' | 'ending' }
  | { ok: false; reason: 'stale'; /** A worker that does not own the job: the caller exits. */ run: 'superseded' }
  | { ok: false; reason: 'rule'; words: string }
  | { ok: false; /** The month or a limit the person set paused the job (it is NOT over): the worker aborts its turn, sends no cancel and no finish (Orbit owns both), and exits on the moved epoch. */ reason: 'paused'; why: 'allowance' | 'rule' }
> {
  const first = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (first && isOver(first.status) && first.endedBy === 'unanswered') return { ok: false, reason: 'unanswered' };
  if (!first || isOver(first.status)) return { ok: false, reason: 'over' };
  // A job in line has no room yet: nothing to renew, and it is not over. A worker that no longer owns it (the job was paused under it) is told so, never "renew in a minute"
  if (first.status === 'queued') return epochMatches(first.ownerEpoch, owner.epoch) ? { ok: true, renewInSeconds: 60 } : SUPERSEDED;
  if (!first.reservationKey) return { ok: false, reason: 'over' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: first.botId } });
  const provider = providerFor(row);
  const settings = await getMeterSettings();
  const moreMicros = roomFor(settings.renewMinutes, provider ? provider.microsPerMinute() : null);
  // Read when called: lib/computer-job-controls builds on this module
  const controls = await import('@/lib/computer-job-controls');
  const decided = await prisma.$transaction(
    async (tx) => {
      const job = await lockJob(tx, jobId);
      if (!job || isOver(job.status)) return { kind: 'over' as const };
      if (!epochMatches(job.ownerEpoch, owner.epoch)) return { kind: 'superseded' as const };
      // The finalizer owns the ending once an intent is kept or a cutoff is decided: no room is added, nothing is written
      if ((await hasFinishIntent(tx, jobId)) || (await hasPoolCutoff(tx, jobId))) return { kind: 'ending' as const };
      if (job.status === 'queued') return { kind: 'ok' as const, epoch: job.ownerEpoch };
      const key = (await tx.computerJob.findUnique({ where: { id: jobId }, select: { reservationKey: true } }))?.reservationKey;
      if (!key) return { kind: 'over' as const };
      const room = await renewRoomIn(tx, { key, moreMicros }, now);
      if (room.ok) {
        // The lease is renewed, so the keys of the owner's epoch are too (one that ended is not brought back, another epoch's is not this owner's)
        await renewJobTokens(jobId, now, job.ownerEpoch, tx);
        // A renewal from the owner is a beat too: the hold on the job stands another 90 s, written here so a busy runner never loses the job to a claim while it works (GPT round 6, finding 3)
        await tx.$executeRaw`UPDATE "computer_jobs" SET "lease_version" = "lease_version" + 1 WHERE "id" = ${jobId}`;
        await extendHoldIn(tx, jobId, leaseUntil(now));
        return { kind: 'ok' as const, epoch: job.ownerEpoch };
      }
      // The person's month or a limit they set: the job PAUSES and waits (piece 3), decided right here, in the same transaction and under the same locks as the refusal (the owner, no kept intent, no cutoff: all read
      // above). Its time so far is charged and the unused room released in this commit; it carries on by itself when more arrives. While the person holds the screen it pauses too: the screen is taken back in
      // the same write and it never carries on by itself (Fable's ruling of 23 Nov, section 7)
      if (room.reason === 'allowance' || room.reason === 'rule') {
        const paused = await controls.decidePauseIn(tx, jobId, room.reason, now, provider, { ownerEpoch: job.ownerEpoch, heldOnly: true, heldScreen: true, blocked: { kind: 'renewal', micros: moreMicros } });
        if (paused.kind === 'held') return { kind: 'paused' as const, paused, why: room.reason };
      }
      return { kind: 'refused' as const, room, epoch: job.ownerEpoch };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  if (decided.kind === 'over') {
    const again = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, endedBy: true } });
    return again && isOver(again.status) && again.endedBy === 'unanswered' ? { ok: false, reason: 'unanswered' } : { ok: false, reason: 'over' };
  }
  if (decided.kind === 'superseded') return SUPERSEDED;
  if (decided.kind === 'ending') return { ok: false, reason: 'ending' };
  if (decided.kind === 'ok') {
    // Each renewal holds more room, so the runner is told how often to ask: well inside the time the room is held, never so often it over-holds
    return { ok: true, renewInSeconds: first.status === 'queued' ? 60 : Math.max(30, Math.min(Math.floor(settings.renewMinutes * 60 * 0.4), TOKEN_RENEW_EVERY_SECONDS)) };
  }
  if (decided.kind === 'paused') {
    // Rule C: the turn the commit read is cancelled only now, the stretch is written, the machine rests and the line moves
    await controls.afterPause(jobId, decided.paused, now);
    return { ok: false, reason: 'paused', why: decided.why };
  }
  const room = decided.room;
  const report: EndReport = {};
  const asOwner = { owner: { epoch: decided.epoch }, refusal: {} };
  if (room.ok) return { ok: true, renewInSeconds: 60 };
  if (room.reason === 'rule') {
    // A rule the person said in chat stops it here, saying so: not "our room is used up", and nothing to ask more credit for
    // Its words are kept for the message that tells the person (the report back), in the very write that ends the job
    await endJob(jobId, 'stopped', 'rule', now, true, undefined, true, null, false, { ...asOwner, note: cleanEndNote(room.words) }, report);
    return refusedAnswer(report, { ok: false, reason: 'rule', words: room.words } as const);
  }
  const reason = room.reason === 'allowance' ? 'allowance' : room.reason === 'closed' ? 'closed' : 'pool';
  // Our own pool or envelope having no room is OUR ending, like a closed room: kept as `pool` (the person is told our computers were busy) and given back in full (time, model calls, the
  // credit they drew), never counted, with an orbit_fault decision that says why. A model call refused for the same cause is `pool_busy`, a fault of ours, so the two endings must not disagree
  await endJob(jobId, 'stopped', reason === 'allowance' ? 'allowance' : reason === 'closed' ? 'error' : 'pool', now, true, undefined, true, null, false, asOwner, report);
  return refusedAnswer(report, { ok: false, reason } as const);
}

/** What a refused renewal answers: its own refusal when it ended the job, `superseded` when another worker owned the job by the time the ending was written, `ending` when an intent or cutoff owns the ending now. */
function refusedAnswer<T extends { ok: false; reason: string }>(report: EndReport, own: T): T | typeof SUPERSEDED | { ok: false; reason: 'ending' } {
  if (report.superseded) return SUPERSEDED;
  if (report.deferred) return { ok: false, reason: 'ending' };
  return own;
}

/**
 * A model call of a running job was refused because the person's own allowance is used up, or a rule they said does not let it go on: the job ends now,
 * the way a refused renewal ends it, as theirs (`allowance` or `rule`), but ONLY while the call's own key is still good and still the owner's (`from`: the key's id and the epoch it was made under), decided in the very write
 * that ends the job under the cutoff lock (no intent kept, no cutoff decided: then the finalizer owns the ending): a delayed call of a worker that was replaced is refused alone, and the job runs on. Whatever the computer's runner says
 * about it later changes nothing: a job that is over is not ended again, so a failed turn after the refusal can never end it as ours and give back everything it ran before the limit. Safe to say twice; a job already over is left as it is.
 * `pool` is the other way round: it is the FINALIZER of a pool cutoff that was decided (only while the decision stands): every call the job made was refused for OUR capacity, so it ends as `pool` (ours: given back in full, never counted) with its words kept for the person.
 */
export async function stopJobForRefusal(jobId: string, why: { reason: 'allowance' } | { reason: 'rule' | 'pool'; words: string }, now: Date = new Date(), from?: { epoch: number; tokenId: string }): Promise<EndReport> {
  const report: EndReport = {};
  // Its words are kept for the message that tells the person (the report back), written in the very write that ends the job
  const note = why.reason === 'rule' || why.reason === 'pool' ? cleanEndNote(why.words) : null;
  const guard: EndGuard = why.reason === 'pool' ? { cutoffRequired: true, note } : { owner: { epoch: from ? from.epoch : null }, refusal: from ? { key: from.tokenId } : {}, note };
  await endJob(jobId, 'stopped', why.reason, now, true, undefined, true, null, false, guard, report);
  return report;
}

/** The job finished: its machine is saved and rests, what it cost is counted, and the next job in line starts. Safe to say twice. `owner`: the worker that ends it (the epoch it owns by); decided in the write that ends the job. */
export async function finishJob(jobId: string, outcome: 'done' | 'failed', now: Date = new Date(), why?: string | null, cause?: FinishCause | null, turns?: number[] | null, run?: string | null, owner?: { epoch: EpochSaid }): Promise<JobView | null> {
  return (await finishWith(jobId, { outcome, now, why, cause, turns, run }, owner ? { owner: { epoch: owner.epoch ?? null }, intentFirst: true } : {})).job;
}

/** What a runner said when it finished a job, or committed to doing so. */
interface Said {
  outcome: 'done' | 'failed';
  now: Date;
  why?: string | null;
  cause?: FinishCause | null;
  turns?: number[] | null;
  run?: string | null;
}

/** What the runner's kept intent says, as a finish says it. */
const saidByIntent = (intent: { outcome: string; why: string | null; cause: string | null; turns: number[]; run: string | null }, now: Date): Said => ({
  outcome: intent.outcome === 'done' ? 'done' : 'failed',
  now,
  why: intent.why,
  cause: intent.cause === 'ours' || intent.cause === 'agent' ? intent.cause : null,
  turns: intent.turns.length > 0 ? intent.turns : null,
  run: intent.run,
});

/**
 * The one way a runner's finish ends a job. `guard` is what the very write that lands the ending must still find true (the control generation the runner acts under, Brick's control, the owner epoch of the worker that ends it), `intentFirst` that no finish intent was kept
 * before it (read under the cutoff lock in that write: when one was, the job ends as the intent said, never as this finish says). Answers whether the generation had moved (`stale`), whether THIS call wrote the ending (`ended`), whether
 * the person had the job (`notBrick`, nothing written), and the job as it stands.
 */
async function finishWith(
  jobId: string,
  said: Said,
  guard: Pick<EndGuard, 'generation' | 'brick' | 'intentFirst' | 'owner' | 'startNextAt'>,
  /** Whether the next job in line may start once this one is over. False for a Stop of everything: nothing in line may start while that Stop ends them all. */
  advance = true,
): Promise<{ stale: boolean; superseded: boolean; ended: boolean; notBrick: boolean; job: JobView | null }> {
  const report: EndReport = {};
  // At most one turn of "an intent was kept first": the intent's own words are never judged against another intent
  for (let round = 0; round < 2; round++) {
    const mine = round === 0 ? said : saidByIntent(report.intent as NonNullable<EndReport['intent']>, said.now);
    const current = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, controlGeneration: true } });
    report.intent = null;
    // A job that never started (still in line) did not finish: it is stopped by the person or starts, never "done"
    if (current && current.status !== 'queued') {
      // The computer's own sentence about why it could not go on is kept with the ending itself (the same write: a take-over that wins leaves no note under the new controller)
      const note = mine.outcome === 'failed' ? cleanEndNote(mine.why) : null;
      // The runner's cause is only a HINT. Every failed finish is judged by Orbit from the relay's durable rows (lib/computer-giveback): a confirmed fault only OURS can cause is given back
      // under any hint, whichever arrives first, the rows or the finish (a row that comes after is looked at again: afterLateEvidence). Hint `ours` is judged as before; the agent's own, or
      // nothing, reads the turns the runner named (or the last turn with a row) and gives goodwill only for an unresolved row. A run is never made free by ending it "failed" with nothing recorded
      const ours = mine.outcome === 'failed' && mine.cause === 'ours';
      // The run the runner reported is carried whatever else it named: it is where the relay's arrival is looked for (never another run's). Which fault rows are read does not follow it (no turn named: every row of the job)
      const runner = mine.outcome !== 'failed' ? null : { turns: mine.turns ?? null, run: mine.run ?? null, hint: ours ? ('ours' as const) : mine.cause === 'agent' ? ('agent' as const) : ('none' as const) };
      // A finish honors a pool cutoff Orbit decided for this job (`finish`): such a job ends as `pool` (ours, given back), never as the outcome the runner reports after its keys were ended for our own capacity
      await endJob(jobId, mine.outcome, ours ? 'error' : null, mine.now, advance, undefined, true, runner, true, { generation: guard.generation, brick: guard.brick, intentFirst: guard.intentFirst && round === 0, owner: round === 0 ? guard.owner : undefined, note, startNextAt: guard.startNextAt }, report);
    }
    if (!report.intent) break;
  }
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return { stale: report.stale === true, superseded: report.superseded === true, ended: report.ended === true, notBrick: report.notBrick === true, job: job ? jobView(job) : null };
}

/**
 * `finishJob` for a runner that says the control generation it acts under: a finish from an older generation than the job's is `stale` and does nothing (the person took the machine since, and a newer controller owns the job). Without a
 * generation it is `finishJob` exactly as before (a runner that does not say one, such as 0.4.3's). Answers the job as it stands either way. The generation is looked at again in the write that ends the job (a take-over
 * between the two moves it: nothing is written and the answer is `stale`), and so is a finish intent kept meanwhile: a job whose runner committed to ending it ends as the intent said, whatever this finish says (the committed
 * word is first, and a replacement runner or a replayed finish with other values changes nothing). `epoch` is the ownership epoch the worker says it owns the job by (none = a worker that knows none, good only for a job nobody claimed): a finish from a worker
 * that does not own the job is `stale` with `superseded`, decided in the look and again in the write that ends the job, and ends nothing.
 */
export async function finishJobUnder(
  jobId: string,
  generation: number | null | undefined,
  outcome: 'done' | 'failed',
  now?: Date,
  why?: string | null,
  cause?: FinishCause | null,
  turns?: number[] | null,
  run?: string | null,
  epoch?: EpochSaid,
): Promise<{ stale: boolean; /** Stale because another worker owns the job (not the control generation). */ superseded?: boolean; job: JobView | null }> {
  const intent = await prisma.computerFinishIntent.findUnique({ where: { jobId } });
  // A kept intent is the committed word that stands whoever sends the finish (a replacement, a worker that never claimed): it is completed as it said, so it is never turned away by the epoch
  if (!intent) {
    const current = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { ownerEpoch: true } });
    if (current && !epochMatches(current.ownerEpoch, epoch)) return { stale: true, superseded: true, job: (await getJob(jobId)) ?? null };
  }
  if (generation !== undefined && generation !== null) {
    const current = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { controlGeneration: true } });
    if (current && current.controlGeneration !== generation) return { stale: true, job: (await getJob(jobId)) ?? null };
  }
  const at = now ?? new Date();
  const said: Said = intent ? saidByIntent(intent, at) : { outcome, now: at, why, cause, turns, run };
  const done = await finishWith(jobId, said, { generation, intentFirst: !intent, owner: intent ? undefined : { epoch: epoch ?? null } });
  return { stale: done.stale, ...(done.superseded ? { superseded: true } : {}), job: done.job };
}

/** Stop: from the person's tap. The work so far is kept. Null when it is not their Brick. */
export async function stopJobFor(botId: string, ownerId: string, now: Date = new Date()): Promise<ComputerView | null> {
  const stopped = await stopAll(botId, ownerId, now);
  return stopped.ok ? stopped.view : null;
}

/** What Stop came to: the computer as it stands after, or why not (not the owner's Brick; a command id already used for another control). */
export type Stopped = { ok: true; view: ComputerView } | { ok: false; reason: 'not_found' | 'command_reused' };

/**
 * Stop everything on the computer, under the tap's (or Brick's tool call's) command id when it has one (finding 4): the command's row is committed FIRST, naming the jobs that are on the computer at that moment, then those
 * jobs end through the finalizer's own transactions. The same id again answers what it came to, or, while the first request did not keep that (it stopped half way), finishes ending THOSE jobs: never one that was
 * started after the Stop. Without a command (the 0.4.3 game's Stop) it ends what is there now, as before.
 */
export async function stopAll(botId: string, ownerId: string, now: Date = new Date(), command?: Command): Promise<Stopped> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  let targets: string[] | null = null;
  if (command) {
    const row = commandRow(botId, ownerId, null, 'stop');
    const seen = await seenCommand(command, row);
    const claimed =
      seen ??
      (await prisma.$transaction(async (tx) => {
        const live = (await tx.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting', 'queued'] } }, select: { id: true }, orderBy: { id: 'asc' } })).map((job) => job.id);
        const got = await claimCommandIn(tx, command, row, { ok: true, pending: true, targets: live });
        return 'fresh' in got ? { live } : got;
      }, { timeout: 15_000, maxWait: 15_000 }));
    if ('reused' in claimed) return { ok: false, reason: 'command_reused' };
    if ('replay' in claimed && claimed.replay) {
      const view = await computerView(botId, ownerId, now);
      return view ? { ok: true, view } : { ok: false, reason: 'not_found' };
    }
    targets = 'live' in claimed ? claimed.live : (claimed.targets ?? []);
  }
  await endEverything(botId, now, targets);
  if (command) {
    // A job asked for after the Stop is not the Stop's: it was left in line, and the line moves for it now that the Stop's jobs are over. The Stop's answer is kept only AFTER the line has moved: a request that
    // stopped between the two leaves it pending, and its retry ends the same jobs again (those are over already) and moves the line, never adding a later job to the Stop (CodeRabbit on #1025, 31)
    await startNext(botId, now);
    await keepOutcome(prisma, command, { ok: true, targets: targets ?? [] });
  }
  const view = await computerView(botId, ownerId, now);
  return view ? { ok: true, view } : { ok: false, reason: 'not_found' };
}

/** Ends what is on the Brick's computer (with `only`, only those jobs, whatever they are now). */
async function endEverything(botId: string, now: Date, only: string[] | null): Promise<void> {
  // Stop ends what is running or waiting for them, and what is in line too (a job waiting for the allowance must not start later)
  // The ones in line end FIRST: ending the running one starts the next in line, and that must not start a job that is about to be stopped
  const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting', 'queued'] }, ...(only ? { id: { in: only } } : {}) }, select: { id: true, status: true } });
  const inLine = jobs.filter((job) => job.status === 'queued');
  const held = jobs.filter((job) => job.status !== 'queued');
  // Nothing in line may start while this Stop ends everything, so no end of a job in it moves the line
  for (const job of inLine) {
    // Ended as a job in line only while it still is one: it may have started since it was read, and then it is a job that holds the machine, which ends under the rule for those
    await endJob(job.id, 'stopped', 'person', now, false, 'queued');
    const started = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true } });
    if (started?.status === 'running' || started?.status === 'waiting') await endJob(job.id, 'stopped', 'person', now, false, undefined, true, null, false, { personStop: true });
  }
  // A job that holds the machine ends as the ending already committed for it says, when there is one (a runner's kept intent, a decided pool cutoff): the person's Stop never makes a fault of ours their own stop
  for (const job of held) await endJob(job.id, 'stopped', 'person', now, false, undefined, true, null, false, { personStop: true });
}

/**
 * Reads where the browser on a job's computer went while the job held it, and keeps that under the job (R06). Only an awake machine is read (a
 * command would wake it); one that is not leaves the record "unread". Best effort and quick, never holds up the end of the job.
 */
async function recordJobVisits(job: { id: string; botId: string; startedAt: Date | null }, endedAt: Date): Promise<void> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
    const provider = providerFor(row);
    if (!row?.providerRef || !provider || row.machine !== 'working') {
      // Said whatever the state was (as a failed read says it): a job whose first stretch kept `complete` and whose last stretch could not be read is no longer a complete record. Rows kept earlier stay (CodeRabbit on #1025, 30)
      await prisma.computerJob.updateMany({ where: { id: job.id, OR: [{ visitsState: null }, { visitsState: { not: 'unread' } }] }, data: { visitsState: 'unread' } });
      return;
    }
    await recordVisits(job, provider, row.providerRef, endedAt);
  } catch (error) {
    console.error('[Computer] Could not record where a job’s computer browsed:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * Once no job holds an awake machine: what is on it is listed for the Files list, then the browser is cleared (the image's
 * `universe-clean`), so a page one job was signed in to never carries into the next and a screen link left open goes dead. Best
 * effort and quick: a machine that is not awake is left alone (a command would wake it), and a step that fails never holds up the end of
 * the job (it is logged for the one who looks; the list from the last job stays).
 */
async function closeOutIfUnheld(botId: string): Promise<FilesList | null> {
  let claimedAt: Date | null = null;
  let taken: FilesList | null = null;
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId } });
    const provider = providerFor(row);
    if (!row?.providerRef || !provider || row.machine !== 'working') return null;
    const holders = () => prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } });
    if ((await holders()) > 0) return null;
    // The cleanup is claimed first (one at a time, a claim that was never let go is taken over after a while), and the holders are counted
    // again after: a job that took the machine before the claim is seen here, and one that comes after it waits for the cleanup in bringUp
    const now = new Date();
    const claim = await prisma.brickComputer.updateMany({
      where: { botId, machine: 'working', OR: [{ cleanClaimedAt: null }, { cleanClaimedAt: { lte: new Date(now.getTime() - CLEAN_CLAIM_STALE_MS) } }] },
      data: { cleanClaimedAt: now },
    });
    if (claim.count !== 1) return null;
    claimedAt = now;
    if ((await holders()) > 0) return null;
    try {
      const listed = await provider.exec(row.providerRef, 'universe-files', { timeoutMs: 20_000 });
      if (listed.exitCode === 0 && !listed.truncated) {
        taken = parseFilesList(listed.stdout, new Date());
        await prisma.brickComputer.updateMany({ where: { botId, providerRef: row.providerRef }, data: { filesList: taken as unknown as Prisma.InputJsonValue } });
      }
    } catch (error) {
      console.error('[Computer] Could not list the files after a job:', error instanceof Error ? error.message : 'unknown');
    }
    if ((await holders()) > 0) return taken;
    const cleaned = await provider.exec(row.providerRef, 'universe-clean', { timeoutMs: 20_000 });
    // A profile that could not be removed stays marked on the machine, and the next start-up removes it before any job can use it
    if (cleaned.exitCode !== 0 || !/(^|\n)cleaned=1\s*$/.test(cleaned.stdout)) console.error('[Computer] The browser could not be cleared after a job; it is cleared before the next one');
  } catch (error) {
    console.error('[Computer] Could not clear the browser after a job:', error instanceof Error ? error.message : 'unknown');
  } finally {
    if (claimedAt) await prisma.brickComputer.updateMany({ where: { botId, cleanClaimedAt: claimedAt }, data: { cleanClaimedAt: null } }).catch(() => undefined);
  }
  return taken;
}

/** How long a claim for handing over files is believed: the hand-over ends within its own time budget, so one older than this was left by a server that stopped. */
const FILES_CLAIM_MS = HAND_OVER_LATEST_MS;
/** How long a job that ended while another job's files were being read waits for them to be done before its own are read, and how often it looks. */
const CLAIM_WAIT_MS = HAND_OVER_LATEST_MS;
const CLAIM_POLL_MS = 500;
let claimWaitMs = CLAIM_WAIT_MS;
/** For tests: how long a hand-over waits for another one. */
export function setHandOverClaimWaitForTests(ms: number | null): void {
  claimWaitMs = ms ?? CLAIM_WAIT_MS;
}

/**
 * Waits while the browser of this Brick's machine is being cleared, so the job that is starting is not cleared under. It waits out a claim that is
 * still being renewed for as long as one machine command may take, plus its own slack (`CLEAN_CLAIM_STALE_MS`): waiting less would let this job start
 * beside a command that is still stopping, moving and starting that browser (CodeRabbit N7 on #1025).
 */
async function untilCleaned(botId: string): Promise<void> {
  for (let tries = 0; tries < Math.ceil(CLEAN_CLAIM_STALE_MS / 250); tries++) {
    const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { cleanClaimedAt: true } });
    if (!row?.cleanClaimedAt || Date.now() - row.cleanClaimedAt.getTime() > CLEAN_CLAIM_STALE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * What an ending must still find true in the very write that lands it (not only when it was decided): the control generation the caller acts under (a person's take-over since makes it stale and nothing is written), Brick's
 * control (a take-over since leaves the job to them), and, for a runner's finish, that no finish intent was kept first (read under the cutoff lock, in the transaction that writes the ending).
 */
interface EndGuard {
  generation?: number | null;
  brick?: boolean;
  intentFirst?: boolean;
  /** The ownership epoch of the worker that ends the job (none = a worker that knows none, good only for a job nobody claimed): a job another worker owns is not ended by it (`stale` and `superseded`, nothing written), decided in the look and in the write that lands the ending. */
  owner?: { epoch: number | null };
  /** An ending decided by a model call or a refused renewal: written only under the cutoff lock, while no finish intent is kept and no pool cutoff is decided (then the finalizer owns the ending: `deferred`, nothing written), and, when a call's key is named, while that key is still good. */
  refusal?: { key?: string };
  /** The finalizer of a pool cutoff that was decided: written only while the decision stands (under the cutoff lock). */
  cutoffRequired?: boolean;
  /** A sweep's ending: the values the job was selected on. It is written only if the job, read again under its lock, still has every one of them (status, control, control generation, owner epoch, lease version, hand-over count) and the condition it was selected for still holds at that moment: the wait is still past its limit (`unansweredBefore`), the reservation is still held and expired as it was seen (`lease`). Anything else is skipped (`deferred`) and judged again next pass. */
  observed?: { status: string; control: string; controlGeneration: number; ownerEpoch: number; leaseVersion: number; handoverSeq: number; unansweredBefore?: Date; lease?: { key: string; expiresAt: Date } };
  /** The runner's sentence about why it could not go on: written in the very write that ends the job, so a take-over that wins leaves no note behind. */
  note?: string | null;
  /** The person's own Cancel of one job, or their Stop, of a job that HOLDS the machine: written under the cutoff lock, and an ending already committed governs instead of theirs (GPT round 6, finding 2): a decided pool cutoff ends the job as ours, and a kept finish intent ends it as the runner's committed word said. The person's ending of a job still in line is untouched. */
  personStop?: boolean;
  /** When the job that comes next in line STARTS, if that is not the time of this ending (a sweep that completes a finish intent ends the job as of the intent's time, its own accounting, but the next job starts now: its room, lease and checks begin at its real start). */
  startNextAt?: Date;
  /** One start's own room key: an ending decided while bringing the machine up lands only while that try's room is still the job's (GPT round 6, finding 3b). A pause and resume in between gave the job another room, so the old try's outcome lands on nothing and the job that runs now is left alone. */
  reservation?: string;
}

/** What an ending found: it wrote the end (`ended`), found the generation moved (`stale`), found the person in control (`notBrick`), or found a finish intent kept first (`intent`: the caller ends it with the intent's own words). */
interface EndReport {
  ended?: boolean;
  stale?: boolean;
  /** The stale was the owner's (another worker owns the job), not the control generation's. */
  superseded?: boolean;
  /** An intent or a cutoff owns the ending (its finalizer ends the job), or the call's key was no longer good: nothing was written. */
  deferred?: boolean;
  notBrick?: boolean;
  intent?: Prisma.ComputerFinishIntentGetPayload<Record<string, never>> | null;
}

/** How many times an end is tried again when the job's state moved between reading it and writing the end. */
const END_TRIES = 4;

/**
 * Ends a job once. Whatever it ran is worked out from the seconds the machine was held for it, recorded in the meter's books as
 * one event under the job's id, and its reserved room is settled to that. Then the machine rests if no other job holds it, and
 * the next job in line is tried. A job that is already over is left exactly as it ended.
 * `runner` is set only for the runner's own finish as ours: whether it is given back is judged from the relay's durable rows and the bound on goodwill
 * (lib/computer-giveback), and the decision is kept. Every other ending as `error` was seen by Orbit itself and is always given back (and recorded).
 * `outside` false writes only our own tables (the Brick's purge ends its jobs this way, so a slow provider or backup never holds the purge):
 * the machine, its browser and the agent's turn are left to the purge's own removal of the machine.
 */
async function endJob(jobId: string, status: 'done' | 'stopped' | 'failed', endedBy: EndedBy | null, now: Date, advance = true, only?: string, outside = true, runner: { turns: number[] | null; run?: string | null; /** What the runner said the cause was: `ours` is judged from the rows and bounded; any other is a hint read against the rows of the named turns. */ hint?: 'ours' | 'agent' | 'none' } | null = null, finish = false, guard: EndGuard = {}, report: EndReport = {}): Promise<void> {
  // A finish reported by the runner honors a committed pool cutoff (Orbit decided to end this job for its own capacity: its keys were ended and the runner's own failure, or "done", follows from that). It is ended as
  // `pool` instead (stopped, ours: its time given back, never counted, with the words the person is told). The decision is read first; and again under the cutoff lock in the very transaction that writes the ending,
  // because a cutoff that commits between the two would otherwise lose to a finish that has already read "not decided". A cutoff takes the same lock and only decides for a job that is still on
  let note = guard.note ?? null;
  // The person's own Cancel or Stop of a held job reads the committed ending under the cutoff lock. Once it has been read and the ending became the pool's own, this is over: the ending is then written as the
  // finalizer of that cutoff writes it (`orbitSeen`), and reading the decision again would only find it a second time
  let personStop = guard.personStop === true;
  const endForPool = async (): Promise<void> => {
    const kept = cleanEndNote(POOL_BUSY_WORDS);
    if (kept) await prisma.computerJob.updateMany({ where: { id: jobId, status: { in: ['running', 'waiting'] } }, data: { endNote: kept } });
    status = 'stopped';
    endedBy = 'pool';
    runner = null;
    finish = false;
    personStop = false;
    // The words the person is told are ours (the pool's), not the runner's
    note = null;
  };
  if (finish && (await hasPoolCutoff(prisma, jobId))) await endForPool();
  // The job can change under this (a person's answer moves it between running and waiting): the end is tried again on what it is now, and
  // only a job that is over, or no longer the one the caller meant, is let go
  let job: NonNullable<Awaited<ReturnType<typeof prisma.computerJob.findUnique>>> | null = null;
  let seconds = 0;
  let ended = { count: 0 };
  for (let attempt = 0; attempt < END_TRIES && ended.count === 0; attempt++) {
    job = await prisma.computerJob.findUnique({ where: { id: jobId } });
    if (!job || isOver(job.status)) return;
    // A caller that saw the job in line ends it only while it still is: another try may have put it on the machine in between
    if (only !== undefined && job.status !== only) return;
    // The caller's generation and Brick's control are looked at on every try, and they are part of the write below: a take-over between this read and that write moves them, the write lands on nothing, and the next try says so
    if (guard.generation !== undefined && guard.generation !== null && job.controlGeneration !== guard.generation) {
      report.stale = true;
      return;
    }
    if (guard.brick && job.control !== 'brick') {
      report.notBrick = true;
      return;
    }
    if (guard.owner && !epochMatches(job.ownerEpoch, guard.owner.epoch)) {
      report.stale = true;
      report.superseded = true;
      return;
    }
    // A sweep's ending is for the job as it was selected: anything that moved since (a renewal, a claim, an answer, a take-over, a hand-over) leaves it alone, to be judged again by the next pass
    const seen = guard.observed;
    if (seen && (job.status !== seen.status || job.control !== seen.control || job.controlGeneration !== seen.controlGeneration || job.ownerEpoch !== seen.ownerEpoch || job.leaseVersion !== seen.leaseVersion || job.handoverSeq !== seen.handoverSeq || (seen.unansweredBefore && !(job.stretchStarted && job.stretchStarted.getTime() <= seen.unansweredBefore.getTime())))) {
      report.deferred = true;
      return;
    }
    const held = job.status === 'running' || job.status === 'waiting';
    const stretch = held && job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
    seconds = job.secondsRun + stretch;
    // The seconds were worked out from what was read: the end lands only on that same snapshot. A take-over and a hand-back in between leave the status as
    // it was but move the seconds and the stretch, and an end written from the old read would put the smaller count over the newer one
    const endData = {
      status,
      endedBy,
      endedAt: now,
      queuedFor: null,
      waitingFor: null,
      readyWhat: null,
      readyWhere: null,
      control: 'brick',
      stretchStarted: null,
      secondsRun: seconds,
      agentResponseId: null,
      brief: null,
      // What it waited for is kept when nobody answered, so Brick can say which step it waited at; no wait is left to tell about
      endWaitingFor: endedBy === 'unanswered' ? job.waitingFor : null,
      handoverUntold: false,
      // The person's own Stop, a computer turned off and a Brick deleted are never told: they just did it
      endToldAt: silentEnding(endedBy) ? now : null,
      ...(note ? { endNote: note } : {}),
      // A job that finished well and writes files hands them over next: it says so in the SAME write that ends it, so there is no moment when it is over and nothing says its time is
      // still to be added (a sweep that settled its room in that gap would settle too little, and a room's first settlement is the one kept). The hand-over clears it when it is
      // done; one that never runs (the server stopped) leaves a mark that ages out after HAND_OVER_ALIVE_MS, and the sweep settles the job then, once
      ...(outside && held && status === 'done' && job.writes ? { handOverAliveAt: now } : {}),
    } as const;
    // An ending the runner reported as ours is decided from the relay's durable rows and the bound on goodwill (lib/computer-giveback), in the same transaction that
    // writes the ending and under the person's give-back lock, so two of their jobs ending together cannot both take the last give-back. A job that is not given back
    // ends as a failure that is the person's, charged provisionally when the decision cannot be made yet (it is then decided again by the sweep, never a final charge)
    const runnerJudged = runner !== null && endedBy === 'error' && job.startedAt !== null;
    // A failure the runner did not call ours is read against the rows too (the turns it named, or the last turn with a row): a confirmed fault of ours is given back, an unresolved one is bounded goodwill, nothing recorded stays the person's
    const hintJudged = runner !== null && runner.hint !== 'ours' && endedBy === null && status === 'failed' && job.startedAt !== null;
    // An ending Orbit saw itself is always given back; it is kept in the same record
    const orbitSeen = runner === null && (endedBy === 'error' || endedBy === 'pool') && job.startedAt !== null;
    const turnHold = held && !!job.firstTurnSentAt && !job.agentResponseId;
    const where = { id: jobId, status: job.status, secondsRun: job.secondsRun, stretchStarted: job.stretchStarted, ...(guard.reservation ? { reservationKey: guard.reservation } : {}), ...(guard.generation !== undefined && guard.generation !== null ? { controlGeneration: guard.generation } : {}), ...(guard.brick ? { control: 'brick' as const } : {}), ...(guard.owner ? { ownerEpoch: guard.owner.epoch ?? 0 } : {}), ...(guard.observed ? { control: guard.observed.control, controlGeneration: guard.observed.controlGeneration, ownerEpoch: guard.observed.ownerEpoch, leaseVersion: guard.observed.leaseVersion, handoverSeq: guard.observed.handoverSeq } : {}), agentResponseId: job.agentResponseId };
    // Written under the cutoff lock: a finish (it honors a decided cutoff and a kept intent), a refusal (the finalizer owns the ending once an intent is kept or a cutoff is decided) and the finalizer of a decided cutoff (only while the decision stands)
    const locked = finish || !!guard.refusal || !!guard.cutoffRequired || personStop;
    // What is read under the cutoff lock, before anything is written: null = go on and write; else why nothing is written (an intent is kept first, a cutoff decided for a finish, or an intent, a cutoff, a key that ended or a finalizer's missing decision for the others)
    const decideUnderCutoff = async (tx: Prisma.TransactionClient): Promise<{ cutoffDecided: boolean; intent: Prisma.ComputerFinishIntentGetPayload<Record<string, never>> | null; deferred: boolean } | null> => {
      const cut = await hasPoolCutoff(tx, jobId);
      // The finalizer of a decided cutoff writes only while the decision stands (a cutoff that was retired, or a job that was ended already, leaves nothing to finalize)
      if (guard.cutoffRequired) return cut ? null : { cutoffDecided: false, intent: null, deferred: true };
      if (guard.refusal) {
        // A refusal never writes its own ending once an intent is kept or a cutoff is decided (the finalizer owns it), nor for a call whose key ended (a newer owner claimed, the person took over, the job ended)
        if (cut || (await tx.computerFinishIntent.findUnique({ where: { jobId }, select: { jobId: true } }))) return { cutoffDecided: false, intent: null, deferred: true };
        // A lapsed lease is ended only while the reservation it was selected for is still held and still expired as it was seen (a renewal that landed since extended it)
        const lease = guard.observed?.lease;
        if (lease) {
          const held = await tx.meterReservation.findUnique({ where: { reservationKey: lease.key }, select: { state: true, expiresAt: true } });
          if (!held || held.state !== 'held' || held.expiresAt.getTime() !== lease.expiresAt.getTime() || held.expiresAt.getTime() > now.getTime()) return { cutoffDecided: false, intent: null, deferred: true };
          // ...and it is still THE job's room: a job claimed under a newer key is not ended by an older room lapsing (the terminal write repeats this in its WHERE)
          if ((await tx.computerJob.findUnique({ where: { id: jobId }, select: { reservationKey: true } }))?.reservationKey !== lease.key) return { cutoffDecided: false, intent: null, deferred: true };
        }
        if (guard.refusal.key && (await tx.computerJobToken.count({ where: { id: guard.refusal.key, jobId, revokedAt: null, expiresAt: { gt: now } } })) === 0) return { cutoffDecided: false, intent: null, deferred: true };
        return null;
      }
      if (cut) return { cutoffDecided: true, intent: null, deferred: false };
      // A finish intent that committed while this finish waited is the word that stands (a cutoff for our capacity stays above it): read under the lock that protects the ending, before anything is written
      if (guard.intentFirst || personStop) {
        const kept = await tx.computerFinishIntent.findUnique({ where: { jobId } });
        if (kept) return { cutoffDecided: false, intent: kept, deferred: false };
      }
      return null;
    };
    /**
     * An ending that was committed before this one is read under the cutoff lock: it governs. For the person's own Cancel or Stop that means the job ends as the runner's committed word said (a failure of ours is
     * given back), not as their stop: the ending is completed HERE, in their request, so what they see is the real one. For a runner's finish the intent's words are applied by `finishWith`, as before.
     */
    const deferToIntent = async (intent: NonNullable<EndReport['intent']>): Promise<void> => {
      report.intent = intent;
      if (!personStop) return;
      // The person's own Cancel or Stop is valid under ANY control: the ending is written without Brick's guard, so a job the person HOLDS (they took it over, or it was handed to
      // them) still ends here as the committed word says. With the guard it wrote nothing, the person's request answered "ok" and the job stayed theirs forever, with nothing left
      // to end it (a kept intent is never completed for a job under person control).
      // The intent's own time is its accounting (the wait for this is not the person's time); the next job in line starts now, unless this Stop is ending everything
      const done = await finishWith(jobId, saidByIntent(intent, intent.createdAt), { brick: false, startNextAt: now }, advance);
      report.ended = done.ended;
    };
    if (runnerJudged || hintJudged || orbitSeen || turnHold) {
      // The job's first turn was sent and never named: it may still run on the machine with nothing to cancel it by. The machine carries a hold from the
      // moment the job is over (one commit with the end), so no other job or turn starts beside that turn until the machine is proved asleep
      const botId = job.botId;
      const ref = { id: jobId, personId: job.personId, startedAt: job.startedAt };
      // Read before the transaction opens: a read of Limits that fails inside it would leave the transaction aborted
      const limits = runnerJudged || hintJudged ? await readGiveBackLimits() : null;
      const judging = runner;
      const result = await prisma.$transaction(async (tx) => {
        let verdict: Verdict | null = null;
        if (locked) {
          await lockCutoff(tx, jobId);
          const early = await decideUnderCutoff(tx);
          if (early) return { done: { count: 0 }, verdict, cutoffDecided: early.cutoffDecided, intent: early.intent, deferred: early.deferred };
        }
        if (judging && (runnerJudged || hintJudged)) {
          await lockPerson(tx, ref.personId);
          verdict = await decideRunnerFinish(tx, limits, ref, judging.turns, now, { run: judging.run ?? null, hint: judging.hint });
        }
        const given = !verdict || verdict.state === 'given';
        const counted = verdict?.state === 'given' && verdict.counted;
        // A given-back ending ends as ours (`error`), counted or not: for a hinted one it was not ended so by the runner, so it is said here
        const data = !given ? { ...endData, status: 'failed', endedBy: null } : { ...endData, ...(hintJudged ? { endedBy: 'error' as const } : {}), ...(counted ? { runnerFault: true } : {}) };
        const done = await tx.computerJob.updateMany({ where, data });
        if (done.count === 1) {
          if (turnHold) await tx.brickComputer.updateMany({ where: { botId, turnUnprovenSince: null }, data: { turnUnprovenSince: now } });
          if (verdict) await writeDecision(tx, ref, verdict, runner?.hint ?? 'ours', verdict.judgedTurns ?? runner?.turns ?? null, now, runner?.run ?? null);
          else if (orbitSeen) await writeOrbitDecision(tx, ref, endedBy === 'pool' ? 'pool_cut_off' : null);
        }
        return { done, verdict, cutoffDecided: false, intent: null, deferred: false };
      });
      if (result.deferred) {
        report.deferred = true;
        return;
      }
      if (result.intent) {
        await deferToIntent(result.intent);
        return;
      }
      if (result.cutoffDecided) {
        await endForPool();
        continue;
      }
      ended = result.done;
      // A hinted ending that was given back is ours from here on: its time and calls are given back below like any
      if (ended.count === 1 && hintJudged && result.verdict?.state === 'given') endedBy = 'error';
      if (ended.count === 1 && result.verdict && result.verdict.state !== 'given') {
        if (!hintJudged) console.warn('[Computer] A job that failed on our side is not given back (yet):', result.verdict.state, result.verdict.basis);
        // Limits that could not be read hold a give-back on no fault of the person's: it is told to Sentry so it can be made good by hand, and the sweep decides it again
        if (result.verdict.basis === 'limits_unreadable') Sentry.captureMessage('A computer give-back was held because the Limits could not be read', { level: 'error', tags: { area: 'computer', step: 'giveback_limits_unreadable' }, extra: { jobId } });
        status = 'failed';
        endedBy = null;
      }
    } else if (locked) {
      // The ending is written under the cutoff lock, with the decision read under it: a cutoff cannot commit between the two
      const written = await prisma.$transaction(async (tx) => {
        await lockCutoff(tx, jobId);
        const early = await decideUnderCutoff(tx);
        if (early) return early;
        return tx.computerJob.updateMany({ where, data: endData });
      });
      if ('deferred' in written && written.deferred) {
        report.deferred = true;
        return;
      }
      if ('cutoffDecided' in written) {
        if (written.intent) {
          await deferToIntent(written.intent);
          return;
        }
        await endForPool();
        continue;
      }
      ended = written;
    } else {
      ended = await prisma.computerJob.updateMany({ where, data: endData });
    }
  }
  // Someone else ended it between the read and the write: that one counts and settles
  if (!job || ended.count === 0) return;
  report.ended = true;
  const held = job.status === 'running' || job.status === 'waiting';
  // The job's computer holds no key from here on: a call it makes after this is refused
  await revokeJobTokens(jobId, now).catch((error) => console.error('[Computer] Could not revoke a job’s keys:', error instanceof Error ? error.message : 'unknown'));
  // A turn the agent was still running is cancelled, so it does not go on working (and spending) for a job that is over
  if (outside && held && job.agentResponseId) await cancelAgentTurn(job.botId, job.agentResponseId);
  // A job that was ever paused may have its sign-ins put away: they go with its ending, whatever the ending
  if (outside && job.pauses > 0) await dropProfile(job.botId, jobId, now).catch((error) => console.error('[Computer] Could not drop an ended job’s browser:', error instanceof Error ? error.message : 'unknown'));

  // A job that finished well hands over the files it made while its machine is still awake for it (the file card). The time that takes is the machine held for the
  // job, so it is counted with the job's; one that cannot be handed over is only named in the message. It never holds up the end of the job for long: it is limited by time.
  // The message about it waits for the ending to be closed below, so it never goes without its cards.
  if (outside && held && status === 'done') seconds += await handOverJobFiles(job, now);

  try {
    if (job.reservationKey) {
      if (held) {
        // What ran is written to the books first, and a write that fails is written again by the next sweep (same event id, so never twice)
        const cost = await recordComputerTime({ id: job.id, botId: job.botId, personId: job.personId, runId: job.runId, startedAt: job.startedAt, reservationKey: job.reservationKey }, seconds, now, { endedBy, status });
        await settleRoom({ key: job.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now);
      } else {
        await releaseRoom({ key: job.reservationKey }, now);
      }
    }
  } catch (error) {
    // The job is over either way: the machine still rests and the line still moves, and the sweep gives the room back
    console.error('[Computer] Could not settle a job’s room:', error instanceof Error ? error.message : 'unknown');
  }
  // A job that ended as a failure still waiting for its give-back to be decided may have been decided while its time was being written (the decision found no event to
  // detach): it is read again NOW, after the event exists, and a given-back job's time is written against nobody (the sweep does the same for one this does not reach)
  if (status === 'failed' && endedBy === null && job.startedAt) {
    const current = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, endedBy: true } }).catch(() => null);
    if (current && givenBackJob(current.status, current.endedBy)) await giveBackModelCalls(job.id, job.personId, now).catch((error) => console.error('[Computer] Could not give back a job’s time and model calls:', error instanceof Error ? error.message : 'unknown'));
  }
  // A job that failed on our side takes nothing from the person's month, and neither do the model calls it made, nor the credit they drew (the sweep tries again if this fails)
  if (givenBackJob(status, endedBy)) {
    await giveBackModelCalls(job.id, job.personId, now).catch((error) => console.error('[Computer] Could not give back a job’s model calls:', error instanceof Error ? error.message : 'unknown'));
  }

  // The list taken as THIS job ended is kept on the job, so a later job's list can never be read as this one's; none taken (another job still held the machine) says no files
  let endFiles: FilesList | null = null;
  if (held) {
    // Where the computer's browser went during the job is read before anything can clear it (the browser is cleared below once no job holds the machine)
    if (outside) await recordJobVisits(job, now);
    // The person's hold on the computer ends with their last job: control goes back to Brick's so the next job can start
    await releaseIfUnheld(job.botId).catch((error) => console.error('[Computer] Could not release control:', error instanceof Error ? error.message : 'unknown'));
    if (outside) {
      endFiles = await closeOutIfUnheld(job.botId);
      // A machine under a hold (a turn of this or an earlier job may still run on it) is put to sleep and proved, not only rested
      if (await underTurnHold(job.botId)) await settleTurnHold(job.botId);
      else await restIfUnheld(job.botId, now, job.id);
    }
  }
  // Everything this ending does is finished: only now may Brick tell the person how it went (its time is in the books, its files are listed)
  await prisma.computerJob.updateMany({ where: { id: jobId }, data: { endClosedAt: new Date(), ...(endFiles ? { endFiles: endFiles as unknown as Prisma.InputJsonValue } : {}) } }).catch((error) => console.error('[Computer] Could not mark an ending closed:', error instanceof Error ? error.message : 'unknown'));
  // The turn passes to the next job in line, except while a Stop is ending everything
  if (advance && endedBy !== 'off' && endedBy !== 'deleted') await startNext(job.botId, guard.startNextAt ?? now);
}

/**
 * The files a finished job made are moved off its machine for the person's chat (lib/computer-file-cards), while it is still awake for the job. It runs before
 * the job's ending is closed, and a "done" message is told only after that, so the cards are never missed. Returns the whole seconds it took, already added to
 * the job's time (the machine was held for them). Never throws: a machine that cannot be read only means no cards.
 */
async function handOverJobFiles(job: { id: string; botId: string; personId: string; title: string; writes: boolean }, now: Date): Promise<number> {
  // While it waits (and as it takes its turn) the job says so, so the machine is not rested and its ending is not told in a gap between two hand-overs
  const beat = () => prisma.computerJob.updateMany({ where: { id: job.id }, data: { handOverAliveAt: new Date() } }).then(() => undefined, () => undefined);
  try {
    // Only a job that writes makes files. Which files are its own is what is in its own output folder: a job running beside it has a folder of its own
    if (!job.writes) return 0;
    const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
    const provider = providerFor(row);
    if (!row?.providerRef || !provider || row.machine !== 'working') return 0;
    const limits = await getBrickLimits();
    // The machine is not put to rest while its files are read (the sweep rests a working machine nobody holds, and the job is already over)
    // Only when no other hand-over holds it (none, or one that is long past): two at once would let the first to finish let go of the machine under the other.
    // A job that began while another one's files were being read waits for that one to finish (a hand-over is limited by time) instead of giving its own
    // up: its ending would otherwise close with its files left behind, and nothing would hand them over later.
    let waitUntil = Date.now() + claimWaitMs;
    // The claim being waited for: another hand-over taking the machine after it was let go is progress, and the wait for it starts again (a claim that is never let go is
    // long past after FILES_CLAIM_MS and is taken over), so a job behind two others is not given up while they, one after the other, make their way through
    let waitingFor: number | null = null;
    let claimedAt = new Date();
    let beatAt = Date.now();
    await beat();
    for (;;) {
      if (Date.now() - beatAt >= HAND_OVER_BEAT_MS) {
        beatAt = Date.now();
        await beat();
      }
      claimedAt = new Date();
      const claim = await prisma.brickComputer.updateMany({
        where: { botId: job.botId, machine: 'working', providerRef: row.providerRef, OR: [{ filesClaimedAt: null }, { filesClaimedAt: { lt: new Date(claimedAt.getTime() - FILES_CLAIM_MS) } }] },
        data: { filesClaimedAt: claimedAt },
      });
      if (claim.count === 1) break;
      // Held by another hand-over: wait for it. Anything else (the machine is not working any more, or is another one) is not a wait.
      const now2 = await prisma.brickComputer.findUnique({ where: { botId: job.botId }, select: { machine: true, providerRef: true, filesClaimedAt: true } });
      if (!now2 || now2.machine !== 'working' || now2.providerRef !== row.providerRef) return 0;
      // Let go of between the two reads: try again at once
      if (!now2.filesClaimedAt) continue;
      if (waitingFor !== now2.filesClaimedAt.getTime()) {
        if (waitingFor !== null) waitUntil = Date.now() + claimWaitMs;
        waitingFor = now2.filesClaimedAt.getTime();
      }
      // The deadline is applied only after the claim was read: one taken just before it is progress (the wait starts again), not a reason to give up
      if (Date.now() >= waitUntil) return 0;
      await new Promise((resolve) => setTimeout(resolve, Math.min(CLAIM_POLL_MS, Math.max(1, waitUntil - Date.now()))));
    }
    try {
      return await handOver(job, now, row.providerRef, provider, limits);
    } finally {
      await prisma.brickComputer.updateMany({ where: { botId: job.botId, filesClaimedAt: claimedAt }, data: { filesClaimedAt: null } }).catch(() => undefined);
    }
  } catch (error) {
    console.error('[Computer] Could not hand over the files of a job:', error instanceof Error ? error.message : 'unknown');
    return 0;
  } finally {
    // Not waiting any more, whichever way it ended (its files handed over, given up, or nothing to hand over)
    await prisma.computerJob.updateMany({ where: { id: job.id, handOverAliveAt: { not: null } }, data: { handOverAliveAt: null } }).catch(() => undefined);
  }
}

async function handOver(job: { id: string; botId: string; personId: string; title: string }, now: Date, ref: string, provider: Provider, limits: Awaited<ReturnType<typeof getBrickLimits>>): Promise<number> {
  const bot = await prisma.bot.findUnique({ where: { id: job.botId }, select: { name: true } });
  const result = await handOverFiles({
    jobId: job.id,
    botId: job.botId,
    ownerId: job.personId,
    makerName: (bot?.name ?? 'Brick').slice(0, 100),
    jobTitle: job.title.slice(0, 200),
    ref,
    provider,
    limits: { count: limits.computerFiles, bytes: limits.computerFileMb * 1024 * 1024 },
  });
  // The machine was held for the job all the time it looked, whether or not a file came of it
  const seconds = Math.round(result.ms / SECOND);
  if (seconds > 0) await prisma.computerJob.updateMany({ where: { id: job.id }, data: { secondsRun: { increment: seconds } } });
  return seconds;
}

/**
 * Writes what a job ran into the meter's books as one event under the job's id; asked twice it is the same event. Returns the cost
 * it worked out (null when the provider has no price). The write never throws: a failure is logged and the sweep writes it again.
 */
async function recordComputerTime(job: { id: string; botId: string; personId: string; runId?: string | null; startedAt?: Date | null; reservationKey?: string | null }, seconds: number, at: Date, why: { endedBy: EndedBy | null; status: string }, /** A pause writes its own stretch under its own id (lib/computer-job-controls); the job's ending writes the stretch since it last started under the job's. */ eventId: string = `computer:${job.id}:time`): Promise<number | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  // The job is priced at what its lease was priced at as each stretch was taken (the rates the room was held by), never at the provider's rate at the moment it
  // closed: a price that changed while it ran must not make the books say something else than the room that was held for the same time. A lease with no
  // recorded terms (an older row) keeps the provider's rate.
  const lease = job.reservationKey ? await prisma.meterReservation.findUnique({ where: { reservationKey: job.reservationKey }, select: { terms: true } }) : null;
  const pinned = lease ? pinnedMicrosPerMinute(lease.terms, seconds, at.getTime()) : null;
  const cost = costOfSeconds(seconds, pinned ?? (provider ? provider.microsPerMinute() : null));
  // A job that failed on our side (the machine would not start or could not be reached, the agent's turn broke, the worker was lost) is not
  // the person's: what it ran stays in the books as our own cost (the provider still bills it), but is not written against them, so it
  // never draws from their month. A job that ran and ended any other way (done, stopped by them, out of room, nobody answered) is theirs.
  const givenBack = givenBackJob(why.status, why.endedBy);
  // Credit given on purpose (a gift for computers) is drawn first, before the event is written, so the allowance never counts what credit paid. Never for a job that failed on our side: it takes nothing from the person
  if (!givenBack && cost !== null && cost > 0) await drawComputerCredit({ eventId, personId: job.personId, botId: job.botId, jobId: job.id, costMicros: cost, chargeClass: 'computer_job' }, at);
  const timeEvent: MeterEventInput = {
    eventId,
    kind: 'computer_time',
    pool: 'computer',
    occurredAt: at,
    personKey: givenBack ? 'unknown' : `person:${job.personId}`,
    personId: givenBack ? null : job.personId,
    botId: job.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'computer',
    jobId: job.id,
    quantity: seconds,
    unit: 'second',
    costMicros: cost,
    // Our own count of the seconds a machine was held at the provider's per-minute price: an estimate until the provider's bill settles it
    basis: cost === null ? 'unknown' : provider && provider.kind === 'real' ? 'measured' : 'estimated',
    sourceRef: `computer_jobs:${job.id}`,
    // The run of a goal or task that started the job, when one did, so its computer time is on the books with its model calls
    // `startedMs`: when the job began, so a rule's cap counts a job that crossed midnight or the end of a month by the part that fell in its own
    // period, the same split the held room was counted by (lib/spend-rules.ts). Events without it (older ones) count whole in the period they end in.
    // `terms`: only for a job whose price changed while it ran, so that split follows the prices it ran at and not only its duration.
    detail: { endedBy: why.endedBy, status: why.status, ...(job.startedAt ? { startedMs: job.startedAt.getTime() } : {}), ...(priceChanges(lease?.terms) ? { terms: priceChanges(lease?.terms) as unknown as Prisma.InputJsonValue } : {}), ...(job.runId ? { runId: job.runId } : {}), ...(givenBack ? { givenBack: true, forPersonId: job.personId } : {}) },
  };
  // A paused stretch is counted in the person's month and the pool by its settled room until its event is in the books (`unbookedPauseMicros`, read apart from the event totals). The event is published under the pool's own
  // lock, the one every admission holds while it reads both, so an admission never sees the event totals from before it and the exclusion from after it (a stretch counted in neither; CodeRabbit on #1025)
  const publish = eventId === `computer:${job.id}:time` ? () => recordMeterEvent(timeEvent) : () => prisma.$transaction(async (tx) => {
        await lockPool(tx);
        return recordMeterEvent(timeEvent, tx);
      }, { timeout: 15_000, maxWait: 15_000 });
  await publish().catch((error) => console.error('[Computer] Could not record computer time:', error instanceof Error ? error.message : 'unknown'));
  return cost;
}

/** The next job in line for this Brick's computer gets its turn: the highest rank ("Do this next", a resume), then the oldest. A paused job is skipped. */
async function startNext(botId: string, now: Date): Promise<void> {
  const next = await prisma.computerJob.findFirst({ where: { botId, status: 'queued', ...NOT_PAUSED }, orderBy: [{ queueRank: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  if (next) await tryStart(next.id, now);
}

/** How long before a person's room lapses the sweep renews it: more than the bot server's sweep gap, so one sweep always lands inside it. */
const PERSON_RENEW_AHEAD_MS = 2 * 60 * 1000;

/** How many Bricks one page of the sweep looks at, and how many pages one sweep reads. */
const SWEEP_BATCH = 200;
const SWEEP_PAGES = 10;

/**
 * Jobs that ran and ended whose computer time never reached the books are written now, oldest first, however long ago they ended:
 * the ones missing are picked first and only then limited, so newer jobs never push an older one out. Safe to run twice.
 */
async function recordMissingComputerTime(now: Date, batch: number, botId?: string): Promise<void> {
  // A job that ended a moment ago may still be writing its own event, and its files may be waiting to be handed over (the longest that takes, with the wait for
  // another hand-over, is within HAND_OVER_LATEST_MS): the sweep leaves it that long and a minute. One Brick's, before its removal, does not wait.
  const cutoff = botId ? now : new Date(now.getTime() - 60 * 1000 - HAND_OVER_LATEST_MS);
  const only = botId ? Prisma.sql`AND j."bot_id" = ${botId}` : Prisma.empty;
  // A job whose files are being handed over is still adding the seconds that takes to its time: its event is written by that job, after, never by the sweep before
  const claimCutoff = new Date(now.getTime() - FILES_CLAIM_MS);
  // ...nor one that is waiting in line for its hand-over (it beats while it waits): the gap between two hand-overs on the machine is no reason to write its time
  const aliveCutoff = new Date(now.getTime() - HAND_OVER_ALIVE_MS);
  const ended = await prisma.$queryRaw<Array<{ id: string; botId: string; personId: string; runId: string | null; startedAt: Date | null; secondsRun: number; status: string; endedBy: string | null; endedAt: Date | null; reservationKey: string }>>(Prisma.sql`
    SELECT j."id", j."bot_id" AS "botId", j."person_id" AS "personId", j."run_id" AS "runId", j."started_at" AS "startedAt", j."seconds_run" AS "secondsRun", j."status", j."ended_by" AS "endedBy", j."ended_at" AS "endedAt", j."reservation_key" AS "reservationKey"
    FROM "computer_jobs" j
    WHERE j."reservation_key" IS NOT NULL AND j."started_at" IS NOT NULL AND j."status" IN ('done', 'stopped', 'failed') AND j."seconds_run" > 0 AND j."ended_at" <= ${cutoff} ${only}
      AND NOT EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:' || j."id" || ':time')
      AND NOT EXISTS (SELECT 1 FROM "brick_computers" c WHERE c."bot_id" = j."bot_id" AND c."files_claimed_at" > ${claimCutoff})
      AND (j."hand_over_alive_at" IS NULL OR j."hand_over_alive_at" <= ${aliveCutoff})
    ORDER BY j."ended_at" ASC
    LIMIT ${batch}`);
  for (const job of ended) {
    const cost = await recordComputerTime(job, job.secondsRun, job.endedAt ?? now, { endedBy: job.endedBy as EndedBy | null, status: job.status });
    // Its room is closed at what it ran too, when the end that wrote the time did not get to (a room already closed stays as it closed): so the time is in the
    // books and the room is settled, never one of them only
    await settleRoom({ key: job.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now).catch((error) => console.error('[Computer] Could not settle a job’s room:', error instanceof Error ? error.message : 'unknown'));
  }
  await giveBackMissingModelCalls(batch, botId, now);
}

/**
 * A job that failed on our side has its model calls, and the credit it drew, given back when it ends. If that write did not go through, or a call was recorded
 * in the same moment, the next sweep finds the call still written against the person (or credit the job still holds drawn) and gives it back too. Never throws.
 */
async function giveBackMissingModelCalls(batch: number, botId: string | undefined, now: Date): Promise<void> {
  const only = botId ? Prisma.sql`AND j."bot_id" = ${botId}` : Prisma.empty;
  // A job whose give-back keeps failing for a reason of its own still matches on every sweep, so neither "oldest first" nor "oldest and newest" can be the whole rule: jobs that keep failing would take the same
  // places on every sweep for ever and keep the others out. Half the batch is the newest of the jobs that match (a job that has just failed is looked at at once), and the other half is a window that moves:
  // the jobs that match, in id order, from just after the one the last sweep ended on, and from the start again when they run out. Every job that matches is therefore tried once in every lap of ceil(matching / half) sweeps,
  // whatever happens to the others. The place the window stands is kept in the settings (no column of its own), and only a sweep of every Brick moves it (one Brick's clean-up before its removal reads the window and leaves it)
  const half = Math.max(1, Math.ceil(batch / 2));
  try {
    // One Brick's own look (before its removal) takes its jobs from the start, as many as a batch, and leaves the place alone
    const after = botId ? '' : ((await giveBackCursorRead()) ?? '');
    const take = botId ? batch : half;
    const jobs = await prisma.$queryRaw<Array<{ id: string; personId: string; ord: number }>>(Prisma.sql`
      WITH matching AS (
        SELECT j."id", j."person_id" AS "personId", j."ended_at" AS "endedAt"
        FROM "computer_jobs" j
        WHERE (j."status" IN ('failed', 'stopped') AND j."ended_by" IN ('error', 'pool')) ${only}
          AND (
            EXISTS (SELECT 1 FROM "meter_events" e WHERE e."source_ref" = 'computer_jobs:' || j."id" AND e."job_id" = j."id" AND e."kind" = 'model_call' AND e."pool" = 'computer' AND e."payer_kind" = 'universe' AND e."person_key" = 'person:' || j."person_id" AND ${CALL_IN_LAST_STRETCH})
            -- ...or the job's own time, written against the person by an end that overlapped the decision that gave the job back (the decision found no event to detach)
            OR EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:' || j."id" || ':time' AND e."person_key" = 'person:' || j."person_id")
            -- ...or credit the job drew that has not gone back and has no refund obligation yet (an obligation, once written, is asked again by its own sweep with a
            -- growing wait: lib/computer-refunds)
            OR EXISTS (SELECT 1 FROM "credit_holds" h WHERE h."job_key" = j."id" AND h."category" = 'computers' AND h."state" = 'settled' AND COALESCE(h."customer_micros", 0) > h."refunded_micros" AND ${HOLD_IN_LAST_STRETCH}
              AND NOT EXISTS (SELECT 1 FROM "computer_refund_obligations" o WHERE o."hold_key" = h."hold_key"))
          )
      ),
      newest AS (SELECT "id", "personId", 0 AS "ord" FROM matching ORDER BY "endedAt" DESC NULLS LAST, "id" LIMIT ${half}),
      ahead AS (SELECT "id", "personId", 1 AS "ord" FROM matching WHERE "id" > ${after} ORDER BY "id" LIMIT ${take}),
      wrapped AS (SELECT "id", "personId", 2 AS "ord" FROM matching WHERE "id" <= ${after} ORDER BY "id" LIMIT GREATEST(${take} - (SELECT COUNT(*) FROM ahead), 0))
      SELECT "id", "personId", "ord"::int AS "ord" FROM newest
      UNION ALL SELECT "id", "personId", "ord"::int FROM ahead
      UNION ALL SELECT "id", "personId", "ord"::int FROM wrapped
      ORDER BY "ord", "id"`);
    // One job's trouble never skips the rest of the batch: it is said, and it stays eligible for the next sweep
    const tried = new Set<string>();
    for (const job of jobs) {
      if (tried.has(job.id)) continue;
      tried.add(job.id);
      try {
        await giveBackModelCalls(job.id, job.personId, now);
      } catch (error) {
        console.error('[Computer] Could not give back a failed job’s model calls:', error instanceof Error ? error.message : 'unknown');
      }
    }
    // The window stands on the last job it took (from the start, when it wrapped); with none to take it goes back to the start
    if (!botId) {
      const stood = jobs.filter((job) => job.ord > 0);
      const wrappedTo = stood.filter((job) => job.ord === 2);
      const last = stood.length === 0 ? '' : wrappedTo.length > 0 ? wrappedTo[wrappedTo.length - 1].id : stood[stood.length - 1].id;
      await giveBackCursorWrite(last);
    }
  } catch (error) {
    console.error('[Computer] Could not look for a failed job’s model calls:', error instanceof Error ? error.message : 'unknown');
  }
}

/** Where the window of the give-back look stands (the id it ended on), or null at the start. */
const GIVE_BACK_CURSOR_KEY = 'computer_giveback_sweep_cursor';
async function giveBackCursorRead(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: GIVE_BACK_CURSOR_KEY } });
  const value = row?.value as { after?: unknown } | null | undefined;
  return typeof value?.after === 'string' && value.after !== '' ? value.after : null;
}
async function giveBackCursorWrite(after: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key: GIVE_BACK_CURSOR_KEY }, create: { key: GIVE_BACK_CURSOR_KEY, value: { after } }, update: { value: { after } } });
}

/**
 * A sweep, asked by the bot server now and then: a running job that stopped renewing its room is stopped safely (its room is
 * settled to what ran, never left holding the envelope), room that nobody holds a job for is given back, and jobs in line are tried
 * again (the person's month turned, extra usage was given, another job ended). Safe to run twice at once.
 */
export async function sweepComputers(now: Date = new Date(), batch: number = SWEEP_BATCH, pages: number = SWEEP_PAGES, reconcileWaitMs: number = RECONCILE_WAIT_MS): Promise<{ stopped: number; released: number; started: number }> {
  let stopped = 0;
  let released = 0;
  let started = 0;
  // What the provider keeps up between jobs (the real one builds its image, a step at a time); a failure here never stops the sweep
  await getComputerProvider()?.maintain().catch((error) => console.error('[Computer] The provider could not be kept up:', error instanceof Error ? error.message : 'unknown'));
  // Give-backs that could not be decided yet (Limits, or an outside effect still to be confirmed) are decided again, and an old one is told to Sentry
  await sweepGiveBackDecisions(now).catch((error) => console.error('[Computer] The give-back decisions could not be decided again:', error instanceof Error ? error.message : 'unknown'));
  // Evidence that was stored while a decision was being made is looked at again for every decision it is newer than (the route that stores it does not have to succeed at that)
  await sweepLateEvidence(now).catch((error) => console.error('[Computer] Late evidence could not be looked at again:', error instanceof Error ? error.message : 'unknown'));
  // Refunds of credit a failed job drew are owed until the books acknowledge them: asked again with a growing wait, and an old one is told to Sentry
  await sweepRefundObligations(now).catch((error) => console.error('[Computer] The refund obligations could not be asked again:', error instanceof Error ? error.message : 'unknown'));
  // The marks of starts whose process died are deleted (they stopped counting long before)
  await forgetOldStartMarks(now).catch((error) => console.error('[Computer] Old marks of starts could not be deleted:', error instanceof Error ? error.message : 'unknown'));
  // A wind-down that is on goes on until every job is over and every machine is stopped and proven so
  await continueWindDown(now, batch).catch((error) => console.error('[Computer] The wind-down could not go on:', error instanceof Error ? error.message : 'unknown'));
  // A job that asked its person to take over and got no answer within the wait a super admin set ends, so it does not hold the
  // machine and the allowance for nobody. Read each sweep, so a changed setting counts at once, jobs already waiting included. Once the
  // person has taken over the job is theirs and is not ended here.
  // A job whose runner committed to ending it and never sent the finish (it died, or its replacement never ran) is finished first, with what it said, so it is never ended below as one nobody answered
  stopped += await completeFinishIntents(now, batch).catch((error) => {
    console.error('[Computer] Finish intents could not be completed:', error instanceof Error ? error.message : 'unknown');
    return 0;
  });
  const { computerWait } = await getBrickLimits();
  // A job whose runner committed to ending it is not one that went quiet: it is left to `completeFinishIntents` (which ends it as the runner said, after its grace), never ended here as unanswered
  const unansweredBefore = new Date(now.getTime() - computerWait * 60 * 1000);
  const unanswered = await prisma.computerJob.findMany({ where: { status: 'waiting', control: 'brick', finishIntent: { is: null }, stretchStarted: { lte: unansweredBefore } }, select: { id: true, status: true, control: true, controlGeneration: true, ownerEpoch: true, leaseVersion: true, handoverSeq: true }, orderBy: { stretchStarted: 'asc' }, take: batch });
  for (const job of unanswered) {
    // A job Orbit already decided to end for its own capacity (its keys ended, whatever the request that decided it did after) is ended as THAT, ours, before the wait for its person is read against it: it is not one that
    // went quiet, and a cutoff still in its grace period is not left for this pass to end as the person's. A job whose cutoff could not end it is ended by the pass below
    const cutoff = await endIfCutoffDecided(job.id, now).catch(() => ({ decided: true, ended: false }));
    if (cutoff.decided) {
      if (cutoff.ended) stopped++;
      continue;
    }
    // Ended only as the job was selected (every value it was selected on is read again under its lock) and while the wait is still past its limit: an owner that took control meanwhile, or a worker that renewed, leaves it alone
    const report: EndReport = {};
    await endJob(job.id, 'stopped', 'unanswered', now, true, undefined, true, null, false, { refusal: {}, observed: { ...job, unansweredBefore } }, report);
    if (report.ended) stopped++;
  }
  // A job whose cutoff for our own capacity was decided (its keys ended) but that could not be ended then keeps its lease and room through the service token: it is ended here, as ours
  stopped += await endStuckCutoffs(now, batch).catch((error) => {
    console.error('[Computer] Jobs whose cutoff was decided could not be ended:', error instanceof Error ? error.message : 'unknown');
    return 0;
  });
  // A job waiting for its person (it asked them to take over, or they did) is not one that went quiet: the worker renews nothing
  // while it waits, so the sweep renews the room for them, a little before it would lapse. If the allowance cannot give more, the job still stops safely.
  const soon = await prisma.meterReservation.findMany({
    where: { state: 'held', expiresAt: { gt: now, lte: new Date(now.getTime() + PERSON_RENEW_AHEAD_MS) }, jobId: { not: null }, reservationKey: { startsWith: 'computer:job:' } },
    take: 200,
  });
  for (const reservation of soon) {
    const job = reservation.jobId ? await prisma.computerJob.findUnique({ where: { id: reservation.jobId } }) : null;
    if (job && job.status === 'waiting' && job.reservationKey === reservation.reservationKey) await renewJob(job.id, now, { epoch: job.ownerEpoch });
  }
  const lapsed = await prisma.meterReservation.findMany({ where: { state: 'held', expiresAt: { lte: now }, jobId: { not: null }, reservationKey: { startsWith: 'computer:job:' } }, take: 200 });
  for (const reservation of lapsed) {
    const job = reservation.jobId ? await prisma.computerJob.findUnique({ where: { id: reservation.jobId } }) : null;
    // Only the job's CURRENT room may end it: a try that reserved room and stopped before its claim leaves a room that lapses later, after the job was claimed under a new key (a resumed job, a second try).
    // That old room ends nothing; it is released below with nothing charged (CodeRabbit N18 on #1025, Opus's ruling 23 Nov)
    if (job && !isOver(job.status) && HOLDS_MACHINE.includes(job.status as never) && job.reservationKey === reservation.reservationKey) {
      // A runner that committed to ending this job (its intent) has the last word: the lease running out does not replace it. It is ended as the intent said (while Brick has the job: a take-over that wins keeps the
      // old ending below, as a lease that ran out always had), and a job with no intent is ended as before
      const kept = await prisma.computerFinishIntent.findUnique({ where: { jobId: job.id } });
      if (kept && job.control === 'brick') {
        if (await completeIntent(kept, kept.createdAt, now).catch(() => false)) stopped++;
        continue;
      }
      // Ended only as it was selected: the reservation must still be held and expired as it was seen, and the job must not have moved (a renewal, a claim, an answer, a take-over, a hand-over leave it to the next pass)
      const report: EndReport = {};
      await endJob(job.id, 'stopped', 'error', now, true, undefined, true, null, false, { refusal: {}, reservation: reservation.reservationKey, observed: { status: job.status, control: job.control, controlGeneration: job.controlGeneration, ownerEpoch: job.ownerEpoch, leaseVersion: job.leaseVersion, handoverSeq: job.handoverSeq, lease: { key: reservation.reservationKey, expiresAt: reservation.expiresAt } } }, report);
      if (report.ended) stopped++;
    } else if (job && isOver(job.status) && job.startedAt && job.reservationKey === reservation.reservationKey) {
      // A job that ran and ended, whose room was left held (its settlement did not get through): the room is settled at what it ran, never given back, so the
      // time it took is never lost between the room and the books (the sweep writes its time below). A job that ended at 0 seconds comes here too: its end marked
      // a hand-over to come whatever the seconds, and that hand-over adds seconds, so its room is decided on the fresh seconds below (none: given back, as ever)
      const lease = await prisma.meterReservation.findUnique({ where: { reservationKey: reservation.reservationKey }, select: { terms: true } });
      // ...but not while its files are still being handed over: that hand-over adds its seconds to the job's time and settles the room itself afterwards
      // (a room settled here first at the shorter time would stay, close() keeps the first settlement). The same two conditions recordMissingComputerTime waits
      // by: the machine's files are claimed, or this job is waiting in line for its hand-over and beating. Once the claim or the beat is stale the hand-over is
      // abandoned and the room is settled at what the job ran, on this or a later sweep.
      // THE ORDER MATTERS: the claim is read first and the job (its seconds and its beat) after. A hand-over adds its seconds while it holds the claim and lets go of the claim and
      // the beat after, so "both gone" read in this order always comes with the final seconds; read the other way round, a hand-over that finished between the two reads
      // would be settled at the seconds from before it
      const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
      const fresh = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { secondsRun: true, endedAt: true, handOverAliveAt: true } });
      if (!fresh) continue;
      if ((row?.filesClaimedAt && row.filesClaimedAt.getTime() > now.getTime() - FILES_CLAIM_MS) || (fresh.handOverAliveAt && fresh.handOverAliveAt.getTime() > now.getTime() - HAND_OVER_ALIVE_MS)) continue;
      // Both stale: nothing is handing files over, so the seconds just read are the job's last. None: the room is given back, as for any job that ran no time
      if (fresh.secondsRun <= 0) {
        await releaseRoom({ key: reservation.reservationKey }, now);
        released++;
        continue;
      }
      const provider = providerFor(row);
      const pinned = pinnedMicrosPerMinute(lease?.terms, fresh.secondsRun, (fresh.endedAt ?? now).getTime());
      const cost = costOfSeconds(fresh.secondsRun, pinned ?? (provider ? provider.microsPerMinute() : null));
      await settleRoom({ key: reservation.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now);
      released++;
    } else {
      await releaseRoom({ key: reservation.reservationKey }, now);
      released++;
    }
  }
  // Room held for a disk whose making was cut off (the server stopped between taking it and giving it back): nobody is making that machine now, so
  // the room is given back instead of staying in the pool's envelope until the month ends
  const lapsedDisks = await prisma.meterReservation.findMany({ where: { state: 'held', expiresAt: { lte: now }, reservationKey: { startsWith: DISK_ROOM_PREFIX } }, take: 200 });
  for (const reservation of lapsedDisks) {
    // The room lasts a few minutes and is not renewed while the machine is being made: a machine that takes longer is still being made, and its
    // room is kept while its job is still starting (the key says which job), up to a hard stop so a job that died in the making never keeps it for good
    const [botId, jobId] = reservation.reservationKey.slice(DISK_ROOM_PREFIX.length).split(':');
    const computer = await prisma.brickComputer.findUnique({ where: { botId }, select: { provider: true, providerRef: true } });
    if (computer?.providerRef) {
      // The machine exists, so its disk must be in the books before the room held for it goes (a start whose books write failed leaves it for here).
      // A write that fails again keeps the room, and the next sweep tries again
      if (!(await recordKeptBytes({ botId, reason: 'made', machineBytes: providerFor(computer)?.diskBytes?.() ?? null, now }))) continue;
    } else {
      const job = jobId ? await prisma.computerJob.findFirst({ where: { id: jobId, botId }, select: { status: true } }) : null;
      if (job && !isOver(job.status) && now.getTime() - reservation.createdAt.getTime() < DISK_ROOM_MAX_HOLD_MS) continue;
    }
    await releaseRoom({ key: reservation.reservationKey }, now);
    released++;
  }
  // Room held for a model call that never reported back (the bot server stopped, the call was lost): what it cost is not known, so it
  // is written as unknown and settled at the room held, never at 0
  const lapsedCalls = await prisma.meterReservation.findMany({ where: { state: 'held', expiresAt: { lte: now }, jobId: { not: null }, reservationKey: { startsWith: 'computer:call:' } }, take: 200 });
  for (const reservation of lapsedCalls) {
    const callId = reservation.jobId && reservation.reservationKey.startsWith(callRoomKey(reservation.jobId, '')) ? reservation.reservationKey.slice(callRoomKey(reservation.jobId, '').length) : null;
    // A room whose call was never admitted (its refusal could not give the room back) is released, not written as usage the person is charged for: only an admitted call that never reported is unknown usage
    if (reservation.jobId && callId) {
      const look = await releaseUnadmittedCallRoom(reservation.jobId, callId, reservation.reservationKey, now);
      // A look that failed leaves the room for the next sweep: an unread call is neither released nor booked as usage
      if (look === 'unknown') continue;
      if (look === 'released') {
        released++;
        continue;
      }
    }
    const settled =
      reservation.jobId && callId
        ? await settleModelCall(reservation.jobId, callId, { costMicros: null, basis: 'unknown', payer: { kind: 'universe' }, route: 'universe-ai', cutShort: true }, now).catch(() => 'failed' as const)
        : null;
    // A write that failed is left for the next sweep. The job gone (or a key that is not one of ours) means there is no one to write the cost to,
    // so the room is given back instead of staying held and being found by every sweep
    if (settled === 'failed') continue;
    if (!settled?.ok) await releaseRoom({ key: reservation.reservationKey }, now);
    released++;
  }
  // A machine that was being made when its job died, and never got a reference: nothing was made, so it can be tried again
  await prisma.brickComputer.updateMany({ where: { machine: 'waking', providerRef: null, updatedAt: { lte: new Date(now.getTime() - 5 * 60 * 1000) } }, data: { machine: 'none' } });
  // A change of hands a leader left half done (its lease ran out) is finished, and a computer still held after the person's jobs ended goes back to Brick's
  await recoverControl(now, batch).catch((error) => console.error('[Computer] Control could not be recovered:', error instanceof Error ? error.message : 'unknown'));
  // A machine that works while no job holds it (a stop that broke half way, a start that finished after a turn off) is put to rest
  // A rest that was claimed and never finished (the server stopped half way) is not left claimed: with no job holding it, it goes back to "working" and the next sweep rests it
  const stuck = await prisma.brickComputer.findMany({ where: { machine: 'resting', NOT: { providerRef: null }, restClaimedAt: { lte: new Date(now.getTime() - 5 * 60 * 1000) } }, select: { botId: true, restClaimedAt: true }, take: 200 });
  for (const machine of stuck) {
    if ((await prisma.computerJob.count({ where: { botId: machine.botId, status: { in: ['running', 'waiting'] } } })) === 0) {
      // Only the claim that was seen to be stale: a rest that finished since, or a newer claim, is left as it is
      await prisma.brickComputer.updateMany({ where: { botId: machine.botId, machine: 'resting', restClaimedAt: machine.restClaimedAt }, data: { machine: 'working', restClaimedAt: null } });
    }
  }
  // A machine that was to be put to sleep and is not proved asleep is stopped again until it is
  const stopping = await prisma.brickComputer.findMany({ where: { machine: 'stopping', NOT: { providerRef: null } }, select: { botId: true, providerRef: true, provider: true }, take: 200 });
  for (const machine of stopping) {
    const provider = providerFor(machine);
    if (provider && machine.providerRef) await stopMachine(machine.botId, machine.providerRef, provider, ['stopping']);
  }
  // A machine that may still run the turn of a job that ended is put to sleep and proved, and only then do the jobs behind it start
  const turnHolds = await prisma.brickComputer.findMany({ where: { NOT: { turnUnprovenSince: null } }, select: { botId: true }, take: 200 });
  for (const machine of turnHolds) await settleTurnHold(machine.botId);
  const idle = await prisma.brickComputer.findMany({ where: { machine: 'working', NOT: { providerRef: null }, updatedAt: { lte: new Date(now.getTime() - 2 * 60 * 1000) } }, select: { botId: true }, take: 200 });
  for (const machine of idle) await restIfUnheld(machine.botId, now);
  // A machine a job holds is kept awake while it works
  await keepWorkingMachinesAwake(now, batch).catch((error) => console.error('[Computer] Keep-awake failed:', error instanceof Error ? error.message : 'unknown'));
  // What a job ran whose write to the books failed is written again (same event id, so never twice), and the same for a pause's time
  await recordMissingComputerTime(now, batch);
  await (await import('@/lib/computer-job-controls')).bookMissingPauses(now, batch);
  // A park nobody finished (the server stopped between a pause and putting its sign-ins away) is finished here, BEFORE anything starts below: while it is unfinished the machine carries that job's id and every other
  // job on it stays queued, so finishing it is what lets the line move. A job that carried on whose browser could not be settled is tried again, and wiped once its sign-ins are past the hours they are kept (GPT round 6, finding 7)
  await finishPendingParks(now, batch).catch((error) => console.error('[Computer] A park left unfinished could not be finished:', error instanceof Error ? error.message : 'unknown'));
  await recoverResumedBrowsers(now, batch).catch((error) => console.error('[Computer] The browser of a job that carried on could not be settled:', error instanceof Error ? error.message : 'unknown'));
  // Jobs the person's month or a limit paused carry on by themselves once more arrived (one per person per sweep, oldest first), or Brick asks first when something about them changed (piece 3)
  started += await (await import('@/lib/computer-limit-pause')).carryOnPaused(now, batch);
  // One try per Brick: the oldest job in line has the turn. Bricks tried and blocked are skipped by the next page, so a long run of
  // blocked Bricks never keeps the ones behind them from their turn.
  const tried: string[] = [];
  for (let page = 0; page < pages; page++) {
    // The oldest job of each Brick has its turn, and the Brick tried longest ago goes first: one that stays blocked is marked tried
    // and goes behind the others, so across sweeps every Brick in line gets its try however many are stuck in front
    const lines = await prisma.$queryRaw<Array<{ id: string; botId: string }>>(Prisma.sql`
      SELECT "id", "bot_id" AS "botId" FROM (
        SELECT DISTINCT ON ("bot_id") "id", "bot_id", "created_at", "last_tried_at"
        FROM "computer_jobs" WHERE "status" = 'queued' AND "queued_for" IS DISTINCT FROM 'paused'
        ORDER BY "bot_id", "queue_rank" DESC, "created_at" ASC, "id" ASC
      ) AS oldest
      WHERE "bot_id" <> ALL(${tried}::text[])
      ORDER BY "last_tried_at" ASC NULLS FIRST, "created_at" ASC
      LIMIT ${batch}`);
    if (lines.length === 0) break;
    for (const line of lines) {
      tried.push(line.botId);
      await prisma.computerJob.updateMany({ where: { id: line.id, status: 'queued' }, data: { lastTriedAt: now } });
      if ((await tryStart(line.id, now)) === 'running') started++;
    }
    if (lines.length < batch) break;
  }
  // Cold storage: idle computers are packed away, restores are proved, and a pack-away or return that stopped half way is finished or put back. It
  // talks to the provider for minutes, so the sweep waits a short while at most and it goes on by itself (one step at a time per server)
  await settleWithin(COLD_WAIT_MS, coldStep(getComputerProvider(), now, await isWindingDown())).catch((error) => console.error('[Computer] Cold storage could not go on:', error instanceof Error ? error.message : 'unknown'));
  // Last, because it talks to the provider and what is above cannot wait for that: once a day, our books against the provider's bill for the
  // day before (it only reads and reports; a bill that cannot be read is tried again later). The sweep waits for it a short while at most.
  await settleWithin(reconcileWaitMs, reconcileComputers(now)).catch((error) => console.error('[Computer] The daily check of the books could not be made:', error instanceof Error ? error.message : 'unknown'));
  return { stopped, released, started };
}

/** How long a sweep waits for the daily check of the books before it goes on without it (the check goes on by itself). */
export const RECONCILE_WAIT_MS = 30_000;
/** How long a sweep waits for the cold storage step before it goes on without it. */
export const COLD_WAIT_MS = 15_000;

/** The work's own answer, or nothing once the wait is over: the work is not stopped, and an error it ends in is still read. */
async function settleWithin<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- Wind-down (the team's command, never a setting) ----------

const WIND_DOWN_KEY = 'computer-wind-down';
/** The machines that are billed or on their way up: a wind-down is not done while one is left. A resting one sleeps and costs nothing. */
const BILLED_MACHINES = ['waking', 'working', 'restoring', 'stopping'];

export interface WindDownStatus {
  on: boolean;
  since: string | null;
  by: string | null;
  /** Work left to wind down: jobs not over, and machines still awake. Zero means it is finished. */
  jobsLeft: number;
  machinesLeft: number;
}

async function windDownFlag(): Promise<{ on: boolean; since: string | null; by: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: WIND_DOWN_KEY } });
  const value = (row?.value && typeof row.value === 'object' ? row.value : {}) as { on?: unknown; since?: unknown; by?: unknown };
  return { on: value.on === true, since: typeof value.since === 'string' ? value.since : null, by: typeof value.by === 'string' ? value.by : null };
}

/** True while the team's wind-down is on: no computer takes new work, and none is given. */
export async function isWindingDown(): Promise<boolean> {
  return (await windDownFlag()).on;
}

/**
 * Starts the wind-down (super admins only, asked by the route): the door closes first, so nothing new starts, then the work is ended
 * a few Bricks at a time by this call and by every sweep after it until none is left. Files and the page's state stay; only the
 * work and the machines stop. Asked twice it is the same.
 */
export async function startWindDown(by: string, now: Date = new Date()): Promise<WindDownStatus> {
  const flag = await windDownFlag();
  if (!flag.on) {
    const value = { on: true, since: now.toISOString(), by } as unknown as Prisma.InputJsonValue;
    await prisma.appSetting.upsert({ where: { key: WIND_DOWN_KEY }, create: { key: WIND_DOWN_KEY, value }, update: { value } });
    console.warn('[Computer] A wind-down was started by', by);
  }
  await continueWindDown(now, SWEEP_BATCH).catch((error) => console.error('[Computer] The wind-down could not go on:', error instanceof Error ? error.message : 'unknown'));
  return windDownStatus();
}

/** Lifts the wind-down: computers take work again. Machines stay as they are (stopped ones wake at the next job). */
export async function liftWindDown(by: string): Promise<WindDownStatus> {
  const value = { on: false, since: null, by } as unknown as Prisma.InputJsonValue;
  await prisma.appSetting.upsert({ where: { key: WIND_DOWN_KEY }, create: { key: WIND_DOWN_KEY, value }, update: { value } });
  console.warn('[Computer] The wind-down was lifted by', by);
  return windDownStatus();
}

export async function windDownStatus(): Promise<WindDownStatus> {
  const flag = await windDownFlag();
  const [jobsLeft, machinesLeft] = await Promise.all([
    prisma.computerJob.count({ where: { status: { in: ['queued', 'running', 'waiting'] } } }),
    prisma.brickComputer.count({ where: { machine: { in: BILLED_MACHINES }, NOT: { providerRef: null } } }),
  ]);
  return { ...flag, jobsLeft, machinesLeft };
}

/**
 * One step of the wind-down, safe to run twice at once and to repeat: every Brick with a job not over or a machine awake has its
 * jobs ended (keys revoked, turns cancelled, time counted), its files saved, and its machine stopped. A machine counts as stopped
 * only once the provider says it is not running; one that is not proven stays "working" and is tried again by the next sweep.
 * Does nothing when no wind-down is on.
 */
export async function continueWindDown(now: Date = new Date(), batch: number = SWEEP_BATCH): Promise<{ bricks: number; left: number }> {
  if (!(await isWindingDown())) return { bricks: 0, left: 0 };
  const withJobs = await prisma.computerJob.findMany({ where: { status: { in: ['queued', 'running', 'waiting'] } }, distinct: ['botId'], select: { botId: true }, orderBy: { createdAt: 'asc' }, take: batch });
  // A Brick whose return from cold storage holds the claim is left to that return: it is making or filling the machine, and a stop under it would strand the
  // row as stopped while the return still writes to it. The return ends one way or the other (awake, which the next sweep stops, or cold again).
  const withMachines = await prisma.brickComputer.findMany({ where: { machine: { in: BILLED_MACHINES }, NOT: [{ providerRef: null }, { machine: 'restoring', packStage: 'returning' }] }, select: { botId: true }, orderBy: { updatedAt: 'asc' }, take: batch });
  const bricks = Array.from(new Set([...withJobs, ...withMachines].map((entry) => entry.botId))).slice(0, batch);
  for (const botId of bricks) await windDownBrick(botId, now);
  const status = await windDownStatus();
  return { bricks: bricks.length, left: status.jobsLeft + status.machinesLeft };
}

async function windDownBrick(botId: string, now: Date): Promise<void> {
  try {
    const before = await prisma.brickComputer.findUnique({ where: { botId } });
    const wasBilled = !!before && BILLED_MACHINES.includes(before.machine);
    const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['queued', 'running', 'waiting'] } }, select: { id: true } });
    // No job of this Brick starts in its place while it is ended (the line does not advance)
    for (const job of jobs) await endJob(job.id, 'stopped', 'off', now, false);
    const row = await prisma.brickComputer.findUnique({ where: { botId } });
    const provider = providerFor(row);
    // Only a machine that was awake when this began: ending the jobs may have put it to rest, and a rest is checked too
    if (!row?.providerRef || !provider || !(wasBilled || BILLED_MACHINES.includes(row.machine))) return;
    // Not under a return that holds the Brick (see continueWindDown): neither its files are saved nor its machine stopped until the return is over
    if (row.machine === 'restoring' && row.packStage === 'returning') return;
    const ref = row.providerRef;
    if (await provider.awake(ref)) await saveCopy(botId, ref, provider);
    // Proven: the provider no longer says it runs. A stop that did not take (or a look that could not be made) leaves the machine "stopping",
    // which the next sweep finds again, whatever state ending its jobs had left it in
    await stopMachine(botId, ref, provider, [...BILLED_MACHINES, 'resting']);
  } catch (error) {
    console.error('[Computer] A Brick could not be wound down yet:', error instanceof Error ? error.message : 'unknown');
  }
}

// ---------- Watching, taking over and handing back ----------

/**
 * The job needs its person: before it sends their details, signs in, uploads, pays or submits. It waits, holding the machine for
 * them, and the person's Take over appears. Asked by the bot server.
 */
export async function requestHandoverAs(
  jobId: string,
  waitingFor: WaitingFor,
  now: Date = new Date(),
  ready?: { what: string; where: string } | null,
  /** Who asks: the epoch the worker owns the job by, the control generation it acts under and the turn it was on (`responseId`: when named, the write lands only while that is the job's turn). Left out, as a worker that knows none (only for a job nobody claimed). */
  owner: { epoch?: EpochSaid; generation?: number | null; responseId?: string | null } = {},
): Promise<{ job: JobView | null; /** `superseded`: another worker owns the job; `stale`: the control generation moved; `not_current`: the turn named is not the job's. Nothing was written. */ refused: 'superseded' | 'stale' | 'not_current' | null }> {
  const readyData = waitingFor === 'details' && ready ? { readyWhat: cleanDetail(ready.what) || null, readyWhere: cleanDetail(ready.where) || null } : { readyWhat: null, readyWhere: null };
  // The write that lands the wait names everything the worker says it acts under: the owner, the control generation, the turn, and no ending decided (the finalizer owns the ending then)
  const acts = {
    ...ownerWhere(owner.epoch),
    ...(owner.generation !== undefined && owner.generation !== null ? { controlGeneration: owner.generation } : {}),
    ...(typeof owner.responseId === 'string' ? { agentResponseId: owner.responseId } : {}),
    ...noEndingWhere,
  };
  // The job's row is locked FIRST and everything is read and written under that lock: a finish intent that was kept while this waited for the row is seen by the write (it refuses), and the stretch read here is the
  // stored one. The write names the very `secondsRun` and `stretchStarted` it read, so a delayed handover can never land over a newer one (a second asking, a note that put the job back to running) or count seconds twice
  const found = await prisma.$transaction(async (tx) => {
    if (!(await lockJobRow(tx, jobId))) return null;
    const job = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId } });
    let landed = 0;
    if (job.status === 'running') {
      // The stretch so far is counted, and the machine stays awake for them
      const stretch = job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
      const done = await tx.computerJob.updateMany({
        where: { id: jobId, status: 'running', control: 'brick', secondsRun: job.secondsRun, stretchStarted: job.stretchStarted, ...acts },
        // A new wait is one more thing to tell the person, once (the report back); asked again while it waits it is the same wait
        data: { status: 'waiting', waitingFor, control: 'brick', secondsRun: job.secondsRun + stretch, stretchStarted: now, handoverSeq: { increment: 1 }, leaseVersion: { increment: 1 }, handoverUntold: true, ...readyData },
      });
      landed = done.count;
    } else if (job.status === 'waiting') {
      const done = await tx.computerJob.updateMany({ where: { id: jobId, status: 'waiting', control: 'brick', secondsRun: job.secondsRun, stretchStarted: job.stretchStarted, ...acts }, data: { waitingFor, ...readyData } });
      landed = done.count;
    }
    return { landed };
  });
  if (!found) return { job: null, refused: null };
  const landed = found.landed;
  const after = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  let refused: 'superseded' | 'stale' | 'not_current' | null = null;
  if (landed === 0 && after && (after.status === 'running' || after.status === 'waiting')) {
    if (!epochMatches(after.ownerEpoch, owner.epoch)) refused = 'superseded';
    else if (owner.generation !== undefined && owner.generation !== null && owner.generation !== after.controlGeneration) refused = 'stale';
    else if (typeof owner.responseId === 'string' && owner.responseId !== after.agentResponseId) refused = 'not_current';
  }
  return { job: after ? jobView(after) : null, refused };
}

/** `requestHandoverAs` for a caller that only wants the job as it stands (a worker that names no owner, as before). */
export async function requestHandover(jobId: string, waitingFor: WaitingFor, now: Date = new Date(), ready?: { what: string; where: string } | null, owner: { epoch?: EpochSaid; generation?: number | null; responseId?: string | null } = {}): Promise<JobView | null> {
  return (await requestHandoverAs(jobId, waitingFor, now, ready, owner)).job;
}

/** Cancels a turn of the agent on a Brick's machine. Best effort: a turn that is already over, or a machine that does not answer, is not an error here. */
async function cancelAgentTurn(botId: string, responseId: string): Promise<void> {
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider) return;
  await provider.cancelTurn(row.providerRef, responseId).catch((error) => console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown'));
}

/** What `universe-fence --check` prints when nothing the agent started is left running. The command is in the image (it knows which processes the desktop needs). */
const FENCE_CLEAR = /(^|\n)remaining=0\s*$/;
const FENCE_TRIES = 3;

/**
 * The take-over fence's second half (build handoff v2, section 4), done on the machine before the person has the keyboard: the turn
 * the agent is running is cancelled, every process it started is stopped (the image's `universe-fence` keeps the desktop, the screen
 * and the agent's gateway), and a second look proves none is left. A fence that cannot be proved stops the machine: the person
 * then has no screen, rather than a screen with an agent still acting behind it. The disk is kept either way. Never throws.
 */
export async function fenceMachine(botId: string, stillLeader?: StillLeader): Promise<'done' | 'failed' | 'skipped' | 'lost'> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId } });
    const provider = providerFor(row);
    if (!row?.providerRef || !provider || row.machine !== 'working') return 'skipped';
    const ref = row.providerRef;
    // A leader whose lease was taken over sends nothing: not the cancel of a turn, not a fence attempt (what the new leader's agent started is not ours to stop)
    if (stillLeader && !(await stillLeader())) return 'lost';
    const turns = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] }, NOT: { agentResponseId: null } }, select: { id: true, agentResponseId: true } });
    for (const turn of turns) {
      if (stillLeader && !(await stillLeader())) return 'lost';
      if (turn.agentResponseId) await provider.cancelTurn(ref, turn.agentResponseId).catch((error) => console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown'));
      await prisma.computerJob.updateMany({ where: { id: turn.id, agentResponseId: turn.agentResponseId }, data: { agentResponseId: null } });
    }
    for (let attempt = 0; attempt < FENCE_TRIES; attempt++) {
      if (stillLeader && !(await stillLeader())) return 'lost';
      try {
        await provider.exec(ref, 'universe-fence', { timeoutMs: 30_000 });
        const check = await provider.exec(ref, 'universe-fence --check', { timeoutMs: 30_000 });
        if (check.exitCode === 0 && FENCE_CLEAR.test(check.stdout)) return 'done';
      } catch (error) {
        console.error('[Computer] The fence did not run:', error instanceof Error ? error.message : 'unknown');
      }
    }
    // A leader whose lease was taken over while it ran does not stop a machine the new leader (or the person, once it was proved) now has
    if (stillLeader && !(await stillLeader())) return 'lost';
    // Not proved: the machine is stopped so nothing can act behind the person's back. Its files stay, and the next job wakes it. The leadership is
    // looked at again under the lock on the computer's row, together with the stop (a leader that stalls here cannot stop it after the hand-over)
    console.error('[Computer] The take-over fence could not be proved: the machine is stopped');
    if (!(await stopMachineWhileLeader(botId, ref, provider, stillLeader))) return 'lost';
    return 'failed';
  } catch (error) {
    console.error('[Computer] The fence failed:', error instanceof Error ? error.message : 'unknown');
    return 'failed';
  }
}

/** How often a working machine is sent a no-op command: Agent37 counts a command as activity, and a machine with none for its idle time sleeps (900 s). */
const KEEP_AWAKE_EVERY_MS = 5 * 60 * 1000;

/**
 * While a job holds a machine, a command that does nothing is sent every 5 minutes, so a long quiet stretch of work (the agent
 * thinking, a build running) is not slept under it. Management reads do not count as activity; a command does. Once no job holds the
 * machine it is no longer sent one, and the machine rests. Returns how many were sent.
 */
async function keepWorkingMachinesAwake(now: Date, batch: number): Promise<number> {
  const due = await prisma.brickComputer.findMany({
    where: { machine: 'working', NOT: { providerRef: null }, OR: [{ keptAwakeAt: null }, { keptAwakeAt: { lte: new Date(now.getTime() - KEEP_AWAKE_EVERY_MS) } }] },
    select: { botId: true, providerRef: true, provider: true, keptAwakeAt: true },
    take: batch,
  });
  let sent = 0;
  for (const machine of due) {
    if ((await prisma.computerJob.count({ where: { botId: machine.botId, status: { in: ['running', 'waiting'] } } })) === 0) continue;
    const provider = providerFor(machine);
    if (!provider || !machine.providerRef) continue;
    // One sweep at a time sends it: the claim is on the time that was seen
    const claim = await prisma.brickComputer.updateMany({ where: { botId: machine.botId, machine: 'working', keptAwakeAt: machine.keptAwakeAt }, data: { keptAwakeAt: now } });
    if (claim.count !== 1) continue;
    try {
      await provider.exec(machine.providerRef, 'true', { name: `awake:${Math.floor(now.getTime() / KEEP_AWAKE_EVERY_MS)}`, timeoutMs: 20_000 });
      sent++;
    } catch (error) {
      console.error('[Computer] Could not keep a machine awake:', error instanceof Error ? error.message : 'unknown');
      // Tried again by the next sweep rather than five minutes from now
      await prisma.brickComputer.updateMany({ where: { botId: machine.botId, keptAwakeAt: now }, data: { keptAwakeAt: machine.keptAwakeAt } });
    }
  }
  return sent;
}

/**
 * The take-over fence's first half, kept here so every way control changes uses it: the control generation of the Brick's live
 * jobs moves up and their keys end. A key made before is refused, so the agent cannot act on what it was told before the person
 * took the machine (or before they gave it back).
 */
async function fenceControl(botId: string, now: Date = new Date()): Promise<void> {
  const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] } }, select: { id: true } });
  for (const job of jobs) {
    // The runner's hold on the job ends with its keys: the person has the machine (or just gave it back), so the runner that picks the job up next claims it at once instead of waiting the hold out (GPT round 6, finding 3)
    await prisma.computerJob.updateMany({ where: { id: job.id }, data: { controlGeneration: { increment: 1 }, leaseVersion: { increment: 1 }, ownerLeaseUntil: null } });
    await revokeJobTokens(job.id, now);
  }
}

export type Control = { ok: true; job: JobView } | { ok: false; reason: 'not_found' | 'nothing_waiting' | 'in_progress' | 'not_secured' };

/** The first turns of a Brick's jobs that were marked as sent and never named: gone only when nothing can still be running them (see leadFence). */
async function clearFirstTurnMarks(botId: string): Promise<void> {
  await prisma.computerJob.updateMany({ where: { botId, NOT: { firstTurnSentAt: null }, agentResponseId: null }, data: { firstTurnSentAt: null } });
}

/** Whether a job ended here with a first turn that may still run on this machine (see `settleTurnHold`). */
export async function underTurnHold(botId: string): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { turnUnprovenSince: true } });
  return !!row?.turnUnprovenSince;
}

/**
 * A job whose first turn was marked as sent and never named can end while that turn still runs on the machine (nothing can be asked for it, and a
 * machine that is not put to rest, or a rest that failed, leaves it running). The machine then carries a hold in its own row (`turnUnprovenSince`,
 * kept with the job's end in one commit, so it survives a failed call and a restart): no job is started on it and no turn is opened on it until the
 * machine is proved asleep (or there is none). This is the one place that asks for that proof and lifts the hold. It stops the machine only when no
 * other job holds it (`exceptJobId` is the caller that is itself waiting to start a turn, which does not count): a job's work, or a person at the
 * screen, is never put to sleep under them; the hold then waits for them to end. Returns whether the machine is free of the hold. Never throws.
 */
export async function settleTurnHold(botId: string, exceptJobId?: string): Promise<boolean> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { providerRef: true, provider: true, machine: true, turnUnprovenSince: true } });
    if (!row?.turnUnprovenSince) return true;
    const seen = row.turnUnprovenSince;
    // Only the hold that was seen is lifted: a newer one, set by another job's end while this looked, stays
    const lift = () => prisma.brickComputer.updateMany({ where: { botId, turnUnprovenSince: seen }, data: { turnUnprovenSince: null } });
    if (await agentCannotRun(botId)) {
      await lift();
      await clearFirstTurnMarks(botId);
      return true;
    }
    const holders = await prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] }, ...(exceptJobId ? { id: { not: exceptJobId } } : {}) } });
    if (holders > 0) return false;
    const provider = providerFor(row);
    if (!provider || !row.providerRef) return false;
    // Its work is saved before it is stopped, as every other stop does (a copy that fails is not claimed and never holds the stop up; a machine that is not awake is not woken to be copied)
    if (await provider.awake(row.providerRef).catch(() => false)) await saveCopy(botId, row.providerRef, provider);
    if (!(await stopMachine(botId, row.providerRef, provider))) return false;
    await lift();
    // Proved asleep: no first turn of any job on this machine can still be running, so their marks go (as after a take-over fence that stopped it)
    await clearFirstTurnMarks(botId);
    return true;
  } catch (error) {
    console.error('[Computer] Could not settle a machine’s turn hold:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * Whether nothing of the agent can still be running on the Brick's machine: there is no machine, or it is proved asleep (`stopped`: the provider
 * said so). The machine's fence is not that: it ends the keys and stops what the agent started, but keeps the agent's gateway (and everything
 * above it), and a job's first turn runs inside the gateway, so a turn that never said its id survives a fence that was proved clear.
 */
export async function agentCannotRun(botId: string): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { providerRef: true, machine: true } });
  return !row || !row.providerRef || row.machine === 'none' || row.machine === 'stopped';
}

/**
 * Every job working on the machine becomes the person's, the one that writes and any that only read: none is left running under
 * Brick's hands while the person has the keyboard. Asked again until none is left: a job that began while the others were being
 * moved is found by the next look, and one that begins after sees the person's control above.
 */
async function moveJobsToPerson(botId: string, now: Date): Promise<{ changed: number; moved: number }> {
  // The jobs already waiting for the person are theirs first: from here a job that starts sees the person has the machine and waits
  const changed = await prisma.computerJob.updateMany({ where: { botId, status: 'waiting', control: 'brick' }, data: { control: 'person', leaseVersion: { increment: 1 } } });
  let moved = 0;
  for (let round = 0; round < 5; round++) {
    const runningJobs = await prisma.computerJob.findMany({ where: { botId, status: 'running' } });
    if (runningJobs.length === 0) break;
    moved += runningJobs.length;
    for (const running of runningJobs) {
      const stretch = running.stretchStarted ? Math.max(0, Math.round((now.getTime() - running.stretchStarted.getTime()) / SECOND)) : 0;
      await prisma.computerJob.updateMany({
        where: { id: running.id, status: 'running' },
        data: { status: 'waiting', waitingFor: null, control: 'person', secondsRun: running.secondsRun + stretch, stretchStarted: now, readyWhat: null, readyWhere: null, leaseVersion: { increment: 1 } },
      });
    }
  }
  return { changed: changed.count, moved };
}

/**
 * The machine half of the fence, proved. `fenceMachine` stops what the agent started and looks again; when that cannot be proved it
 * stops the machine. A stopped machine that is PROVED stopped is a closed machine (nothing can act on it, and the person has no screen
 * until it wakes); one whose stop is not proved is not: it is stopped again, and if that is not proved either, the fence is not proved.
 */
async function secureMachine(botId: string, stillLeader?: StillLeader): Promise<'proved' | 'unproved' | 'lost'> {
  const fenced = await fenceMachine(botId, stillLeader);
  if (fenced === 'done') return 'proved';
  if (fenced === 'lost') return 'lost';
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider) return 'proved';
  // A stop that was asked and not proved yet (or a machine that fell back to stopping): asked again here, never taken as proof
  if (row.machine === 'stopping') return (await stopMachine(botId, row.providerRef, provider, ['stopping'])) ? 'proved' : 'unproved';
  // A machine still working after a failed fence (it failed before its stop could be asked: the database away, a cancel that did not take) has
  // not been closed: agent processes may still run, so it is never taken as proved
  if (row.machine === 'working') return 'unproved';
  // The fence failed and the machine was stopped by it, or it was not a working machine at all (nothing was running to fence)
  return 'proved';
}

type Fenced = 'ready' | 'idle' | 'unproved' | 'lost';

/**
 * The take over's stages, led by one request (or finished by the next after a leader that died). Every stage is safe to run again:
 *   1. every job the agent is working on becomes the person's (Brick's turn is gone from here: nothing is admitted in `fencing`);
 *   2. every key the computer held ends and the control number moves;
 *   3. the machine's own fence is run and PROVED (the turn is cancelled, what the agent started is stopped, a second look finds none);
 *   4. only then does control become `human_ready`, which is the first moment the person's screen input can be authorized.
 * A fence that cannot be proved leaves control in `fencing`: the person has no input and nothing is lost, and the next request or the
 * sweep tries again. `epoch` is null only for a computer with no row.
 */
async function leadFence(botId: string, epoch: number | null, now: Date): Promise<Fenced> {
  const mine = async () => epoch === null || (await renewTransition(botId, 'fencing', epoch));
  let rounds = 0;
  for (;;) {
    const { changed, moved } = await moveJobsToPerson(botId, now);
    const held = await prisma.computerJob.count({ where: { botId, status: 'waiting', control: 'person' } });
    if (changed + moved === 0 && held === 0) {
      // Nothing was the person's to take: control stays Brick's
      if (epoch !== null) await finishTransition(botId, 'fencing', epoch, 'agent');
      return 'idle';
    }
    if (!(await mine())) return 'lost';
    // The fence: every key the computer held ends and the number moves, so a call the agent had in flight is refused from here on
    await fenceControl(botId);
    if (!(await mine())) return 'lost';
    // Then the machine itself: the turn is cancelled and what the agent started is stopped and proved gone, before the person has the screen
    const secured = await secureMachine(botId, epoch === null ? undefined : (db) => renewTransition(botId, 'fencing', epoch, db));
    if (secured === 'lost') return 'lost';
    if (secured === 'unproved') {
      if (epoch !== null) await releaseLease(botId, 'fencing', epoch);
      return 'unproved';
    }
    // A job's first turn that never said its id (marked in its row before it was sent) is NOT stopped by the fence unless the machine itself was: the
    // fence keeps the agent's gateway, the turn runs inside it, and its model calls are only paused by the keys that ended. So the mark stays, and the
    // start after the hand-back ends the job instead of opening a second first turn beside the one that runs (two charges). It goes only when the
    // machine is proved asleep (the fence could not be proved and stopped it, or there is no machine): then nothing runs and a start opens a turn as any other
    if (await agentCannotRun(botId)) await clearFirstTurnMarks(botId);
    // A job that began while the fence ran is looked for once more: it is the person's too, and the fence is run again for it
    if ((await prisma.computerJob.count({ where: { botId, status: 'running' } })) === 0) break;
    if (++rounds >= 3) {
      if (epoch !== null) await releaseLease(botId, 'fencing', epoch);
      return 'unproved';
    }
  }
  // From here the person has the computer: a page opened from now until it goes back is theirs, never Brick's (the record of where it browsed)
  await noteHands(botId, 'person');
  if (epoch === null) return 'ready';
  return (await finishTransition(botId, 'fencing', epoch, 'human_ready')) ? 'ready' : 'lost';
}

/** The take over's second look at a computer that is already the person's: a job that joined after the fence is not left running under Brick's hands. */
const hasStragglers = async (botId: string): Promise<boolean> =>
  (await prisma.computerJob.count({ where: { botId, OR: [{ status: 'running' }, { status: 'waiting', control: 'brick' }] } })) > 0;

/** The job the person is looking at after a take over, or the reason there is none. */
async function afterTakeOver(botId: string): Promise<Control> {
  const job = await prisma.computerJob.findFirst({ where: { botId, status: 'waiting', control: 'person' }, orderBy: [{ writes: 'desc' }, { createdAt: 'asc' }], include: JOB_INCLUDE });
  return job ? { ok: true, job: jobView(job) } : { ok: false, reason: 'nothing_waiting' };
}

/**
 * Take over: the person has the mouse and keyboard. Offered while the job waits for them, and while it works too (the mock lets
 * them step in at any time): a working job then waits for them, its stretch so far counted, the machine staying awake. Their own Brick only.
 *
 * Control changes hands through one durable transition (lib/computer-control.ts): this request either leads the fence or joins the one
 * already going, and it answers only when the fence is PROVED, never while it is still pending. Asked twice it is the same.
 */
export async function takeOver(botId: string, ownerId: string, now: Date = new Date()): Promise<Control> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const deadline = Date.now() + CONTROL_TIMING.joinMs;
  for (;;) {
    const row = await readControl(botId);
    // A Brick with no computer row has no machine to fence: its jobs still become the person's
    if (!row) {
      await leadFence(botId, null, now);
      break;
    }
    const t = Date.now();
    if (row.state === 'agent' || (row.state === 'human_ready' && (await hasStragglers(botId)))) {
      const epoch = await beginTransition(botId, row.state, row.epoch, 'fencing');
      if (epoch === null) continue;
      const done = await leadFence(botId, epoch, now);
      if (done === 'unproved') return { ok: false, reason: 'not_secured' };
      if (done === 'lost') continue;
      break;
    }
    if (row.state === 'human_ready') break;
    // A change of hands is on its way: this request joins it rather than begin another or answer before it is done
    if (leaseLapsed(row, t)) {
      const resumed = await resumeTransition(botId, row);
      if (resumed === null) continue;
      if (row.state === 'fencing') {
        const done = await leadFence(botId, resumed, now);
        if (done === 'unproved') return { ok: false, reason: 'not_secured' };
      } else {
        await finishReturn(botId, resumed);
      }
      continue;
    }
    if (t >= deadline) return { ok: false, reason: 'in_progress' };
    await sleep(CONTROL_TIMING.pollMs);
  }
  return afterTakeOver(botId);
}

/**
 * A take-over fence that could not be proved stops the machine (see fenceMachine). The jobs handed back need it working again, so it is
 * woken here; if it will not come back the jobs end, their room given back, rather than wait on a machine that is not there.
 */
export async function wakeIfStopped(botId: string): Promise<void> {
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider || (row.machine !== 'stopped' && row.machine !== 'stopping')) return;
  try {
    await bringUp(botId, provider, new Date());
  } catch (error) {
    console.error('[Computer] A machine did not come back after a hand back:', error instanceof Error ? error.message : 'unknown');
    const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] } }, select: { id: true } });
    for (const job of jobs) await endJob(job.id, 'stopped', 'error', new Date());
    await prisma.brickComputer.updateMany({ where: { botId, machine: { in: ['waking', 'restoring'] } }, data: { machine: 'broken' } });
  }
}

/**
 * The hand back's stages, led by one request (or finished by the next after a leader that died). Every stage is safe to run again:
 *   1. the person's input already ended (the control number moved when this began); what the gateway was already granted is waited out,
 *      so every input socket has been told no or has lapsed before Brick can act again;
 *   2. the jobs go back to Brick, and every key made before ends (the runner asks for a new one for what comes next);
 *   3. a machine the fence stopped is woken;
 *   4. only then does control become Brick's.
 * Brick is not admitted at any point before step 4, whatever state the jobs are in.
 */
async function finishReturn(botId: string, epoch: number | null): Promise<'back' | 'lost'> {
  const mine = async () => epoch === null || (await renewTransition(botId, 'returning', epoch));
  if (epoch !== null) await drainHumanInput(botId);
  if (!(await mine())) return 'lost';
  // Asked until a pass finds none: a job that joined the person while the others were being handed back is found by the next pass
  for (let round = 0; round < 5; round++) {
    const back = await prisma.computerJob.updateMany({ where: { botId, status: 'waiting', control: 'person' }, data: { status: 'running', control: 'brick', waitingFor: null, readyWhat: null, readyWhere: null, leaseVersion: { increment: 1 } } });
    if (back.count === 0) break;
  }
  if (!(await mine())) return 'lost';
  await noteHands(botId, 'brick');
  // Keys made before the hand back stay refused, whether or not this pass moved a job (a pass that died after the move still needs them ended)
  await fenceControl(botId);
  await wakeIfStopped(botId);
  if (epoch === null) return 'back';
  return (await finishTransition(botId, 'returning', epoch, 'agent')) ? 'back' : 'lost';
}

/**
 * Hand back: Brick carries on from where the person left it. What they entered is theirs and is not read back by this call. Their screen
 * input ends first and is drained, and only then does Brick resume (see finishReturn); a hand back asked while a take over is still being
 * fenced waits for it, and one asked twice is the same.
 */
export async function handBack(botId: string, ownerId: string): Promise<Control> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const deadline = Date.now() + CONTROL_TIMING.joinMs;
  for (;;) {
    const row = await readControl(botId);
    if (!row) {
      await finishReturn(botId, null);
      break;
    }
    const t = Date.now();
    const personHolds = row.state === 'agent' ? (await prisma.computerJob.count({ where: { botId, status: 'waiting', control: 'person' } })) > 0 : false;
    if (row.state === 'human_ready' || personHolds || (row.state === 'fencing' && leaseLapsed(row, t))) {
      // From `fencing` with its leader gone (a fence that was never proved): the person never had input, so there is nothing to drain
      const epoch = await beginTransition(botId, row.state, row.epoch, 'returning');
      if (epoch === null) continue;
      if ((await finishReturn(botId, epoch)) === 'lost') continue;
      break;
    }
    if (row.state === 'agent') break;
    if (row.state === 'returning' && leaseLapsed(row, t)) {
      const resumed = await resumeTransition(botId, row);
      if (resumed !== null) await finishReturn(botId, resumed);
      continue;
    }
    if (t >= deadline) return { ok: false, reason: 'in_progress' };
    await sleep(CONTROL_TIMING.pollMs);
  }
  const job = await prisma.computerJob.findFirst({ where: { botId, status: { in: ['running', 'waiting'] } }, orderBy: [{ writes: 'desc' }, { createdAt: 'asc' }], include: JOB_INCLUDE });
  if (!job) return { ok: false, reason: 'nothing_waiting' };
  return { ok: true, job: jobView(job) };
}

/**
 * The sweep finishes what a leader that died (or gave up) left: a fence that could not be proved is tried again, a hand back that stopped half
 * way is completed, and a computer the person still holds after their jobs are over goes back to Brick's. Safe to run twice at once: the lease
 * is taken with one compare-and-set, so only one sweep finishes a given transition.
 */
export async function recoverControl(now: Date = new Date(), batch: number = SWEEP_BATCH): Promise<number> {
  // Two lists, each with its own bound: a transition whose leader is gone, and a computer the person holds with no job left. A computer the person
  // holds while a job still waits for them is not in either (nothing is done for it), so a page of those can never push a transition out of the sweep
  const transitions = await prisma.brickComputer.findMany({
    where: { controlState: { in: ['fencing', 'returning'] }, OR: [{ controlLeaseUntil: null }, { controlLeaseUntil: { lte: new Date() } }] },
    select: { botId: true },
    orderBy: { botId: 'asc' },
    take: batch,
  });
  const unheld = await prisma.$queryRaw<Array<{ botId: string }>>(Prisma.sql`
    SELECT bc."bot_id" AS "botId" FROM "brick_computers" bc
    WHERE bc."control_state" = 'human_ready'
      AND NOT EXISTS (SELECT 1 FROM "computer_jobs" j WHERE j."bot_id" = bc."bot_id" AND j."status" IN ('running', 'waiting'))
    ORDER BY bc."bot_id" ASC
    LIMIT ${batch}`);
  const stuck = [...transitions, ...unheld];
  let finished = 0;
  for (const { botId } of stuck) {
    const row = await readControl(botId);
    if (!row) continue;
    if (row.state === 'human_ready') {
      await releaseIfUnheld(botId).catch(() => undefined);
      continue;
    }
    if (row.state === 'agent' || !leaseLapsed(row)) continue;
    const resumed = await resumeTransition(botId, row);
    if (resumed === null) continue;
    try {
      if (row.state === 'fencing') await leadFence(botId, resumed, now);
      else await finishReturn(botId, resumed);
      finished++;
    } catch (error) {
      console.error('[Computer] Could not finish a change of hands:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return finished;
}

/**
 * Whether the person has the computer, read with its row held (FOR SHARE) to the end of the caller's transaction: a hand back, which writes
 * that row first, waits for the step that holds it. A computer with no row counts as the person's, as in `humanHasControl`.
 */
async function personHoldsComputer(tx: Prisma.TransactionClient, botId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ control_state: string }[]>`SELECT "control_state" FROM "brick_computers" WHERE "bot_id" = ${botId} FOR SHARE`;
  return rows.length === 0 || rows[0].control_state === 'human_ready';
}

export type Filling = { ok: true; job: JobView } | { ok: false; reason: 'not_found' | 'not_in_control' | 'nothing_ready' | 'changed' };

/**
 * "Fill in my details": only while the person has taken over, and only for what Brick named it was ready to put in, and where (the
 * person's tap approves exactly that: they can't name something else, and Brick can't fill something it did not name). Paying and
 * submitting are never in it. The bot server reads it from the job, plans it (which claims it once) and settles it.
 */
export async function fillInDetails(botId: string, ownerId: string, shown?: { what: string; where: string } | null): Promise<Filling> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  // After a take over several jobs can be in the person's hands (the one Brick handed over and any that were only working): the one the
  // tap is for is the one that named something to fill in, found by what the screen showed, never by which came first from the database
  const held = await prisma.computerJob.findMany({ where: { botId, status: 'waiting', control: 'person' }, orderBy: [{ writes: 'desc' }, { createdAt: 'asc' }] });
  // The tap is only taken once the fence is proved: while control is changing hands the person does not have the machine yet
  if (held.length === 0 || !(await humanHasControl(botId))) return { ok: false, reason: 'not_in_control' };
  const named = held.filter((candidate) => candidate.readyWhat && candidate.readyWhere);
  if (named.length === 0) return { ok: false, reason: 'nothing_ready' };
  // The tap approves what the person was looking at, so the screen must say what it showed: a page that sent nothing, or opened before
  // Brick named something new, never approves the new thing.
  if (!shown) return { ok: false, reason: 'changed' };
  const job = named.find((candidate) => candidate.readyWhat === shown.what && candidate.readyWhere === shown.where);
  if (!job) return { ok: false, reason: 'changed' };
  const key = detailsKey(shown.what, shown.where);
  // The check and the approval are one transaction: what Brick named cannot change between them, so the approval is for exactly what was shown
  const approved = await prisma.$transaction(async (tx) => {
    // The person must still have the machine when the approval is written: the computer's row is held for the rest of this step, so a hand back waits for it
    if (!(await personHoldsComputer(tx, botId))) return 'not_in_control' as const;
    const same = await tx.computerJob.updateMany({ where: { id: job.id, status: 'waiting', control: 'person', readyWhat: shown.what, readyWhere: shown.where }, data: { readyWhat: shown.what } });
    if (same.count === 0) return false;
    await tx.computerEffect.upsert({
      where: { jobId_effectKey: { jobId: job.id, effectKey: key } },
      create: { jobId: job.id, effectKey: key, kind: 'details', state: 'approved', evidence: `${shown.what}${DETAILS_SEPARATOR}${shown.where}` },
      update: {},
    });
    // One that was tried and confirmed NOT done is approved again by this tap, so Brick can try it once more; done or still planned stay as they are
    await tx.computerEffect.updateMany({ where: { jobId: job.id, effectKey: key, state: 'failed' }, data: { state: 'approved', settledAt: null } });
    return true;
  });
  if (approved === 'not_in_control') return { ok: false, reason: 'not_in_control' };
  if (!approved) return { ok: false, reason: 'changed' };
  const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.id }, include: JOB_INCLUDE });
  return { ok: true, job: jobView(after) };
}

// ---------- Effects outside the computer ----------

export type Planned =
  | { ok: true; already: false }
  /** Done before: the retry has nothing to do, and says so. */
  | { ok: true; already: 'done'; evidence: string | null }
  /** Tried before and the outcome is not known: look up what happened first, then settle it. Never repeat it blind. */
  | { ok: false; reason: 'look_up'; evidence: string | null }
  /** Pay and submit are the person's, always. */
  | { ok: false; reason: 'person_only' }
  /** Details and uploads wait until the person has taken over and asked. */
  | { ok: false; reason: 'hand_over_first' }
  | { ok: false; reason: 'job_over' | 'not_found' }
  /** Not the owner: another runner claimed the job since (the game reads `run: 'superseded'` and exits). Nothing was written. */
  | typeof SUPERSEDED;

/**
 * The job means to do something outside its computer (send, publish, put details in, upload, pay, submit): written BEFORE it is
 * tried, once per key. A retry of the same key finds it: done means nothing to do, planned means the outcome is not known and the
 * job must look it up and settle it, never repeat it. Brick never pays or submits itself, and puts details in or uploads only
 * after the person has taken over and asked it to.
 */
export async function planEffect(
  jobId: string,
  input: { key: string; kind: EffectKind; evidence?: string | null },
  /** Who asks: the epoch the worker owns the job by (none = a worker that knows none: only while the job has none). Left out altogether = Orbit's own trusted path, which no worker's epoch fences. */
  owner?: { epoch?: EpochSaid },
): Promise<Planned> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  // A worker that does not own the job is told so before anything is read for it (decided again, in the write that plans, below, under the job's row lock)
  if (owner && !epochMatches(job.ownerEpoch, owner.epoch)) return SUPERSEDED;
  // Only a job that holds the machine can mean to do something outside it: one still in line has no room and no machine yet
  if (job.status !== 'running' && job.status !== 'waiting') return { ok: false, reason: 'job_over' };
  const existing = await prisma.computerEffect.findUnique({ where: { jobId_effectKey: { jobId, effectKey: input.key } } });
  if (existing?.state === 'done') return { ok: true, already: 'done', evidence: existing.evidence };
  // Tried before and the outcome is not known: look it up, never repeat it blind
  if (existing?.state === 'planned') return { ok: false, reason: 'look_up', evidence: existing.evidence };
  if (PERSON_ONLY.includes(input.kind)) return { ok: false, reason: 'person_only' };
  if (AFTER_TAKE_OVER.includes(input.kind) && (job.control !== 'person' || job.status !== 'waiting' || !(await humanHasControl(job.botId)))) return { ok: false, reason: 'hand_over_first' };
  // Details and uploads are only ever the person's tap: it wrote the approved row, and a key nobody approved is never planned
  // What the person approved is exactly that row: the same kind, still unspent. Another kind's row on the same key, or a row settled as
  // failed that no tap approved again, is not their approval.
  if (AFTER_TAKE_OVER.includes(input.kind) && (!existing || existing.kind !== input.kind || existing.state !== 'approved')) return { ok: false, reason: 'hand_over_first' };
  // A key that was used for one kind of effect is never reused for another
  if (existing && existing.kind !== input.kind) return { ok: false, reason: 'look_up', evidence: existing.evidence };
  if (existing) {
    // Approved by the person, or tried and confirmed not done: claimed in one write, so two tries at the same moment do it once
    // Details and uploads are claimed from "approved" only: a tap is spent once, so one that failed needs a new tap, never a second claim
    const states = AFTER_TAKE_OVER.includes(input.kind) ? ['approved'] : ['approved', 'failed'];
    const claimed = await prisma.$transaction(async (tx) => {
      // The job's row first, held to the end of this claim: the owner is decided HERE, in the write that plans, never in the read above (a runner that replaced this one may have claimed since)
      const row = await lockJobRow(tx, jobId);
      if (!row || (row.status !== 'running' && row.status !== 'waiting')) return 'over' as const;
      if (owner && !epochMatches(row.ownerEpoch, owner.epoch)) return 'superseded' as const;
      // The person's hands: checked again here, with the job held so a hand-back (or the end of the job) waits for this claim. The read
      // above may be old by now, and a tap is only ever spent while the person still has the machine
      if (AFTER_TAKE_OVER.includes(input.kind)) {
        // The computer's own row first (a hand back writes it before it moves the jobs), held to the end of this claim: control cannot go back to
        // Brick between this check and the claim, and a row that says anything but "the person is ready" means the hands are changing
        if (!(await personHoldsComputer(tx, job.botId))) return 'hand_over_first' as const;
        const now = await tx.$queryRaw<{ status: string; control: string }[]>`SELECT "status", "control" FROM "computer_jobs" WHERE "id" = ${jobId} FOR SHARE`;
        if (now.length === 0 || now[0].status !== 'waiting' || now[0].control !== 'person') return 'hand_over_first' as const;
      }
      return (await tx.computerEffect.updateMany({ where: { id: existing.id, state: { in: states } }, data: { state: 'planned', settledAt: null } })).count;
    });
    if (claimed === 'over') return { ok: false, reason: 'job_over' };
    if (claimed === 'superseded') return SUPERSEDED;
    if (claimed === 'hand_over_first') return { ok: false, reason: 'hand_over_first' };
    return claimed === 1 ? { ok: true, already: false } : { ok: false, reason: 'look_up', evidence: existing.evidence };
  }
  try {
    const made = await prisma.$transaction(async (tx) => {
      // The same rule as the claim above: the job's row is locked, the owner and the job's state are looked at, and the effect is written, all in one transaction
      const row = await lockJobRow(tx, jobId);
      if (!row || (row.status !== 'running' && row.status !== 'waiting')) return 'over' as const;
      if (owner && !epochMatches(row.ownerEpoch, owner.epoch)) return 'superseded' as const;
      await tx.computerEffect.create({ data: { jobId, effectKey: input.key.slice(0, 255), kind: input.kind, state: 'planned', evidence: input.evidence?.slice(0, 500) ?? null } });
      return 'planned' as const;
    });
    if (made === 'over') return { ok: false, reason: 'job_over' };
    if (made === 'superseded') return SUPERSEDED;
  } catch (error) {
    // Two tries at the same moment: the first wrote it, the second finds it and must look up what happened
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { ok: false, reason: 'look_up', evidence: null };
    throw error;
  }
  return { ok: true, already: false };
}

/**
 * What happened to an effect, confirmed: done (with where it went, as proof) or failed (confirmed not done, so it may be tried again). A worker names the epoch it owns the job by: one that was replaced
 * (another runner claimed the job since) settles nothing, in the write itself under the job's row lock. `owner` left out is Orbit's own trusted path (a reconciliation after a worker is gone), which no epoch fences.
 */
export async function settleEffectAs(jobId: string, key: string, state: 'done' | 'failed', evidence?: string | null, owner?: { epoch?: EpochSaid }): Promise<{ ok: boolean; superseded: boolean }> {
  // The effect's own change and the fact that a give-back already made was for work that turned out delivered commit TOGETHER: a flag that cannot be written leaves the
  // effect planned, and the settle is asked again (the charge is never touched either way)
  // Under the person's give-back lock, taken BEFORE the effect is touched (the same order a decision made again takes it: lock first, then the effects). A retry that read
  // this effect as planned and grants goodwill then either finishes first, and this settlement flags that give-back as delivered late, or comes after, and sees the effect done
  const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { personId: true, ownerEpoch: true } });
  if (first && owner && !epochMatches(first.ownerEpoch, owner.epoch)) return { ok: false, superseded: true };
  const done = await prisma.$transaction(async (tx) => {
    if (first) await lockPerson(tx, first.personId);
    // The job's row after the person's lock (the order everywhere), held to the end: the owner is decided HERE, in the write that settles
    if (first && owner) {
      const row = await lockJobRow(tx, jobId);
      if (!row || !epochMatches(row.ownerEpoch, owner.epoch)) return { count: 0, superseded: true, kind: null as string | null };
    }
    const changed = await tx.computerEffect.updateMany({
      where: { jobId, effectKey: key, state: 'planned' },
      data: { state, settledAt: new Date(), ...(evidence !== undefined ? { evidence: evidence === null ? null : evidence.slice(0, 500) } : {}) },
    });
    if (changed.count > 0 && state === 'done') await markDeliveredLate(tx, jobId);
    // What Brick named is put in (or confirmed not): the tap is spent, and the next hand-over names its own
    const effect = changed.count > 0 ? await tx.computerEffect.findUnique({ where: { jobId_effectKey: { jobId, effectKey: key } }, select: { kind: true } }) : null;
    // The prompt this settlement is for is cleared in the same transaction, and only that one: a newer prompt the worker registered since (another thing to put in, another place) stays for the person (CodeRabbit on #1025, 13)
    if (effect?.kind === 'details') {
      const shown = await tx.computerJob.findUnique({ where: { id: jobId }, select: { readyWhat: true, readyWhere: true } });
      if (shown?.readyWhat && shown.readyWhere && detailsKey(shown.readyWhat, shown.readyWhere) === key) {
        await tx.computerJob.updateMany({ where: { id: jobId, readyWhat: shown.readyWhat, readyWhere: shown.readyWhere }, data: { readyWhat: null, readyWhere: null } });
      }
    }
    return { count: changed.count, superseded: false, kind: effect?.kind ?? null };
  });
  if (done.superseded) return { ok: false, superseded: true };
  if (done.count > 0) {
    // A give-back that was held for this effect is decided now
    await noteEffectSettled(jobId).catch((error) => console.error('[Computer] Could not note a settled effect:', error instanceof Error ? error.message : 'unknown'));
  }
  return { ok: done.count > 0, superseded: false };
}

/** `settleEffectAs` on Orbit's own trusted path (no worker's epoch): true when an effect that was planned is settled now. */
export async function settleEffect(jobId: string, key: string, state: 'done' | 'failed', evidence?: string | null): Promise<boolean> {
  return (await settleEffectAs(jobId, key, state, evidence)).ok;
}

/** The job, for the bot server. Null when it is not there. */
/** What the runner needs of a job that Brick is working on: the words for the agent, and nothing the owner sees on a page. */
export interface RunnableJob {
  jobId: string;
  botId: string;
  title: string;
  brief: string | null;
  writes: boolean;
  /** The agent has a turn going (the runner reconnects to it instead of starting another). */
  hasTurn: boolean;
  /** "Try again" (piece 8): the ended job this one carries on from, in the same agent conversation (its first words say so, and where that job kept its files); null for every other job. */
  continuesJobId: string | null;
}

/** The most jobs one page of the running list holds. */
const RUNNABLE_PAGE_MAX = 200;

export interface RunnablePage {
  jobs: RunnableJob[];
  /** Where the next page starts, or null when this was the last. */
  nextCursor: string | null;
}

const cursorOf = (startedAt: Date, id: string): string => `${startedAt.toISOString()}_${id}`;

function readCursor(cursor: string | null | undefined): { startedAt: Date; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf('_');
  if (at <= 0) return null;
  const startedAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return Number.isNaN(startedAt.getTime()) || id === '' ? null : { startedAt, id };
}

/**
 * Jobs running under Brick's hands now (not waiting for their person, not in the person's hands), oldest first and then by id, a page at a
 * time: the runner asks for each page after the one it has, so no running job stays out of its sight however many there are. A cursor
 * that is not understood starts from the beginning.
 */
export async function runnableJobsPage(limit = 50, cursor?: string | null): Promise<RunnablePage> {
  const size = Math.max(1, Math.min(limit, RUNNABLE_PAGE_MAX));
  const after = readCursor(cursor);
  const rows = await prisma.computerJob.findMany({
    where: {
      status: 'running',
      control: 'brick',
      // A job that carries on is listed only once its browser is settled: a runner that took it up earlier would work on a browser that is not its own (GPT round 6, finding 7)
      prepState: null,
      ...(after ? { OR: [{ startedAt: { gt: after.startedAt } }, { startedAt: after.startedAt, id: { gt: after.id } }] } : {}),
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: size + 1,
    select: { id: true, botId: true, title: true, brief: true, writes: true, agentResponseId: true, startedAt: true, continuesJobId: true },
  });
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    jobs: page.map((row) => ({ jobId: row.id, botId: row.botId, title: row.title, brief: row.brief, writes: row.writes, hasTurn: row.agentResponseId !== null, continuesJobId: row.continuesJobId })),
    nextCursor: rows.length > size && last?.startedAt ? cursorOf(last.startedAt, last.id) : null,
  };
}

/** The first page of the running jobs. */
export async function runnableJobs(limit = 50): Promise<RunnableJob[]> {
  return (await runnableJobsPage(limit)).jobs;
}

export async function getJob(jobId: string): Promise<(JobView & { botId: string; personId: string; /** The control generation the job is on now (it moves each time the person takes the machine and each time it is handed back): what a runner says it acts under. */ controlGeneration: number; /** Who owns the job: the epoch of the worker that last claimed it (0 = nobody ever did), and that worker's run. A runner claims with the epoch it saw here. */ ownerEpoch: number; ownerRun: string | null; /** Set only while the job is still on and its runner has committed to ending it (the finish still to be completed); null otherwise, an ended job included. */ finishPending: FinishPending | null; /** The job was paused before: its runner carries on in the same agent conversation, starting with the resume words. */ resumed: boolean; /** Its last pause took the screen back from the person in the middle of their step: on resume the runner asks the person for that step again (as a paused waiting job does). */ askAgain: boolean }) | null> {
  const row = await prisma.computerJob.findUnique({ where: { id: jobId }, include: { ...JOB_INCLUDE, finishIntent: true } });
  if (!row) return null;
  const pending = row.finishIntent && !isOver(row.status) ? pendingOf(row.finishIntent) : null;
  return { ...jobView(row), botId: row.botId, personId: row.personId, controlGeneration: row.controlGeneration, ownerEpoch: row.ownerEpoch, ownerRun: row.ownerRun, finishPending: pending, resumed: row.pauses > 0, askAgain: row.pauses > 0 && !!(await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId: row.id, n: row.pauses } }, select: { heldScreen: true } }))?.heldScreen };
}

/**
 * The runner CLAIMS a job before it sends anything for it (GPT round 5, E1/E2): it names the owner epoch it last saw (`seen`, from `getJob`), and only a runner that saw the current one wins. In ONE transaction, under the job's cutoff lock with its row
 * locked: a job that is over answers `over`, one that never started `not_running`; a kept finish intent answers `finish_pending` (the runner completes it, it takes no ownership); a decided pool cutoff answers `cutoff`; an epoch that is not `seen`
 * answers `superseded` with the current one (someone claimed since this runner looked: a DELAYED claim always lands here, so it can never take the job back); otherwise the epoch moves up by one, `run` is noted, the lease version moves, the prepare claim is let go
 * and EVERY live key of the job ends in the same commit (the new owner prepares its own). From then on every request the old owner makes meets the new epoch where it takes effect and does nothing.
 */
export async function claimJob(
  jobId: string,
  input: { run: string | null; seen: number },
  now: Date = new Date(),
): Promise<
  | { ok: true; epoch: number }
  | { ok: false; reason: 'not_found' | 'over' | 'not_running' | 'finish_pending' | 'cutoff' }
  | { ok: false; reason: 'superseded'; ownerEpoch: number }
  /** The job is being made ready to carry on (its browser): `restoring` while that is going on, `recover` when it could not be settled and the sweep is putting it right. Nobody owns it yet (GPT round 6, finding 7). */
  | { ok: false; reason: 'not_ready'; prep: string }
  /** A healthy owner holds the job: nothing was written. The asker waits until `until` and looks again, never in a loop (GPT round 6, finding 3). */
  | { ok: false; reason: 'held'; until: Date }
> {
  return prisma.$transaction(
    async (tx) => {
      const job = await lockJob(tx, jobId);
      if (!job) return { ok: false as const, reason: 'not_found' as const };
      if (isOver(job.status)) return { ok: false as const, reason: 'over' as const };
      if (job.status === 'queued') return { ok: false as const, reason: 'not_running' as const };
      if (await hasFinishIntent(tx, jobId)) return { ok: false as const, reason: 'finish_pending' as const };
      if (await hasPoolCutoff(tx, jobId)) return { ok: false as const, reason: 'cutoff' as const };
      // Its browser is still being settled (or could not be): nobody takes the job up yet, and nothing is written (GPT round 6, finding 7)
      if (job.prepState !== null) return { ok: false as const, reason: 'not_ready' as const, prep: job.prepState };
      if (job.ownerEpoch !== input.seen) return { ok: false as const, reason: 'superseded' as const, ownerEpoch: job.ownerEpoch };
      // A job with a LIVE owner is not taken from it, even by a worker that saw the right epoch: a second worker beside a healthy first one is what every fence below is there to prevent (GPT round 6, finding 3).
      // Read here, under the job's row lock, so a beat that is landing is never missed. Free to claim: a job nobody owns (epoch 0), one whose owner stopped beating (90 s), and one the owner let go (`release`)
      if (job.ownerEpoch !== 0 && job.ownerLeaseUntil && job.ownerLeaseUntil > now) return { ok: false as const, reason: 'held' as const, until: job.ownerLeaseUntil };
      await tx.$executeRaw`UPDATE "computer_jobs" SET "owner_epoch" = "owner_epoch" + 1, "owner_run" = ${input.run}, "lease_version" = "lease_version" + 1, "prepare_claimed_at" = NULL, "owner_lease_until" = ${leaseUntil(now)} WHERE "id" = ${jobId}`;
      await revokeJobTokens(jobId, now, undefined, tx);
      return { ok: true as const, epoch: job.ownerEpoch + 1 };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

/**
 * The owner says it is still there (every 30 s, in every state it holds the job: running, waiting, between turns), so nobody else may claim it. Epoch-conditional: a worker that was replaced renews nothing
 * (`superseded`), and a job that is over has nothing to hold. A successful renewal or admitted model call holds it too, in their own writes, so a busy runner rarely needs this.
 */
export async function beatJob(jobId: string, now: Date = new Date(), owner: { epoch?: EpochSaid } = {}): Promise<{ ok: true; until: Date; /** False: the owner is the owner, but no hold stands (it was let go, or lapsed): nothing was written. */ held?: boolean } | { ok: false; reason: 'over' | 'not_found' } | typeof SUPERSEDED> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, ownerEpoch: true } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (isOver(job.status) || job.status === 'queued') return { ok: false, reason: 'over' };
  const until = leaseUntil(now);
  // Extends a hold that exists and ends sooner (never backwards, never out of nothing: a hold that was let go stays let go; CodeRabbit on #1025). Done in the statement that checks the owner
  const done = await prisma.computerJob.updateMany({ where: { id: jobId, status: { in: ['running', 'waiting'] }, ...ownerWhere(owner.epoch), ownerLeaseUntil: { not: null, lt: until } }, data: { ownerLeaseUntil: until } });
  if (done.count === 1) return { ok: true, until };
  // Nothing was written: tell why. The owner of the epoch is still the owner (never `superseded` for a hold that already stands later, or one that was let go); a worker that is not the owner, or a job that ended meanwhile, is told so
  const now_ = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, ownerEpoch: true, ownerLeaseUntil: true } });
  if (!now_) return { ok: false, reason: 'not_found' };
  if (isOver(now_.status) || now_.status === 'queued') return { ok: false, reason: 'over' };
  if (!epochMatches(now_.ownerEpoch, owner.epoch)) return SUPERSEDED;
  return { ok: true, until: now_.ownerLeaseUntil && now_.ownerLeaseUntil > now ? now_.ownerLeaseUntil : now, held: now_.ownerLeaseUntil !== null && now_.ownerLeaseUntil > now };
}

/**
 * The owner lets the job go on purpose (SIGTERM, a rolling deploy, the person taking the machine): the hold ends at once, so a replacement claims it without waiting out the 90 s. Epoch-conditional:
 * a worker that was replaced releases nothing. Ownership itself is NOT given up (the epoch stands, so a late request of this worker is still refused); only the hold that kept others out.
 */
export async function releaseJob(jobId: string, owner: { epoch?: EpochSaid } = {}): Promise<{ ok: boolean } | typeof SUPERSEDED> {
  const done = await prisma.computerJob.updateMany({ where: { id: jobId, ...ownerWhere(owner.epoch) }, data: { ownerLeaseUntil: null } });
  return done.count === 0 ? SUPERSEDED : { ok: true };
}

/** What a runner that committed to ending a job said it will finish with: `outcome` and `run` as the finish will send them, the control generation it was said under and when. */
export interface FinishPending {
  outcome: 'done' | 'failed';
  cause: FinishCause | null;
  run: string | null;
  generation: number | null;
  /** The turns the runner judged failed, and its one sentence about why: what a replacement sends with the finish, exactly. */
  turns: number[];
  why: string | null;
  at: Date;
}
const pendingOf = (intent: { outcome: string; cause: string | null; run: string | null; generation: number | null; turns: number[]; why: string | null; createdAt: Date }): FinishPending => ({
  outcome: intent.outcome === 'done' ? 'done' : 'failed',
  cause: intent.cause === 'ours' || intent.cause === 'agent' ? intent.cause : null,
  run: intent.run,
  generation: intent.generation,
  turns: intent.turns,
  why: intent.why,
  at: intent.createdAt,
});

export interface FinishIntentInput {
  outcome: 'done' | 'failed';
  cause?: FinishCause | null;
  why?: string | null;
  turns?: number[] | null;
  run?: string | null;
  /** The control generation the runner is acting under: an intent from an older one is stale (the person took the machine since). */
  generation?: number | null;
  /** The ownership epoch the runner owns the job by (none = a runner that knows none, good only for a job nobody claimed): an intent from a worker that does not own the job is stale and superseded. */
  epoch?: EpochSaid;
  /** What the stop rests on: `pool` = the runner gives up only because the pool refused its calls. Then a call admitted for its turn (or a later one) of the run answers it stale. */
  basis?: 'pool' | null;
}

/**
 * The runner's committed word that this job is to end, kept BEFORE it gives up (its finish may be lost, or the runner may die with it unsent). In one transaction, under the job's cutoff lock, then the person's give-back lock,
 * then the relay-reach lock (the order used everywhere): the first intent is kept (a second changes nothing and answers the first), and every key of the job ends in the same transaction. From then on no key and no prepare is made for
 * it (`finish_pending`), no call is authorized, a turn is not started, and `getJob` shows `finishPending`, so any runner that sees it completes the finish instead of starting work; a finish that arrives is the normal finish, and one
 * that never does is completed by the sweep (`completeFinishIntents`) through the same `finishJob`. Answers: `{ ok: true, pending, already }`; `{ ok: false, reason: 'stale' }` for a job that is over, was never started, or
 * is on another control generation than the one the runner said, or is owned by another worker (`run: 'superseded'`); `{ ok: false, reason: 'cutoff' }` when Orbit already decided to end it for its own capacity (that decision wins: the job ends as ours, whatever the runner
 * says). Nothing is written in either refusal.
 */
export async function recordFinishIntent(jobId: string, input: FinishIntentInput, now: Date = new Date()): Promise<{ ok: true; pending: FinishPending; already: boolean } | { ok: false; reason: 'not_found' | 'stale' | 'cutoff'; /** Stale because the run was replaced (not the control generation). */ run?: 'superseded' }> {
  const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { personId: true } });
  if (!first) return { ok: false, reason: 'not_found' };
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockCutoff(tx, jobId);
      await lockPerson(tx, first.personId);
      await lockRelayReach(tx, jobId);
      // The job's row is locked from here to the commit: a take-over's bump of the control generation, and a claim's bump of the owner epoch, wait for this transaction, so the generation and the owner read below are the ones the intent is kept under
      const job = await lockJobRow(tx, jobId);
      if (!job) return { ok: false as const, reason: 'not_found' as const };
      // Only a job that is on can be committed to ending: one that is over was finished (or ended) already, one in line never started
      if (job.status !== 'running' && job.status !== 'waiting') return { ok: false as const, reason: 'stale' as const };
      // A word from a worker that does not own the job (another claimed it since, or this one never did) is stale, whatever it rests on: nothing is written, the owner's keys stand
      if (!epochMatches(job.ownerEpoch, input.epoch)) return { ok: false as const, reason: 'stale' as const, run: 'superseded' as const };
      if (input.generation !== undefined && input.generation !== null && input.generation !== job.controlGeneration) return { ok: false as const, reason: 'stale' as const };
      if (await hasPoolCutoff(tx, jobId)) return { ok: false as const, reason: 'cutoff' as const };
      const kept = await tx.computerFinishIntent.findUnique({ where: { jobId } });
      if (kept) return { ok: true as const, pending: pendingOf(kept), already: true };
      // A stop that rests on the pool alone, decided under the same lock as the admission of a call: if a call was admitted for this turn (or a later one) of the run, capacity came back and the work goes on. Nothing is written
      if (input.basis === 'pool' && (await hasTurnAdmitted(tx, jobId, { fromTurn: input.turns && input.turns.length > 0 ? Math.min(...input.turns) : null, run: input.run }))) return { ok: false as const, reason: 'stale' as const };
      const made = await tx.computerFinishIntent.create({
        data: { jobId, outcome: input.outcome, cause: input.outcome === 'failed' ? (input.cause ?? null) : null, why: input.outcome === 'failed' ? (input.why ?? null)?.slice(0, 2000) ?? null : null, turns: input.turns ?? [], run: input.run ?? null, generation: input.generation ?? null, createdAt: now },
      });
      // Every key ends in the same transaction: a call authorized after this commit finds its key dead, and a key made after it is refused
      await revokeJobTokens(jobId, now, undefined, tx);
      return { ok: true as const, pending: pendingOf(made), already: false };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  return outcome;
}

/**
 * Ends a job as its kept intent said, only while Brick has it (checked in the very write that lands the ending: a take-over that wins leaves the intent pending, for a later pass after the hand-back), as of the moment the
 * runner committed (`at`: the wait for this pass is not the person's time). True only when THIS call wrote the ending (two passes that select the same intent never both count it). Safe to say twice.
 */
async function completeIntent(intent: { jobId: string; outcome: string; why: string | null; cause: string | null; turns: number[]; run: string | null }, at: Date, startNextAt?: Date): Promise<boolean> {
  const done = await finishWith(intent.jobId, saidByIntent(intent, at), { brick: true, startNextAt });
  return done.ended;
}

/** How long a finish intent is left for the runner (or a replacement) to send its finish before the sweep completes it. */
export const FINISH_INTENT_GRACE_MS = 2 * 60_000;

/**
 * The sweep's half of the finish intent: a job still on whose runner committed to ending it more than `FINISH_INTENT_GRACE_MS` ago and whose finish never came (the runner died, or its replacement never ran) is finished with what
 * the intent kept, through the same `finishJob` (a runner's finish: judged from the relay's rows, a decided pool cutoff wins, given back or counted as any finish), as of the moment the runner committed (the wait for this
 * pass is not the person's time). A job the person has taken over is left to them (it is theirs, and its Stop ends it). Safe to run twice (a job that is over is left as it is). Returns how many it finished.
 */
export async function completeFinishIntents(now: Date, batch: number): Promise<number> {
  const quiet = new Date(now.getTime() - FINISH_INTENT_GRACE_MS);
  const due = await prisma.computerFinishIntent.findMany({
    where: { createdAt: { lte: quiet }, job: { status: { in: ['running', 'waiting'] }, control: 'brick' } },
    orderBy: { createdAt: 'asc' },
    take: batch,
  });
  let finished = 0;
  for (const intent of due) {
    try {
      if (await completeIntent(intent, intent.createdAt, now)) finished += 1;
    } catch (error) {
      console.error('[Computer] Could not complete a finish the runner committed to:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return finished;
}

/**
 * Whether everything the Brick's computer ran is in the books (audit F08: financial reconciliation, apart from erasure). The jobs go with the
 * Brick, so what they ran is written first (never a loss of money). This reads and writes only our own tables: it does not wait on a
 * provider, a saved copy or any backup. False only when a line could not be written yet; the Brick then waits for the next sweep.
 */
export async function computerTimeInBooks(botId: string, now: Date = new Date()): Promise<boolean> {
  // A job still queued, running or waiting (the delete could not end it: that step never throws) is ended first, and the Brick waits until none is
  // left: a job that is deleted with the Brick before its time is written is time the books never had
  const active = await prisma.computerJob.findMany({ where: { botId, status: { in: ['queued', 'running', 'waiting'] } }, select: { id: true } });
  for (const job of active) await endJob(job.id, 'stopped', 'deleted', now, false, undefined, false).catch((error) => console.error('[Computer] Could not end a job of a Brick being purged:', error instanceof Error ? error.message : 'unknown'));
  if (active.length > 0 && (await prisma.computerJob.count({ where: { botId, status: { in: ['queued', 'running', 'waiting'] } } })) > 0) return false;
  await recordMissingComputerTime(now, SWEEP_BATCH, botId);
  // Read when called: lib/computer-job-controls builds on this module
  await (await import('@/lib/computer-job-controls')).bookMissingPauses(now, SWEEP_BATCH, botId);
  // A pause whose time is not written yet goes with the jobs: the Brick waits for it like for a job's own time
  if ((await prisma.computerJobPause.count({ where: { bookedAt: null, job: { botId } } })) > 0) return false;
  const unwritten = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS "n" FROM "computer_jobs" j
    WHERE j."bot_id" = ${botId} AND j."reservation_key" IS NOT NULL AND j."started_at" IS NOT NULL AND j."status" IN ('done', 'stopped', 'failed') AND j."seconds_run" > 0
      AND NOT EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:' || j."id" || ':time')`);
  if (Number(unwritten[0]?.n ?? 0) !== 0) return false;
  // A give-back still waiting for a decision is decided now (its jobs and fault rows go with the Brick), and never becomes a final charge
  if (!(await decidePendingForPurge(botId, now))) return false;
  // The refunds owed for this Brick's failed jobs are written first (only what is written outlives the jobs)
  await recordRefundObligationsForBrick(botId).catch((error) => console.error('[Computer] Could not keep the refunds a Brick’s jobs owe:', error instanceof Error ? error.message : 'unknown'));
  // A failed job's model calls that are still written against the person (or credit it drew that has not gone back) are not in the books as given back yet (the give-back above never throws, so
  // a write that failed shows here). Once the jobs are gone nothing can find those calls to give them back, so the Brick waits for the next sweep
  const owed = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS "n" FROM "computer_jobs" j
    WHERE j."bot_id" = ${botId} AND (j."status" IN ('failed', 'stopped') AND j."ended_by" IN ('error', 'pool'))
      AND (
        EXISTS (SELECT 1 FROM "meter_events" e WHERE e."source_ref" = 'computer_jobs:' || j."id" AND e."job_id" = j."id" AND e."kind" = 'model_call' AND e."pool" = 'computer' AND e."payer_kind" = 'universe' AND e."person_key" = 'person:' || j."person_id" AND ${CALL_IN_LAST_STRETCH})
        -- ...or the job's own time, written against the person by an end that overlapped the decision that gave the job back (the same condition the repair sweep looks for): once the job is gone nothing can find it to detach it
        OR EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:' || j."id" || ':time' AND e."person_key" = 'person:' || j."person_id")
        -- ...or credit the job drew that has not gone back and that no refund obligation covers yet: an obligation keeps the minimum references to finish the
        -- reimbursement (job, person, hold key, refund key, amount) without the job, so a refund the books cannot take yet never holds the deletion for ever
        OR EXISTS (SELECT 1 FROM "credit_holds" h WHERE h."job_key" = j."id" AND h."category" = 'computers' AND h."state" = 'settled' AND COALESCE(h."customer_micros", 0) > h."refunded_micros" AND ${HOLD_IN_LAST_STRETCH}
          AND NOT EXISTS (SELECT 1 FROM "computer_refund_obligations" o WHERE o."hold_key" = h."hold_key"))
      )`);
  return Number(owed[0]?.n ?? 0) === 0;
}

/**
 * The few steps of the line the job controls (lib/computer-job-controls) use, kept here so they stay the same steps every other path takes. Not for anything else.
 */
export const controlInternals = {
  tryStart: (jobId: string, now: Date, options: { quiet?: boolean } = {}) => tryStart(jobId, now, options),
  startNext,
  cancelAgentTurn,
  restIfUnheld,
  recordComputerTime,
  recordJobVisits,
  /** The person's own ending of ONE job (Cancel): exactly what Stop does for each job, for this one only. */
  endByPerson: (jobId: string, now: Date, options: { advance: boolean; only?: string; /** The job holds the machine: an ending already committed (a kept intent, a decided cutoff) governs instead of the person's stop. */ held?: boolean }) => endJob(jobId, 'stopped', 'person', now, options.advance, options.only, true, null, false, options.held ? { personStop: true } : {}),
};
