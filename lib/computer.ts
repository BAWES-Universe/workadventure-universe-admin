import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { getBrickLimits } from '@/lib/bot-limits';
import { memberAllowance, releaseRoom, renewRoom, reserveRoom, settleRoom, type NoRoom } from '@/lib/meter-allowance';
import { monthOf } from '@/lib/meter-values';
import { getComputerProvider, type ComputerProvider } from '@/lib/computer-provider';
import {
  AFTER_TAKE_OVER,
  HOLDS_MACHINE,
  PERSON_ONLY,
  costOfSeconds,
  isOver,
  roomFor,
  type EffectKind,
  type EndedBy,
  type MachineState,
  type QueuedFor,
  type WaitingFor,
} from '@/lib/computer-values';

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
  files: { bytes: number; savedAt: Date | null };
  /** The day its files came from, after a restore from a backup. */
  restoredFrom: Date | null;
}

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
  effects?: { effectKey: string; kind: string; state: string; evidence: string | null }[];
};

/** What the owner is told about a job. The evidence of an effect is where it went, never what was in it. */
function jobView(row: JobRow): JobView {
  const detailsToFill = (row.effects ?? [])
    .filter((effect) => effect.kind === 'details' && effect.state === 'approved')
    .map((effect) => {
      const [what, where] = (effect.evidence ?? '').split(' → ');
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
    stepLabel: row.stepLabel,
    waitingFor: row.waitingFor as WaitingFor | null,
    control: row.control === 'person' ? 'person' : 'brick',
    ready: row.readyWhat && row.readyWhere ? { what: row.readyWhat, where: row.readyWhere } : null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    detailsToFill,
  };
}

const JOB_INCLUDE = { effects: { select: { effectKey: true, kind: true, state: true, evidence: true } } } as const;

async function brickOf(botId: string, ownerId: string) {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  return bot && ownsBrick(bot, ownerId) ? bot : null;
}

/** The provider for this computer: the server's, when it is the one that holds the machine. A machine of another provider is not reached. */
function providerFor(row: { provider: string } | null): Provider | null {
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
  return { leftFraction: Math.max(0, Math.min(1, state.leftMicros / settings.memberAllowanceMicros)), unlimited: false, endsAt };
}

/** What the owner sees about a Brick's computer. Null when the Brick is not theirs. Reads only: it never makes or wakes anything. */
export async function computerView(botId: string, ownerId: string, now: Date = new Date()): Promise<ComputerView | null> {
  if (!(await brickOf(botId, ownerId))) return null;
  const available = getComputerProvider() !== null;
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const jobs = await prisma.computerJob.findMany({
    where: { botId, status: { in: ['running', 'waiting', 'queued'] } },
    orderBy: { createdAt: 'asc' },
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
    files: { bytes: toNumber(row?.filesBytes), savedAt: row?.filesSavedAt ?? null },
    restoredFrom: row?.restoredFrom ?? null,
  };
}

export type Given = { ok: true; view: ComputerView } | { ok: false; reason: 'not_found' | 'not_open' };

/**
 * "Give Brick a computer": the owner turns it on for their own Brick. No machine is made: that waits for a job that needs one.
 * Asked twice it is the same computer. Nothing here is per person, and nothing the owner does here costs anything.
 */
export async function giveComputer(botId: string, ownerId: string, now: Date = new Date()): Promise<Given> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const provider = getComputerProvider();
  if (!provider) return { ok: false, reason: 'not_open' };
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
    if (row && row.providerRef && provider && row.machine !== 'none' && row.machine !== 'stopped') {
      // Stopping keeps the disk, and the files are saved first so Files can show the last saved copy
      await saveCopy(botId, row.providerRef, provider);
      await provider.stop(row.providerRef).catch((error) => console.error('[Computer] Could not stop a machine:', error instanceof Error ? error.message : 'unknown'));
      await prisma.brickComputer.updateMany({ where: { botId }, data: { machine: 'stopped' } });
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
    return true;
  } catch (error) {
    console.error('[Computer] Could not save a copy of the files:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

// ---------- Jobs ----------

export type Started =
  | { ok: true; job: JobView; restoredFrom: Date | null }
  /** Not the owner's Brick, or not theirs to ask: only the owner starts computer work on their Brick. */
  | { ok: false; reason: 'not_owner' | 'off' | 'not_open' | 'broken_start' }
  /** The meter's controls are not set up yet: a computer does not open before they do. */
  | { ok: false; reason: 'not_set' };

/** Room is asked for once for each try to run a job: room that was released stays closed, so a later try asks under a new key. */
const roomKey = (jobId: string, now: Date) => `computer:job:${jobId}:${now.getTime()}`;

const queueReasonOf = (no: NoRoom): QueuedFor | null => (no.reason === 'allowance' ? 'allowance' : no.reason === 'busy' ? 'busy' : no.reason === 'pool' ? 'pool' : null);

/**
 * Starts a job on a Brick's computer. Only its owner starts work on it. The job is saved first and then tried: if another job
 * is writing it waits its turn, if the person's allowance or our room is used up it waits with its work saved (and the first
 * leads to "Ask for more"), and otherwise it runs and the machine is made or woken, here and nowhere else.
 */
export async function startJob(input: { botId: string; personId: string; title: string; writes?: boolean }, now: Date = new Date()): Promise<Started> {
  const bot = await brickOf(input.botId, input.personId);
  if (!bot) return { ok: false, reason: 'not_owner' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: input.botId } });
  if (!row || !row.enabled) return { ok: false, reason: 'off' };
  if (!providerFor(row)) return { ok: false, reason: 'not_open' };
  const created = await prisma.computerJob.create({
    data: { botId: input.botId, personId: input.personId, title: input.title.trim().slice(0, 200) || 'A job', writes: input.writes !== false },
  });
  const outcome = await tryStart(created.id, now);
  if (outcome === 'not_set') {
    // Controls that are not set up: no job was ever going to run, so none is left behind
    await prisma.computerJob.delete({ where: { id: created.id } });
    return { ok: false, reason: 'not_set' };
  }
  const job = await prisma.computerJob.findUniqueOrThrow({ where: { id: created.id }, include: JOB_INCLUDE });
  if (job.status === 'failed') return { ok: false, reason: 'broken_start' };
  const after = await prisma.brickComputer.findUnique({ where: { botId: input.botId } });
  return { ok: true, job: jobView(job), restoredFrom: job.status === 'running' ? (after?.restoredFrom ?? null) : null };
}

type Tried = 'running' | 'queued' | 'failed' | 'not_set' | 'gone';

/** One try to put a queued job on the machine. Safe to ask again: a job that is no longer queued is left as it is. */
async function tryStart(jobId: string, now: Date): Promise<Tried> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'queued') return job ? (job.status === 'running' ? 'running' : 'gone') : 'gone';
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row || !row.enabled || !provider) {
    await endJob(job.id, 'stopped', 'off', now);
    return 'gone';
  }
  const queue = (queuedFor: QueuedFor) => prisma.computerJob.updateMany({ where: { id: job.id, status: 'queued' }, data: { queuedFor } });

  // The person has the machine: nothing starts under Brick's hands until they hand it back. Nothing is reserved while waiting in line.
  if ((await prisma.computerJob.count({ where: { botId: job.botId, status: 'waiting', control: 'person' } })) > 0) {
    await queue('turn');
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

  const settings = await getMeterSettings();
  const key = roomKey(job.id, now);
  const room = await reserveRoom({ key, personId: job.personId, amountMicros: roomFor(settings.renewMinutes, provider.microsPerMinute()), botId: job.botId, jobId: job.id }, now);
  if (!room.ok) {
    if (room.reason === 'not_set') return 'not_set';
    const reason = queueReasonOf(room);
    if (reason) {
      await queue(reason);
      return 'queued';
    }
    // Room that was held, lapsed and closed: this is another try, not the same room
    await queue('busy');
    return 'queued';
  }

  // Take the writer's place. The database lets only one writing job hold it; a second one arriving at the same moment queues.
  try {
    const claimed = await prisma.computerJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'running', queuedFor: null, reservationKey: key, startedAt: now, stretchStarted: now },
    });
    if (claimed.count === 0) {
      // Two tries in the same millisecond share one room: it is given back only when the job that won did not take it
      const holder = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { reservationKey: true } });
      if (holder?.reservationKey !== key) await releaseRoom({ key }, now);
      return 'gone';
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await releaseRoom({ key }, now);
      await queue('turn');
      return 'queued';
    }
    throw error;
  }

  // The person may have taken over at the same moment: a job that began now joins them rather than run under Brick's hands. Their
  // take over looks again for running jobs after it ends the ones it saw, so one of the two always sees the other.
  if ((await prisma.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: 'waiting', control: 'person' } })) > 0) {
    await prisma.computerJob.updateMany({ where: { id: job.id, status: 'running' }, data: { status: 'waiting', waitingFor: null, control: 'person', stretchStarted: now, readyWhat: null, readyWhere: null } });
  }

  // The Brick may have been deleted after the claim: deletion marks it first, then stops the jobs it can see, so this sees the mark
  const brick = await prisma.bot.findUnique({ where: { id: job.botId }, select: { deletedAt: true } });
  if (!brick || brick.deletedAt !== null) {
    await endJob(job.id, 'stopped', 'deleted', now);
    return 'gone';
  }

  // The machine: made once, here, or woken. A start that breaks leaves the job over, its room given back and the machine "broken".
  try {
    await bringUp(job.botId, provider, now);
  } catch (error) {
    console.error('[Computer] A machine did not start:', error instanceof Error ? error.message : 'unknown');
    // Another job holds this machine (it is waking it, or working on it): its state is theirs, and this failure does not rewrite it.
    // Only when this job was the only one asking is the machine marked, so a failed second start never breaks a machine that works
    // and never resets one that is still being made.
    const others = await prisma.computerJob.count({ where: { botId: job.botId, id: { not: job.id }, status: { in: ['running', 'waiting'] } } });
    if (others === 0) {
      // A machine that was never made is not "broken": it is still just not made, and the next job tries again
      await prisma.brickComputer.updateMany({ where: { botId: job.botId, NOT: { providerRef: null } }, data: { machine: 'broken' } });
      await prisma.brickComputer.updateMany({ where: { botId: job.botId, providerRef: null }, data: { machine: 'none' } });
    }
    // The line does not move on from a start that broke: the jobs behind it stay queued for the next sweep, so one broken start is one
    // failed job and never every job in line failing one after another
    await endJob(job.id, 'failed', 'error', now, false);
    return 'failed';
  }
  // Turned off, deleted or stopped while the machine was being made or woken: the job is over and nobody holds the machine, so it
  // is put to rest at once rather than left awake with no one paying for it
  const after = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true } });
  if (!after || (after.status !== 'running' && after.status !== 'waiting')) {
    await restIfUnheld(job.botId, now);
    return 'gone';
  }
  return 'running';
}

/**
 * Puts the machine of a Brick to rest when no job holds it. The rest is claimed first (working -> resting) so only one caller does it,
 * and a job that starts meanwhile finds a resting machine and wakes it. Returns whether it rested one.
 */
async function restIfUnheld(botId: string, now: Date): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row || !row.providerRef || !provider) return false;
  const holders = () => prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } });
  if ((await holders()) > 0) return false;
  const claim = await prisma.brickComputer.updateMany({ where: { botId, machine: 'working' }, data: { machine: 'resting', restClaimedAt: now } });
  if (claim.count !== 1) return false;
  if ((await holders()) > 0) {
    // A job took its place between the count and the claim: the machine is still working
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting' }, data: { machine: 'working', restClaimedAt: null } });
    return false;
  }
  // Its work is saved before it rests, and a save that failed is not claimed
  await saveCopy(botId, row.providerRef, provider);
  try {
    await provider.rest(row.providerRef);
  } catch (error) {
    console.error('[Computer] Could not rest a machine:', error instanceof Error ? error.message : 'unknown');
    // Still awake: it is "working" again, so the sweep finds it and tries once more
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting' }, data: { machine: 'working', restClaimedAt: null } });
    return false;
  }
  // The rest is done: no longer claimed, so the sweep never mistakes it for one that was left half way
  await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting' }, data: { restClaimedAt: null } });
  if ((await holders()) > 0) {
    // A job started while the machine was resting and its wake may have come before the rest: wake it again, so it works
    await provider.wake(row.providerRef).catch((error) => console.error('[Computer] Could not wake a machine:', error instanceof Error ? error.message : 'unknown'));
    await prisma.brickComputer.updateMany({ where: { botId, machine: 'resting' }, data: { machine: 'working', lastWorkedAt: now, restClaimedAt: null } });
  }
  return true;
}

/**
 * Makes the machine if this Brick has none yet, and wakes it. Asked while it already works, it does nothing more. The making is
 * claimed in one write before the provider is called, so two jobs starting at the same moment make ONE computer, never two.
 */
async function bringUp(botId: string, provider: Provider, now: Date): Promise<void> {
  let row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
  if (row.machine === 'working') return;
  if (!row.providerRef) {
    const claim = await prisma.brickComputer.updateMany({ where: { botId, providerRef: null, machine: 'none' }, data: { machine: 'waking' } });
    if (claim.count === 1) {
      try {
        const info = await provider.create(botId);
        row = await prisma.brickComputer.update({ where: { botId }, data: { providerRef: info.ref, madeAt: now, machine: 'waking' } });
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
  await prisma.brickComputer.update({ where: { botId }, data: { machine: 'working', lastWorkedAt: now, restClaimedAt: null, restoredFrom: restoring ? (row.filesSavedAt ?? now) : null } });
}

/** Progress a running job reports: step n of m. Only the job's own running or waiting state may report it. */
export async function reportProgress(jobId: string, progress: { stepDone: number; stepTotal?: number | null; label?: string | null }): Promise<JobView | null> {
  const stepDone = Math.max(0, Math.trunc(progress.stepDone));
  const stepTotal = progress.stepTotal === null || progress.stepTotal === undefined ? undefined : Math.max(1, Math.trunc(progress.stepTotal));
  await prisma.computerJob.updateMany({
    where: { id: jobId, status: { in: ['running', 'waiting'] } },
    data: { stepDone, ...(stepTotal !== undefined ? { stepTotal } : {}), ...(progress.label !== undefined ? { stepLabel: progress.label === null ? null : progress.label.slice(0, 200) } : {}) },
  });
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return job ? jobView(job) : null;
}

/**
 * A job that keeps running renews its room each stretch. If the allowance or our room is used up, or the room is gone, it saves
 * and stops safely: what it did stays, nothing new starts and no step is cut in half by this call.
 */
export async function renewJob(jobId: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'allowance' | 'pool' | 'closed' | 'over' | 'unanswered' }> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (job && isOver(job.status) && job.endedBy === 'unanswered') return { ok: false, reason: 'unanswered' };
  if (!job || isOver(job.status)) return { ok: false, reason: 'over' };
  // A job in line has no room yet: nothing to renew, and it is not over
  if (job.status === 'queued') return { ok: true };
  if (!job.reservationKey) return { ok: false, reason: 'over' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  const settings = await getMeterSettings();
  const room = await renewRoom({ key: job.reservationKey, moreMicros: roomFor(settings.renewMinutes, provider ? provider.microsPerMinute() : null) }, now);
  if (room.ok) return { ok: true };
  const reason = room.reason === 'allowance' ? 'allowance' : room.reason === 'closed' ? 'closed' : 'pool';
  await endJob(jobId, 'stopped', reason === 'allowance' ? 'allowance' : reason === 'closed' ? 'error' : 'pool', now);
  return { ok: false, reason };
}

/** The job finished: its machine is saved and rests, what it cost is counted, and the next job in line starts. Safe to say twice. */
export async function finishJob(jobId: string, outcome: 'done' | 'failed', now: Date = new Date()): Promise<JobView | null> {
  // A job that never started (still in line) did not finish: it is stopped by the person or starts, never "done"
  const current = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (current && current.status !== 'queued') await endJob(jobId, outcome, outcome === 'failed' ? 'error' : null, now);
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return job ? jobView(job) : null;
}

/** Stop: from the person's tap. The work so far is kept. Null when it is not their Brick. */
export async function stopJobFor(botId: string, ownerId: string, now: Date = new Date()): Promise<ComputerView | null> {
  if (!(await brickOf(botId, ownerId))) return null;
  // Stop ends what is running or waiting for them, and what is in line too (a job waiting for the allowance must not start later)
  // The ones in line end FIRST: ending the running one starts the next in line, and that must not start a job that is about to be stopped
  const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting', 'queued'] } }, select: { id: true, status: true } });
  const inLine = jobs.filter((job) => job.status === 'queued');
  const held = jobs.filter((job) => job.status !== 'queued');
  // Nothing in line may start while this Stop ends everything, so no end of a job in it moves the line
  for (const job of inLine) await endJob(job.id, 'stopped', 'person', now, false);
  for (const job of held) await endJob(job.id, 'stopped', 'person', now, false);
  return computerView(botId, ownerId, now);
}

/**
 * Ends a job once. Whatever it ran is worked out from the seconds the machine was held for it, recorded in the meter's books as
 * one event under the job's id, and its reserved room is settled to that. Then the machine rests if no other job holds it, and
 * the next job in line is tried. A job that is already over is left exactly as it ended.
 */
async function endJob(jobId: string, status: 'done' | 'stopped' | 'failed', endedBy: EndedBy | null, now: Date, advance = true): Promise<void> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job || isOver(job.status)) return;
  const held = job.status === 'running' || job.status === 'waiting';
  const stretch = held && job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
  const seconds = job.secondsRun + stretch;
  const ended = await prisma.computerJob.updateMany({
    where: { id: jobId, status: job.status },
    data: { status, endedBy, endedAt: now, queuedFor: null, waitingFor: null, readyWhat: null, readyWhere: null, control: 'brick', stretchStarted: null, secondsRun: seconds },
  });
  // Someone else ended it between the read and the write: that one counts and settles
  if (ended.count === 0) return;

  try {
    if (job.reservationKey) {
      if (held) {
        // What ran is written to the books first, and a write that fails is written again by the next sweep (same event id, so never twice)
        const cost = await recordComputerTime({ id: job.id, botId: job.botId, personId: job.personId }, seconds, now, { endedBy, status });
        await settleRoom({ key: job.reservationKey, settledMicros: Math.max(1, cost ?? 1) }, now);
      } else {
        await releaseRoom({ key: job.reservationKey }, now);
      }
    }
  } catch (error) {
    // The job is over either way: the machine still rests and the line still moves, and the sweep gives the room back
    console.error('[Computer] Could not settle a job’s room:', error instanceof Error ? error.message : 'unknown');
  }

  if (held) await restIfUnheld(job.botId, now);
  // The turn passes to the next job in line, except while a Stop is ending everything
  if (advance && endedBy !== 'off' && endedBy !== 'deleted') await startNext(job.botId, now);
}

/**
 * Writes what a job ran into the meter's books as one event under the job's id; asked twice it is the same event. Returns the cost
 * it worked out (null when the provider has no price). The write never throws: a failure is logged and the sweep writes it again.
 */
async function recordComputerTime(job: { id: string; botId: string; personId: string }, seconds: number, at: Date, why: { endedBy: EndedBy | null; status: string }): Promise<number | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  const cost = costOfSeconds(seconds, provider ? provider.microsPerMinute() : null);
  await recordMeterEvent({
    eventId: `computer:${job.id}:time`,
    kind: 'computer_time',
    pool: 'computer',
    occurredAt: at,
    personKey: `person:${job.personId}`,
    personId: job.personId,
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
    detail: { endedBy: why.endedBy, status: why.status },
  }).catch((error) => console.error('[Computer] Could not record computer time:', error instanceof Error ? error.message : 'unknown'));
  return cost;
}

/** The oldest job in line for this Brick's computer gets its turn. */
async function startNext(botId: string, now: Date): Promise<void> {
  const next = await prisma.computerJob.findFirst({ where: { botId, status: 'queued' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
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
async function recordMissingComputerTime(now: Date, batch: number): Promise<void> {
  const cutoff = new Date(now.getTime() - 60 * 1000);
  const ended = await prisma.$queryRaw<Array<{ id: string; botId: string; personId: string; secondsRun: number; status: string; endedBy: string | null; endedAt: Date | null }>>(Prisma.sql`
    SELECT j."id", j."bot_id" AS "botId", j."person_id" AS "personId", j."seconds_run" AS "secondsRun", j."status", j."ended_by" AS "endedBy", j."ended_at" AS "endedAt"
    FROM "computer_jobs" j
    WHERE j."reservation_key" IS NOT NULL AND j."started_at" IS NOT NULL AND j."status" IN ('done', 'stopped', 'failed') AND j."seconds_run" > 0 AND j."ended_at" <= ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:' || j."id" || ':time')
    ORDER BY j."ended_at" ASC
    LIMIT ${batch}`);
  for (const job of ended) {
    await recordComputerTime(job, job.secondsRun, job.endedAt ?? now, { endedBy: job.endedBy as EndedBy | null, status: job.status });
  }
}

/**
 * A sweep, asked by the bot server now and then: a running job that stopped renewing its room is stopped safely (its room is
 * settled to what ran, never left holding the envelope), room that nobody holds a job for is given back, and jobs in line are tried
 * again (the person's month turned, extra usage was given, another job ended). Safe to run twice at once.
 */
export async function sweepComputers(now: Date = new Date(), batch: number = SWEEP_BATCH, pages: number = SWEEP_PAGES): Promise<{ stopped: number; released: number; started: number }> {
  let stopped = 0;
  let released = 0;
  let started = 0;
  // A job that asked its person to take over and got no answer within the wait a super admin set ends, so it does not hold the
  // machine and the allowance for nobody. Read each sweep, so a changed setting counts at once, jobs already waiting included. Once the
  // person has taken over the job is theirs and is not ended here.
  const { computerWait } = await getBrickLimits();
  const unanswered = await prisma.computerJob.findMany({ where: { status: 'waiting', control: 'brick', stretchStarted: { lte: new Date(now.getTime() - computerWait * 60 * 1000) } }, select: { id: true }, orderBy: { stretchStarted: 'asc' }, take: batch });
  for (const job of unanswered) {
    await endJob(job.id, 'stopped', 'unanswered', now);
    stopped++;
  }
  // A job waiting for its person (it asked them to take over, or they did) is not one that went quiet: the worker renews nothing
  // while it waits, so the sweep renews the room for them, a little before it would lapse. If the allowance cannot give more, the job still stops safely.
  const soon = await prisma.meterReservation.findMany({
    where: { state: 'held', expiresAt: { gt: now, lte: new Date(now.getTime() + PERSON_RENEW_AHEAD_MS) }, jobId: { not: null }, reservationKey: { startsWith: 'computer:job:' } },
    take: 200,
  });
  for (const reservation of soon) {
    const job = reservation.jobId ? await prisma.computerJob.findUnique({ where: { id: reservation.jobId } }) : null;
    if (job && job.status === 'waiting' && job.reservationKey === reservation.reservationKey) await renewJob(job.id, now);
  }
  const lapsed = await prisma.meterReservation.findMany({ where: { state: 'held', expiresAt: { lte: now }, jobId: { not: null }, reservationKey: { startsWith: 'computer:job:' } }, take: 200 });
  for (const reservation of lapsed) {
    const job = reservation.jobId ? await prisma.computerJob.findUnique({ where: { id: reservation.jobId } }) : null;
    if (job && !isOver(job.status) && HOLDS_MACHINE.includes(job.status as never)) {
      await endJob(job.id, 'stopped', 'error', now);
      stopped++;
    } else {
      await releaseRoom({ key: reservation.reservationKey }, now);
      released++;
    }
  }
  // A machine that was being made when its job died, and never got a reference: nothing was made, so it can be tried again
  await prisma.brickComputer.updateMany({ where: { machine: 'waking', providerRef: null, updatedAt: { lte: new Date(now.getTime() - 5 * 60 * 1000) } }, data: { machine: 'none' } });
  // A machine that works while no job holds it (a stop that broke half way, a start that finished after a turn off) is put to rest
  // A rest that was claimed and never finished (the server stopped half way) is not left claimed: with no job holding it, it goes back to "working" and the next sweep rests it
  const stuck = await prisma.brickComputer.findMany({ where: { machine: 'resting', NOT: { providerRef: null }, restClaimedAt: { lte: new Date(now.getTime() - 5 * 60 * 1000) } }, select: { botId: true }, take: 200 });
  for (const machine of stuck) {
    if ((await prisma.computerJob.count({ where: { botId: machine.botId, status: { in: ['running', 'waiting'] } } })) === 0) {
      await prisma.brickComputer.updateMany({ where: { botId: machine.botId, machine: 'resting' }, data: { machine: 'working', restClaimedAt: null } });
    }
  }
  const idle = await prisma.brickComputer.findMany({ where: { machine: 'working', NOT: { providerRef: null }, updatedAt: { lte: new Date(now.getTime() - 2 * 60 * 1000) } }, select: { botId: true }, take: 200 });
  for (const machine of idle) await restIfUnheld(machine.botId, now);
  // What a job ran whose write to the books failed is written again (same event id, so never twice)
  await recordMissingComputerTime(now, batch);
  // One try per Brick: the oldest job in line has the turn. Bricks tried and blocked are skipped by the next page, so a long run of
  // blocked Bricks never keeps the ones behind them from their turn.
  const tried: string[] = [];
  for (let page = 0; page < pages; page++) {
    // The oldest job of each Brick has its turn, and the Brick tried longest ago goes first: one that stays blocked is marked tried
    // and goes behind the others, so across sweeps every Brick in line gets its try however many are stuck in front
    const lines = await prisma.$queryRaw<Array<{ id: string; botId: string }>>(Prisma.sql`
      SELECT "id", "bot_id" AS "botId" FROM (
        SELECT DISTINCT ON ("bot_id") "id", "bot_id", "created_at", "last_tried_at"
        FROM "computer_jobs" WHERE "status" = 'queued'
        ORDER BY "bot_id", "created_at" ASC, "id" ASC
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
  return { stopped, released, started };
}

// ---------- Watching, taking over and handing back ----------

export type Watched = { ok: true; url: string; expiresAt: Date } | { ok: false; reason: 'not_found' | 'resting' };

/**
 * Watch: the screen of a computer that is working. It only looks. A computer that rests, a job that is over, an old link, a
 * refresh or a reconnect cause no wake: with nothing to look at, the answer is "resting" and nothing was called to start it.
 */
export async function watchComputer(botId: string, ownerId: string): Promise<Watched> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  const provider = providerFor(row);
  if (!row || !row.enabled || !provider || !row.providerRef || row.machine !== 'working') return { ok: false, reason: 'resting' };
  const holding = await prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } });
  if (holding === 0) return { ok: false, reason: 'resting' };
  const session = await provider.watch(row.providerRef).catch(() => null);
  return session ? { ok: true, url: session.url, expiresAt: session.expiresAt } : { ok: false, reason: 'resting' };
}

/**
 * The job needs its person: before it sends their details, signs in, uploads, pays or submits. It waits, holding the machine for
 * them, and the person's Take over appears. Asked by the bot server.
 */
export async function requestHandover(jobId: string, waitingFor: WaitingFor, now: Date = new Date(), ready?: { what: string; where: string } | null): Promise<JobView | null> {
  const readyData = waitingFor === 'details' && ready ? { readyWhat: ready.what.trim().slice(0, 150) || null, readyWhere: ready.where.trim().slice(0, 150) || null } : { readyWhat: null, readyWhere: null };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status === 'running') {
    // The stretch so far is counted, and the machine stays awake for them
    const stretch = job.stretchStarted ? Math.max(0, Math.round((now.getTime() - job.stretchStarted.getTime()) / SECOND)) : 0;
    await prisma.computerJob.updateMany({ where: { id: jobId, status: 'running' }, data: { status: 'waiting', waitingFor, control: 'brick', secondsRun: job.secondsRun + stretch, stretchStarted: now, ...readyData } });
  } else if (job.status === 'waiting') {
    await prisma.computerJob.updateMany({ where: { id: jobId, status: 'waiting', control: 'brick' }, data: { waitingFor, ...readyData } });
  }
  const after = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return after ? jobView(after) : null;
}

export type Control = { ok: true; job: JobView } | { ok: false; reason: 'not_found' | 'nothing_waiting' };

/**
 * Take over: the person has the mouse and keyboard. Offered while the job waits for them, and while it works too (the mock lets
 * them step in at any time): a working job then waits for them, its stretch so far counted, the machine staying awake. Their own Brick only.
 */
export async function takeOver(botId: string, ownerId: string, now: Date = new Date()): Promise<Control> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  // The jobs already waiting for the person are theirs first: from here a job that starts sees the person has the machine and waits
  const changed = await prisma.computerJob.updateMany({ where: { botId, status: 'waiting', control: 'brick' }, data: { control: 'person' } });
  // Every job working on the machine is the person's to step in on, the one that writes and any that only read: none is left running
  // under Brick's hands while the person has the keyboard. Asked again until none is left: a job that began while the others were
  // being moved is found by the next look, and one that begins after sees the person's control above.
  let moved = 0;
  for (let round = 0; round < 5; round++) {
    const runningJobs = await prisma.computerJob.findMany({ where: { botId, status: 'running' } });
    if (runningJobs.length === 0) break;
    moved += runningJobs.length;
    for (const running of runningJobs) {
      const stretch = running.stretchStarted ? Math.max(0, Math.round((now.getTime() - running.stretchStarted.getTime()) / SECOND)) : 0;
      await prisma.computerJob.updateMany({
        where: { id: running.id, status: 'running' },
        data: { status: 'waiting', waitingFor: null, control: 'person', secondsRun: running.secondsRun + stretch, stretchStarted: now, readyWhat: null, readyWhere: null },
      });
    }
  }
  const job = await prisma.computerJob.findFirst({ where: { botId, status: 'waiting' }, orderBy: [{ writes: 'desc' }, { createdAt: 'asc' }], include: JOB_INCLUDE });
  // Asked twice it is the same: already theirs is still theirs
  if (!job || (changed.count === 0 && job.control !== 'person' && moved === 0)) return { ok: false, reason: 'nothing_waiting' };
  return { ok: true, job: jobView(job) };
}

/** Hand back: Brick carries on from where the person left it. What they entered is theirs and is not read back by this call. */
export async function handBack(botId: string, ownerId: string): Promise<Control> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  await prisma.computerJob.updateMany({ where: { botId, status: 'waiting', control: 'person' }, data: { status: 'running', control: 'brick', waitingFor: null, readyWhat: null, readyWhere: null } });
  const job = await prisma.computerJob.findFirst({ where: { botId, status: { in: ['running', 'waiting'] } }, include: JOB_INCLUDE });
  if (!job) return { ok: false, reason: 'nothing_waiting' };
  return { ok: true, job: jobView(job) };
}

export type Filling = { ok: true; job: JobView } | { ok: false; reason: 'not_found' | 'not_in_control' | 'nothing_ready' | 'changed' };

/**
 * "Fill in my details": only while the person has taken over, and only for what Brick named it was ready to put in, and where (the
 * person's tap approves exactly that: they can't name something else, and Brick can't fill something it did not name). Paying and
 * submitting are never in it. The bot server reads it from the job, plans it (which claims it once) and settles it.
 */
export async function fillInDetails(botId: string, ownerId: string, shown?: { what: string; where: string } | null): Promise<Filling> {
  if (!(await brickOf(botId, ownerId))) return { ok: false, reason: 'not_found' };
  const job = await prisma.computerJob.findFirst({ where: { botId, status: 'waiting', control: 'person' } });
  if (!job) return { ok: false, reason: 'not_in_control' };
  if (!job.readyWhat || !job.readyWhere) return { ok: false, reason: 'nothing_ready' };
  // The tap approves what the person was looking at, so the screen must say what it showed: a page that sent nothing, or opened before
  // Brick named something new, never approves the new thing.
  if (!shown) return { ok: false, reason: 'changed' };
  const key = `details:${shown.what}:${shown.where}`.slice(0, 255);
  // The check and the approval are one transaction: what Brick named cannot change between them, so the approval is for exactly what was shown
  const approved = await prisma.$transaction(async (tx) => {
    const same = await tx.computerJob.updateMany({ where: { id: job.id, status: 'waiting', control: 'person', readyWhat: shown.what, readyWhere: shown.where }, data: { readyWhat: shown.what } });
    if (same.count === 0) return false;
    await tx.computerEffect.upsert({
      where: { jobId_effectKey: { jobId: job.id, effectKey: key } },
      create: { jobId: job.id, effectKey: key, kind: 'details', state: 'approved', evidence: `${shown.what} → ${shown.where}` },
      update: {},
    });
    // One that was tried and confirmed NOT done is approved again by this tap, so Brick can try it once more; done or still planned stay as they are
    await tx.computerEffect.updateMany({ where: { jobId: job.id, effectKey: key, state: 'failed' }, data: { state: 'approved', settledAt: null } });
    return true;
  });
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
  | { ok: false; reason: 'job_over' | 'not_found' };

/**
 * The job means to do something outside its computer (send, publish, put details in, upload, pay, submit): written BEFORE it is
 * tried, once per key. A retry of the same key finds it: done means nothing to do, planned means the outcome is not known and the
 * job must look it up and settle it, never repeat it. Brick never pays or submits itself, and puts details in or uploads only
 * after the person has taken over and asked it to.
 */
export async function planEffect(jobId: string, input: { key: string; kind: EffectKind; evidence?: string | null }): Promise<Planned> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  // Only a job that holds the machine can mean to do something outside it: one still in line has no room and no machine yet
  if (job.status !== 'running' && job.status !== 'waiting') return { ok: false, reason: 'job_over' };
  const existing = await prisma.computerEffect.findUnique({ where: { jobId_effectKey: { jobId, effectKey: input.key } } });
  if (existing?.state === 'done') return { ok: true, already: 'done', evidence: existing.evidence };
  // Tried before and the outcome is not known: look it up, never repeat it blind
  if (existing?.state === 'planned') return { ok: false, reason: 'look_up', evidence: existing.evidence };
  if (PERSON_ONLY.includes(input.kind)) return { ok: false, reason: 'person_only' };
  if (AFTER_TAKE_OVER.includes(input.kind) && (job.control !== 'person' || job.status !== 'waiting')) return { ok: false, reason: 'hand_over_first' };
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
    const claimed = await prisma.computerEffect.updateMany({ where: { id: existing.id, state: { in: states } }, data: { state: 'planned', settledAt: null } });
    return claimed.count === 1 ? { ok: true, already: false } : { ok: false, reason: 'look_up', evidence: existing.evidence };
  }
  try {
    await prisma.computerEffect.create({ data: { jobId, effectKey: input.key.slice(0, 255), kind: input.kind, state: 'planned', evidence: input.evidence?.slice(0, 500) ?? null } });
  } catch (error) {
    // Two tries at the same moment: the first wrote it, the second finds it and must look up what happened
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { ok: false, reason: 'look_up', evidence: null };
    throw error;
  }
  return { ok: true, already: false };
}

/** What happened to an effect, confirmed: done (with where it went, as proof) or failed (confirmed not done, so it may be tried again). */
export async function settleEffect(jobId: string, key: string, state: 'done' | 'failed', evidence?: string | null): Promise<boolean> {
  const { count } = await prisma.computerEffect.updateMany({
    where: { jobId, effectKey: key, state: 'planned' },
    data: { state, settledAt: new Date(), ...(evidence !== undefined ? { evidence: evidence === null ? null : evidence.slice(0, 500) } : {}) },
  });
  if (count > 0) {
    // What Brick named is put in (or confirmed not): the tap is spent, and the next hand-over names its own
    const effect = await prisma.computerEffect.findUnique({ where: { jobId_effectKey: { jobId, effectKey: key } }, select: { kind: true } });
    if (effect?.kind === 'details') await prisma.computerJob.updateMany({ where: { id: jobId }, data: { readyWhat: null, readyWhere: null } });
  }
  return count > 0;
}

/** The job, for the bot server. Null when it is not there. */
export async function getJob(jobId: string): Promise<(JobView & { botId: string; personId: string }) | null> {
  const row = await prisma.computerJob.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  return row ? { ...jobView(row), botId: row.botId, personId: row.personId } : null;
}

/**
 * When a Brick is removed for good: its machine goes only after its files were saved. A save that did not happen leaves the Brick
 * for the next sweep, and nothing is deleted quietly. True when there is nothing in the way.
 */
export async function removeMachineBeforeDelete(botId: string): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  if (!row || !row.providerRef || row.machine === 'none') return true;
  const provider = providerFor(row);
  if (!provider) return false;
  if (!(await saveCopy(botId, row.providerRef, provider))) return false;
  try {
    await provider.remove(row.providerRef);
  } catch (error) {
    console.error('[Computer] Could not remove a machine:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
  // The machine is gone: say so at once, so a later try (if the Brick's own delete fails) does not save a copy of a machine that is not there
  try {
    await prisma.brickComputer.update({ where: { botId }, data: { providerRef: null, machine: 'none' } });
  } catch (error) {
    console.error('[Computer] A machine was removed but its record was not cleared:', error instanceof Error ? error.message : 'unknown');
  }
  return true;
}
