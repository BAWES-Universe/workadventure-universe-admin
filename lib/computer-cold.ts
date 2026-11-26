import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { storageMonthMicros } from '@/lib/meter-allowance';
import { recordKeptBytes } from '@/lib/computer-disk';
import { recordPowerOpIn, rowLockWait, underPowerOp } from '@/lib/computer-power';
import { COLD_RUN_MAX_MS, NOT_PAUSED, costOfSeconds } from '@/lib/computer-values';
import type { ComputerProvider, MachineInfo, PackInventory, RestoreResult } from '@/lib/computer-provider';
import { readOutsideManifest, type OutsideManifest } from '@/lib/computer-outside';
import {
  archiveById,
  archiveBytes,
  deleteAllArchives,
  removeStrayCopies,
  STORAGE_DELETION_ALERT_MS,
  storageDeletionsWaiting,
  downloadUrl,
  markVerified,
  mintDownloadToken,
  pruneArchives,
  storeArchive,
  verifiedArchives,
  type ArchiveRow,
} from '@/lib/computer-archives';

/**
 * Cold storage for Brick computers (a Limits setting, `bricks.coldStorageDays`, says how many idle days). A computer nobody has used for that long is
 * packed away: its home folder (and what was added outside it) is copied into our own encrypted, versioned storage, the copy is restored once on a
 * throwaway computer and checked file by file, and only then is the computer deleted and the deletion confirmed. The next job that needs it makes a
 * computer again and restores the newest verified copy; if that fails, the one before it, and the person is told which day their files came from.
 *
 * What keeps it safe, in the order it happens (`packStage`, one write per step, so a stopped server picks up where it was):
 *   claimed   the computer is taken (`machine = packing`); nothing else wakes, rests or deletes it
 *   stored    the copy is written whole (read to its end and checked as a gzip) and its SHA-256 is known
 *   verified  a throwaway computer restored it and every file matched; only now may the computer go
 *   removing  the computer is being deleted; it is not `cold` until the provider says it is gone
 * A job that arrives at any step before `removing` stops the pack-away and gets the computer as it was. Nothing is deleted before the proof.
 * It never throws into the sweep: every failure puts the computer back, is counted, and is tried again later (a day at most apart).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A pack-away or return that has not moved for this long was left by a server that stopped; the sweep picks it up. */
export const STUCK_MS = 45 * MIN;
/** How often a pack-away that is working says it is alive (well inside STUCK_MS), so a long copy or proof is never taken for a stopped server. A test sets `ms`. */
export const heartbeat = { ms: 5 * MIN };
/** The restore drill: one verified copy, restored on a throwaway computer, this often. */
export const DRILL_EVERY_MS = 7 * DAY;
/** A throwaway computer older than this is left over from a run that stopped, and is removed. */
const SCRATCH_MAX_AGE_MS = 2 * HOUR;
/** How many computers one sweep packs away: a first run with many idle computers is spread over sweeps, never one burst of spending. */
export const PACK_PER_SWEEP = 2;
/** The wait for another job that is already bringing this computer back. */
const RETURN_WAIT_MS = 25 * MIN;

type Cold = Required<Pick<ComputerProvider, 'prepack' | 'streamFiles' | 'makeScratch' | 'restoreInto' | 'confirmRemoved' | 'removeScratches'>> & ComputerProvider;

/** The provider as a cold-storage one, or null when it keeps its computers where they are. */
export function coldProvider(provider: ComputerProvider | null): Cold | null {
  if (!provider || !provider.prepack || !provider.streamFiles || !provider.makeScratch || !provider.restoreInto || !provider.confirmRemoved || !provider.removeScratches) return null;
  return provider as Cold;
}

/** A pack-away that ended without removing the computer (it is put back as it was) or a return that could not finish. */
export class ColdError extends Error {
  constructor(message: string, readonly why: 'blocked' | 'no_copy' | 'restore' | 'busy' | 'setup') {
    super(message);
  }
}

const words = (error: unknown) => (error instanceof Error ? error.message : 'unknown').replace(/\s+/g, ' ').slice(0, 180);
const backoffMs = (failures: number) => Math.min(DAY, 30 * MIN * 2 ** Math.min(Math.max(failures, 1) - 1, 6));

// ---------- The time the provider bills that no job holds ----------

/**
 * Runs `work` and writes down how long it took, as awake time that is the Brick's (a pack-away) or the throwaway computer's (a proof, a drill). A return is not written here: the job that asked for it holds the computer while it comes back, so its own time counts it.
 * The daily check of the books counts the first kind so it is not "unbooked time"; both are written to the books as the computer pool's spend.
 */
async function timed<T>(kind: 'pack' | 'drill', botId: string | null, ref: string | null, scratch: boolean, provider: ComputerProvider, work: () => Promise<T>, failedBy?: (result: T) => string | null): Promise<T> {
  const started = new Date();
  const run = await prisma.computerColdRun.create({ data: { kind, botId, machineRef: ref, scratch, startedAt: started } });
  let outcome: 'ok' | 'failed' = 'ok';
  let detail: string | null = null;
  try {
    const result = await work();
    // A work that returns "did not work" (a restore that did not check out) is a failed run too, not only one that throws
    const bad = failedBy ? failedBy(result) : null;
    if (bad !== null) {
      outcome = 'failed';
      detail = bad.replace(/\s+/g, ' ').slice(0, 180);
    }
    return result;
  } catch (error) {
    outcome = 'failed';
    detail = words(error);
    throw error;
  } finally {
    const ended = new Date();
    await closeRun(run.id, { kind, botId, scratch }, provider, started, ended, outcome, detail);
  }
}

/** Writes down how long a run took and what it cost, once: the run's row and its line in the books (the same line is never written twice). */
async function closeRun(id: string, run: { kind: string; botId: string | null; scratch: boolean }, provider: ComputerProvider, started: Date, ended: Date, outcome: 'ok' | 'failed', detail: string | null): Promise<void> {
  const seconds = Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000));
  await prisma.computerColdRun.update({ where: { id }, data: { endedAt: ended, seconds, outcome, detail } }).catch(() => undefined);
  await bookRun(id, run, provider, seconds, ended, outcome);
}

/** The line of a finished run in the books. The same event id is never written twice, so a sweep may write it again whenever it is missing (never throws). */
async function bookRun(id: string, run: { kind: string; botId: string | null; scratch: boolean }, provider: ComputerProvider, seconds: number, ended: Date, outcome: string): Promise<void> {
  const cost = costOfSeconds(seconds, provider.microsPerMinute());
  await recordMeterEvent({
    eventId: `computer:cold:${id}:time`,
    kind: 'computer_time',
    pool: 'computer',
    occurredAt: ended,
    personKey: 'unknown',
    personId: null,
    botId: run.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'computer',
    jobId: null,
    quantity: seconds,
    unit: 'second',
    costMicros: cost,
    basis: cost === null ? 'unknown' : provider.kind === 'real' ? 'measured' : 'estimated',
    sourceRef: `computer_cold_runs:${id}`,
    detail: { kind: run.kind, scratch: run.scratch, outcome },
  }).catch((error) => console.error('[Computer] Could not record cold storage time:', words(error)));
}

/**
 * A run that ended whose line never reached the books (the write failed, or the server stopped between the two writes) is written now, oldest first.
 * The run's own row says how long it took, so nothing is worked out again; a run that ended a moment ago may still be writing its own line, so it is left a minute.
 */
async function bookMissingRuns(provider: ComputerProvider, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 60 * 1000);
  const missing = await prisma.$queryRaw<Array<{ id: string; botId: string | null; kind: string; scratch: boolean; seconds: number; endedAt: Date; outcome: string | null }>>(Prisma.sql`
    SELECT r."id", r."bot_id" AS "botId", r."kind", r."scratch", r."seconds", r."ended_at" AS "endedAt", r."outcome"
    FROM "computer_cold_runs" r
    WHERE r."ended_at" IS NOT NULL AND r."ended_at" <= ${cutoff} AND r."seconds" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "meter_events" e WHERE e."event_id" = 'computer:cold:' || r."id" || ':time')
    ORDER BY r."ended_at" ASC
    LIMIT 50`);
  for (const run of missing) await bookRun(run.id, run, provider, run.seconds, run.endedAt, run.outcome ?? 'failed');
  return missing.length;
}

/**
 * A run whose server stopped before it wrote its end is closed here, at the longest a run may last: its time is booked once, up to that end, and the
 * daily check of the books never counts it as open on every later day.
 */
async function closeInterruptedRuns(provider: ComputerProvider, now: Date): Promise<number> {
  const open = await prisma.computerColdRun.findMany({ where: { endedAt: null, startedAt: { lte: new Date(now.getTime() - COLD_RUN_MAX_MS) } }, take: 50 });
  let closed = 0;
  for (const run of open) {
    const ended = new Date(run.startedAt.getTime() + COLD_RUN_MAX_MS);
    // Only the run that is still open: one that finished since keeps what it wrote
    const took = await prisma.computerColdRun.updateMany({ where: { id: run.id, endedAt: null }, data: { endedAt: ended, seconds: Math.round(COLD_RUN_MAX_MS / 1000), outcome: 'failed', detail: 'stopped before it was written down' } });
    if (took.count !== 1) continue;
    await bookRun(run.id, run, provider, Math.round(COLD_RUN_MAX_MS / 1000), ended, 'failed');
    closed++;
  }
  return closed;
}

/**
 * A computer packed away stops counting as a kept disk in the books when its removal is confirmed. If that line could not be written then, the
 * newest line still counts a disk that is gone, and nothing else would change it while the Brick stays cold: the sweep writes it now, oldest first,
 * and asks again each sweep until the books take it (a level is only written when it changed, so asking twice writes once).
 */
async function settleColdLevels(now: Date): Promise<number> {
  const stale = await prisma.$queryRaw<Array<{ botId: string }>>(Prisma.sql`
    SELECT c."bot_id" AS "botId" FROM "brick_computers" c
    WHERE c."machine" = 'cold' AND c."provider_ref" IS NULL
      AND COALESCE((
        SELECT (e."detail"->>'machineBytes')::bigint FROM "meter_events" e
        WHERE e."kind" = 'stored_bytes' AND e."payer_kind" = 'universe' AND e."bot_id" = c."bot_id"
        ORDER BY e."occurred_at" DESC, e."recorded_at" DESC LIMIT 1), 0) > 0
    LIMIT 50`);
  let written = 0;
  for (const row of stale) {
    // Under the lock of the computer's row and only while it is still packed away: a return that starts meanwhile writes its own disk after this line, never before it
    if (await recordKeptBytes({ botId: row.botId, reason: 'gone', machineBytes: null, copyBytes: await archiveBytes(row.botId), now, onlyWhileCold: true })) written++;
  }
  return written;
}

// ---------- Proof on a throwaway computer ----------

/** The list of what was outside the home folder when the copy was made, as its row kept it (null for a copy made before it was kept, or a row that does not hold exactly one). */
function outsideOf(archive: ArchiveRow): OutsideManifest | null {
  const kept = archive.manifest;
  return readOutsideManifest(typeof kept === 'object' && kept !== null ? (kept as { outside?: unknown }).outside : null);
}

/** Restores one copy on a throwaway computer, checks it, and removes the computer (and says so when it could not). Never leaves the computer behind knowingly. */
async function proveOnScratch(provider: Cold, archive: ArchiveRow, kind: 'pack' | 'drill', botId: string): Promise<RestoreResult> {
  const url = downloadUrl(archive.id);
  if (!url || !archive.sha256) throw new ColdError('The address copies are fetched from is not set', 'setup');
  let scratch: MachineInfo | null = null;
  try {
    return await timed(
      kind,
      botId,
      null,
      true,
      provider,
      async () => {
        scratch = await provider.makeScratch();
        const result = await provider.restoreInto(scratch.ref, { url, token: mintDownloadToken(archive.id, scratch.ref), sha256: archive.sha256 as string, outside: outsideOf(archive) });
        return result;
      },
      (result) => (result.ok ? null : `the restore did not check out (${result.reason ?? 'unknown'})`),
    );
  } finally {
    const made = scratch as MachineInfo | null;
    if (made) {
      try {
        await provider.remove(made.ref);
        if ((await provider.confirmRemoved(made.ref)) !== 'gone') console.error('[Computer] A throwaway computer is still there; it is removed by the next sweep');
      } catch (error) {
        // Left behind: its name says what it is and when it was made, so `removeScratches` finds it
        console.error('[Computer] Could not remove a throwaway computer:', words(error));
      }
    }
  }
}

// ---------- Packing away ----------

type PackRow = Awaited<ReturnType<typeof prisma.brickComputer.findUniqueOrThrow>>;

async function activeJobs(botId: string): Promise<number> {
  return prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } });
}

/** Moves the claim forward and says it is alive; only the holder of the claim (its own id, new at every take-over) can. */
async function advance(botId: string, claimId: string, from: string, to: string, extra: Prisma.BrickComputerUpdateManyMutationInput = {}): Promise<boolean> {
  const moved = await prisma.brickComputer.updateMany({ where: { botId, machine: 'packing', packClaimId: claimId, packStage: from }, data: { packStage: to, packClaimedAt: new Date(), ...extra } });
  return moved.count === 1;
}

/**
 * Records the pack-away's stop with the computer's row locked, and only while the row still says this run holds the pack-away of this machine (`packing`, this provider ref, this claim). A run whose claim was taken over, or whose
 * machine was given up or replaced, between its last write and this one records nothing (null), so it sends nothing: the run that holds the claim now decides what happens to the machine.
 */
async function recordStopWhilePacking(botId: string, ref: string, claimId: string): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const held = await tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} AND "machine" = 'packing' AND "provider_ref" = ${ref} AND "pack_claim_id" = ${claimId} FOR UPDATE`;
    return held.length === 1 ? recordPowerOpIn(tx, botId, ref, 'stop') : null;
  }, rowLockWait());
}

/** Gives the computer back as it was. `awake` leaves it as it is (a job is arriving for it); otherwise it is put to sleep and proved so. */
async function giveUp(botId: string, row: PackRow, why: string, options: { awake: boolean; count: boolean; provider?: Cold; stage?: string; claimId: string }): Promise<'failed' | 'busy'> {
  const previous = row.packPrevious === 'stopped' ? 'stopped' : 'resting';
  const stopRef = !options.awake && row.providerRef && options.provider ? row.providerRef : null;
  // The stop it sends is recorded in the same commit as the give-up (post-0.5.0 B): a job that wakes the machine after this sees the stop open and waits for it
  const given = await prisma.$transaction(async (tx) => {
    const done = await tx.brickComputer.updateMany({
      // Only the run that holds the claim (a run that was taken over changes nothing of the one that took over), and `stage`: a run that only holds
      // an earlier step gives up only while the row is still at that step (another run may be past it)
      where: { botId, machine: 'packing', packClaimId: options.claimId, ...(options.stage ? { packStage: options.stage } : {}) },
      data: { machine: options.awake ? previous : 'stopping', packStage: null, packClaimedAt: null, packClaimId: null, packArchiveId: null, packPrevious: null, ...(options.count ? { packTriedAt: new Date(), packFailures: { increment: 1 } } : {}) },
    });
    return { count: done.count, op: done.count === 1 && stopRef ? await recordPowerOpIn(tx, botId, stopRef, 'stop') : null };
  }, rowLockWait());
  // Not given up here (the claim is someone else's now): nothing is stopped, nothing is reported, the one that holds it goes on
  if (given.count !== 1) return 'busy';
  if (stopRef && given.op && options.provider) {
    // Asleep and proved, as everywhere else: a stop that did not take stays `stopping` and every sweep goes on until it does
    const cold = options.provider;
    const asleep = await underPowerOp(given.op, async (late) => {
      await cold.stop(stopRef).catch(() => late.mayLand());
      return cold.awake(stopRef).then((awake) => !awake).catch(() => false);
    });
    if (asleep) await prisma.brickComputer.updateMany({ where: { botId, providerRef: stopRef, machine: 'stopping' }, data: { machine: 'stopped' } });
  }
  if (options.count) {
    console.error(`[Computer] A computer was not packed away: ${why}`);
    Sentry.captureMessage('A computer could not be packed away', { level: 'warning', tags: { area: 'computer', step: 'cold_pack' }, extra: { botId, why } });
  }
  return 'failed';
}

/** Says the claim is alive every `heartbeat.ms` while `work` runs, only while the row is still at `stage` (the holder of the claim is the one that moves it on). A return says it too (`machine` 'restoring'). */
async function alive<T>(botId: string, claimId: string, stage: string, work: () => Promise<T>, machine: 'packing' | 'restoring' = 'packing'): Promise<T> {
  const timer = setInterval(() => {
    void prisma.brickComputer.updateMany({ where: { botId, machine, packClaimId: claimId, packStage: stage }, data: { packClaimedAt: new Date() } }).catch(() => undefined);
  }, heartbeat.ms);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Takes an idle computer for packing and returns the id of the claim. Null when it is not idle any more (a job, a wake, another sweep took it first). */
async function claim(row: PackRow, now: Date): Promise<string | null> {
  const claimId = randomUUID();
  const claimed = await prisma.brickComputer.updateMany({
    where: { botId: row.botId, machine: row.machine, providerRef: row.providerRef, packStage: null, updatedAt: row.updatedAt },
    data: { machine: 'packing', packStage: 'claimed', packPrevious: row.machine, packClaimedAt: now, packClaimId: claimId },
  });
  if (claimed.count !== 1) return null;
  // A job that started in the same moment keeps the computer
  if ((await activeJobs(row.botId)) > 0) {
    await giveUp(row.botId, { ...row, packPrevious: row.machine }, 'a job started', { awake: true, count: false, claimId });
    return null;
  }
  return claimId;
}

/**
 * Whether this pack-away must stop now: the Brick is purged or its Undo days are over (the final purge needs no copy), or a job is on the computer.
 * A Brick that is deleted and can still be Undone does NOT stop it: the copy is proved first, and only then does the computer go.
 */
async function mustStop(botId: string): Promise<{ why: string; awake: boolean } | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { goneAt: true } });
  if (!bot || (bot.goneAt !== null && bot.goneAt.getTime() <= Date.now())) return { why: 'the Brick is purged', awake: false };
  if ((await activeJobs(botId)) > 0) return { why: 'a job started', awake: true };
  return null;
}

/**
 * Goes through the steps from where `packStage` says. Safe to call again for the same claim (a sweep that found it stuck): each step checks what
 * the one before wrote. Returns 'packed' only when the computer is gone and the provider confirmed it.
 */
async function runPack(botId: string, provider: Cold, claimId: string): Promise<'packed' | 'failed' | 'busy'> {
  let row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
  if (row.machine !== 'packing' || !row.providerRef) return 'failed';
  // Taken over since it was started: the run that holds the claim now goes on, this one touches nothing
  if (row.packClaimId !== claimId) return 'busy';
  const ref = row.providerRef;
  const abort = async (why: string, awake: boolean, count = true) => giveUp(botId, row, why, { awake, count, provider, claimId });
  try {
    // Before the copy is made the pack-away may still be given up for a job or a purge. Once the computer is being removed it is finished, whatever
    // arrived: a job that arrives then finds the Brick cold and brings it back from the copy (it never wakes a machine that is gone)
    if (row.packStage === 'claimed') {
      const stop = await mustStop(botId);
      if (stop) return await abort(stop.why, stop.awake, false);
    }

    if (row.packStage === 'claimed') {
      // Awake, so it can be looked at and its folder read; nothing else is started on it
      await alive(botId, claimId, 'claimed', () => timed('pack', botId, ref, false, provider, async () => {
        await provider.wake(ref);
        const { outside, ...inventory }: PackInventory = await provider.prepack(ref);
        if (inventory.blocked) throw new ColdError(inventory.blocked, 'blocked');
        const stream = await provider.streamFiles(ref);
        // What prepack printed about the files it copied is kept with the copy (`outside`): the restore hands it to finish, which puts back only what matches it
        const archive = await storeArchive(botId, stream, { manifest: { inventory, outside: outside ?? null, from: ref, at: new Date().toISOString() } });
        if (!(await advance(botId, claimId, 'claimed', 'stored', { packArchiveId: archive.id }))) throw new ColdError('The pack-away was taken over', 'busy');
        // The copy is whole: the computer sleeps while it is proved (it only has to exist until the proof passes)
        // Recorded as a power operation like every stop of ours (post-0.5.0 B); a stop that could not be recorded is not sent (the proof does not need the machine asleep)
        // Only while this run still holds the claim: one that lost it between the move to `stored` and this write must not record or send a stop (CodeRabbit on #1040)
        const op = await recordStopWhilePacking(botId, ref, claimId).catch(() => null);
        if (op) await underPowerOp(op, () => provider.stop(ref)).catch((error) => console.error('[Computer] Could not put a computer to sleep during its proof:', words(error)));
      }));
      row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
    }

    if (row.packStage === 'stored') {
      const stop2 = await mustStop(botId);
      if (stop2) return await abort(stop2.why, stop2.awake, false);
      const archive = row.packArchiveId ? await archiveById(row.packArchiveId) : null;
      // The copy is gone or is not whole: start again from the beginning next time. One already marked verified is a proof that passed before a stop
      // that came between marking it and moving the step on: it is not proved again
      if (!archive || (archive.state !== 'stored' && archive.state !== 'verified')) {
        await prisma.brickComputer.updateMany({ where: { botId, machine: 'packing', packClaimId: claimId, packStage: 'stored' }, data: { packStage: 'claimed', packArchiveId: null } });
        return await abort('the stored copy was not found', false);
      }
      if (archive.state === 'stored') {
        const result = await alive(botId, claimId, 'stored', () => proveOnScratch(provider, archive, 'pack', botId));
        if (!result.ok) {
          // Only while this run still holds the step: a proof that ran so long that its claim was taken over must not fail (and so delete) a copy
          // the other run has proved since, with the computer perhaps already gone
          // One statement: the copy fails only while this run still holds the claim at this step, so a run that was taken over cannot fail the copy the new holder is proving
          const failed = await prisma.$executeRaw(Prisma.sql`
            UPDATE "computer_archives" SET "state" = 'failed', "failure" = ${`restore proof failed: ${result.reason ?? 'unknown'}`.slice(0, 200)}
            WHERE "id" = ${archive.id} AND "state" = 'stored'
              AND EXISTS (SELECT 1 FROM "brick_computers" c WHERE c."bot_id" = ${botId} AND c."machine" = 'packing' AND c."pack_stage" = 'stored' AND c."pack_claim_id" = ${claimId})`);
          if (failed !== 1) return 'busy';
          await pruneArchives(botId, null);
          return await giveUp(botId, row, `the copy did not restore cleanly (${result.reason ?? 'unknown'})`, { awake: false, count: true, provider, stage: 'stored', claimId });
        }
        await markVerified(archive.id, result.ms);
      }
      if (!(await advance(botId, claimId, 'stored', 'verified'))) return 'busy';
      row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
    }

    if (row.packStage === 'verified') {
      // The one step that cannot be undone is claimed here, and only when no job is on the computer (checked in the same statement)
      const removing = await prisma.$executeRaw(Prisma.sql`
        UPDATE "brick_computers" SET "pack_stage" = 'removing', "pack_claimed_at" = ${new Date()}
        WHERE "bot_id" = ${botId} AND "machine" = 'packing' AND "pack_stage" = 'verified' AND "pack_claim_id" = ${claimId}
          AND NOT EXISTS (SELECT 1 FROM "computer_jobs" j WHERE j."bot_id" = ${botId} AND j."status" IN ('running', 'waiting'))
          AND EXISTS (SELECT 1 FROM "bots" b WHERE b."id" = ${botId} AND (b."gone_at" IS NULL OR b."gone_at" > ${new Date()}))`);
      if (removing !== 1) {
        const stop3 = await mustStop(botId);
        return await abort(stop3?.why ?? 'the pack-away was taken over', stop3?.awake ?? true, false);
      }
      row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
    }

    if (row.packStage === 'removing') {
      const archive = row.packArchiveId ? await archiveById(row.packArchiveId) : null;
      if (!archive || archive.state !== 'verified') throw new ColdError('The proved copy is missing, the computer is kept', 'no_copy');
      // Says it is alive while the provider removes the computer and says it is gone, so a slow removal is not taken for a stopped server
      await alive(botId, claimId, 'removing', async () => {
        await provider.remove(ref);
        // Gone means the provider no longer lists it; until it says so, the computer is not cold and nothing is claimed
        if ((await provider.confirmRemoved(ref)) !== 'gone') throw new ColdError('The provider still lists the computer', 'busy');
      });
      const now = new Date();
      const cold = await prisma.brickComputer.updateMany({
        where: { botId, machine: 'packing', packStage: 'removing', packClaimId: claimId },
        data: {
          machine: 'cold',
          providerRef: null,
          packedAt: now,
          packStage: null,
          packClaimedAt: null,
          packClaimId: null,
          packArchiveId: null,
          packPrevious: null,
          packFailures: 0,
          packTriedAt: null,
          restClaimedAt: null,
          restoredFrom: null,
          olderCopyUsed: false,
          filesBytes: BigInt(archive.bytes),
          filesSavedAt: archive.createdAt,
        },
      });
      // The claim was taken over while the computer was being removed: the holder of it finishes (every step above is the same again)
      if (cold.count !== 1) return 'busy';
      // The two newest proved copies stay; the plain saved copy is replaced by them
      await pruneArchives(botId, null, now);
      await provider.deleteSavedCopy?.(botId).catch((error) => console.error('[Computer] Could not delete the old saved copy:', words(error)));
      await recordKeptBytes({ botId, reason: 'gone', machineBytes: null, copyBytes: await archiveBytes(botId), now });
      return 'packed';
    }
    return 'failed';
  } catch (error) {
    if (error instanceof ColdError && error.why === 'busy') return 'busy';
    // From `removing` on the computer may already be gone: it stays `packing` at that step and the sweep finishes it, never a half state that looks idle
    const fresh = await prisma.brickComputer.findUnique({ where: { botId }, select: { packStage: true, machine: true } });
    if (fresh?.machine === 'packing' && fresh.packStage === 'removing') {
      console.error('[Computer] A computer is being removed and will be finished by the next sweep:', words(error));
      Sentry.captureException(error, { tags: { area: 'computer', step: 'cold_remove' }, extra: { botId } });
      return 'busy';
    }
    return await abort(words(error), false);
  }
}

/** Packs one idle computer away. Returns whether it is now cold. */
export async function packAway(botId: string, provider: ComputerProvider | null, now: Date = new Date()): Promise<'packed' | 'failed' | 'skipped' | 'busy'> {
  const cold = coldProvider(provider);
  if (!cold) return 'skipped';
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  if (!row || !row.providerRef || row.provider !== cold.kind || (row.machine !== 'resting' && row.machine !== 'stopped') || row.packStage !== null) return 'skipped';
  const claimId = await claim(row, now);
  if (!claimId) return 'skipped';
  return runPack(botId, cold, claimId);
}

// ---------- Coming back ----------

export interface Returned {
  ref: string;
  /** The day the files came from, and whether it was the older copy (the newest one could not be restored). */
  from: Date;
  olderCopyUsed: boolean;
}

/**
 * Whether the computer `ref` of a return that lost its claim now belongs to another return. The provider gives the machine made for a Brick to the next
 * one that asks for it, so the return that replaced a stopped one may hold this very machine: it has recorded it, or it is on its way (claimed, nothing
 * recorded yet). Removing it from the run that lost the claim would delete the replacement's computer. A return that still holds its own claim is never
 * "another", and a Brick that is gone or cold again with no claim leaves the computer to be removed.
 */
async function heldByAnotherReturn(botId: string, claimId: string, ref: string, db: Pick<typeof prisma, 'brickComputer'> = prisma): Promise<boolean> {
  const row = await db.brickComputer.findUnique({ where: { botId }, select: { machine: true, packStage: true, packClaimId: true, providerRef: true } });
  if (!row) return false;
  if (row.machine === 'restoring' && row.packStage === 'returning' && row.packClaimId === claimId) return false;
  return row.providerRef === ref || (row.machine === 'restoring' && row.packStage === 'returning');
}

/**
 * Removes the computer a return made, unless another return holds it, and says which. The look and the removal happen under a lock on the Brick's
 * computer row: every return (and every sweep that takes one over) claims the Brick by writing that row, so none can claim it, and be handed this very
 * machine by the provider, between the look and the removal. It waits until the machine is gone and the provider says so (`confirm`).
 */
async function removeUnlessHeld(cold: Cold, botId: string, claimId: string, ref: string, confirm: boolean): Promise<'removed' | 'held'> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
      if (await heldByAnotherReturn(botId, claimId, ref, tx)) return 'held' as const;
      await cold.remove(ref);
      if (confirm && (await cold.confirmRemoved(ref)) !== 'gone') throw new Error('still listed');
      return 'removed' as const;
    },
    { timeout: 180_000, maxWait: 10_000 },
  );
}

/**
 * Makes a computer again for a cold Brick and puts the newest verified copy on it. If that copy does not restore, the computer is deleted and the
 * one before it is tried on a fresh one. Leaves the Brick `cold` (nothing made, nothing lost) when no copy restores. Returns with the machine
 * `waking` and its reference stored: the caller makes it ready.
 */
export async function bringBackFromCold(botId: string, provider: ComputerProvider, now: Date = new Date()): Promise<Returned> {
  const cold = coldProvider(provider);
  if (!cold) throw new ColdError('This provider cannot bring a computer back from cold storage', 'setup');
  // The return has a claim of its own, like a pack-away: a sweep that takes a stopped return over gives it a new id, and this run then changes nothing
  const claimId = randomUUID();
  const claimed = await prisma.brickComputer.updateMany({ where: { botId, machine: 'cold', providerRef: null }, data: { machine: 'restoring', packStage: 'returning', packClaimedAt: now, packClaimId: claimId, makeTriedAt: now } });
  if (claimed.count !== 1) {
    // Another job is bringing it back: wait for it, then use what it made
    const until = Date.now() + RETURN_WAIT_MS;
    for (;;) {
      const row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
      if (row.packStage !== 'returning') {
        if (row.machine === 'cold') throw new ColdError('The computer could not be brought back yet', 'restore');
        return { ref: row.providerRef as string, from: row.restoredFrom ?? row.filesSavedAt ?? now, olderCopyUsed: row.olderCopyUsed };
      }
      if (Date.now() > until) throw new ColdError('The computer is still being brought back by another job', 'busy');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  // Says it is alive for the whole return (making the computer, fetching and checking the copy, removing one that did not restore), so a slow return is never taken for a stopped server
  return alive(botId, claimId, 'returning', async (): Promise<Returned> => {
    const started = Date.now();
    const giveBack = async (error: ColdError): Promise<never> => {
      await prisma.brickComputer.updateMany({ where: { botId, machine: 'restoring', packStage: 'returning', packClaimId: claimId }, data: { machine: 'cold', packStage: null, packClaimedAt: null } });
      throw error;
    };
    const archives = (await verifiedArchives(botId)).slice(0, 2);
    if (archives.length === 0) return giveBack(new ColdError('No proved copy of this computer is stored', 'no_copy'));
    const url = downloadUrl(archives[0].id);
    if (!url) return giveBack(new ColdError('The address copies are fetched from is not set', 'setup'));
    let lastReason = 'unknown';
    for (let at = 0; at < archives.length; at++) {
      const archive = archives[at];
      let made: MachineInfo;
      try {
        made = await provider.create(botId);
      } catch (error) {
        return giveBack(new ColdError(`A computer could not be made: ${words(error)}`, 'restore'));
      }
      // Written at once, so a server that stops here leaves a reference to find and remove
      const noted = await prisma.brickComputer.updateMany({ where: { botId, machine: 'restoring', packStage: 'returning', packClaimId: claimId }, data: { providerRef: made.ref, madeAt: new Date(), packClaimedAt: new Date() } });
      if (noted.count !== 1) {
        // Taken over while the computer was being made: removed only when no other return can hold it (see heldByAnotherReturn)
        await removeUnlessHeld(cold, botId, claimId, made.ref, false).catch((error) => console.error('[Computer] Could not remove a computer of a return that was taken over:', words(error)));
        throw new ColdError('The return was taken over', 'busy');
      }
      let result: RestoreResult;
      // A throw is the computer's trouble (the current script could not be put on it, it could not be reached), and says nothing about this copy: the return ends here, the computer is removed, and the
      // Brick goes back to cold to be tried again later with the NEWEST copy. Only a result that says the copy did not check out moves on to the older copy
      let threw = false;
      try {
        result = await cold.restoreInto(made.ref, { url: downloadUrl(archive.id) ?? url, token: mintDownloadToken(archive.id, made.ref), sha256: archive.sha256 ?? '', outside: outsideOf(archive) });
      } catch (error) {
        threw = true;
        result = { ok: false, reason: words(error), ms: 0 };
      }
      if (result.ok) {
        const ms = Date.now() - started;
        // Only while this run still holds the claim: one that was taken over (its computer removed meanwhile) must not mark the Brick awake on a computer that is gone
        const done = await prisma.brickComputer.updateMany({
          where: { botId, machine: 'restoring', packStage: 'returning', packClaimId: claimId },
          data: { machine: 'waking', packStage: null, packClaimedAt: null, olderCopyUsed: at > 0, restoredFrom: at > 0 ? archive.createdAt : null, returnedAt: new Date(), returnMs: ms },
        });
        if (done.count !== 1) throw new ColdError('The return was taken over', 'busy');
        if (at > 0) {
          Sentry.captureMessage('A computer came back from the older copy', { level: 'warning', tags: { area: 'computer', step: 'cold_return' }, extra: { botId, newest: archives[0].id, used: archive.id, reason: lastReason } });
        }
        return { ref: made.ref, from: archive.createdAt, olderCopyUsed: at > 0 };
      }
      lastReason = result.reason ?? 'unknown';
      console.error(`[Computer] A copy did not restore (${lastReason})${!threw && at + 1 < archives.length ? '; the older one is tried' : ''}`);
      // A computer with half a restore is never used: it is removed, and the next copy goes on a fresh one. A return that was taken over meanwhile leaves
      // the computer to the one that took over (the provider hands the same machine to the next return for this Brick)
      try {
        if ((await removeUnlessHeld(cold, botId, claimId, made.ref, true)) === 'held') throw new ColdError('The return was taken over', 'busy');
        await prisma.brickComputer.updateMany({ where: { botId, machine: 'restoring', packClaimId: claimId }, data: { providerRef: null } });
      } catch (error) {
        if (error instanceof ColdError) throw error;
        // It cannot be removed now: it stays recorded (stage `returning`), and the sweep removes it and puts the Brick back to cold
        console.error('[Computer] Could not remove a half-restored computer:', words(error));
        throw new ColdError(`The copy did not restore (${lastReason}) and its computer could not be removed yet`, 'restore');
      }
      if (threw) return giveBack(new ColdError(`The computer could not be made ready for the copy (${lastReason})`, 'restore'));
    }
    return giveBack(new ColdError(`No copy restored (${lastReason})`, 'restore'));
  }, 'restoring');
}

/** After a return that went well and a newer plain copy exists, the cold copies are not needed any more. Never throws. */
export async function dropColdCopiesIfNewer(botId: string): Promise<void> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { packedAt: true, returnedAt: true, machine: true } });
    if (!row || !row.returnedAt || row.machine === 'cold' || row.machine === 'packing' || row.machine === 'restoring') return;
    await pruneArchives(botId, null, new Date(), 0);
  } catch (error) {
    console.error('[Computer] Could not drop old cold copies:', words(error));
  }
}

/** Deletes everything of this Brick that cold storage keeps (the Brick is being deleted). Throws when a copy cannot be deleted. */
export async function deleteColdCopies(botId: string): Promise<void> {
  await deleteAllArchives(botId);
}

// ---------- The sweep's part ----------

export interface ColdSweep {
  packed: number;
  failed: number;
  resumed: number;
  recovered: number;
  drilled: 'ok' | 'failed' | null;
}

/**
 * The computers to pack away: first those of Bricks that were deleted and can still be Undone (nobody will use them in the meantime, and the
 * provider bills a disk for each; the computer goes only after a fresh copy passed the restore check), then those idle for more days than the Limit
 * says, oldest first. Computers in backoff after a failed try are left for later.
 */
async function candidates(now: Date, days: number, take: number): Promise<string[]> {
  const deleted = await prisma.brickComputer.findMany({
    where: {
      machine: { in: ['resting', 'stopped'] },
      NOT: { providerRef: null },
      packStage: null,
      bot: { deletedAt: { not: null }, goneAt: { gt: now } },
      OR: [{ packTriedAt: null }, { packTriedAt: { lte: new Date(now.getTime() - backoffMs(1)) } }],
    },
    select: { botId: true, packTriedAt: true, packFailures: true },
    orderBy: [{ packTriedAt: { sort: 'asc', nulls: 'first' } }],
    take,
  });
  const first = deleted.filter((row) => !row.packTriedAt || now.getTime() - row.packTriedAt.getTime() >= backoffMs(row.packFailures)).map((row) => row.botId);
  if (first.length >= take) return first.slice(0, take);
  return [...first, ...(await idleCandidates(now, days, take - first.length, first))];
}

/** The computers idle for more days than the Limit says, oldest first, that are not in backoff after a failed try. */
async function idleCandidates(now: Date, days: number, take: number, skip: string[]): Promise<string[]> {
  const before = new Date(now.getTime() - days * DAY);
  const rows = await prisma.brickComputer.findMany({
    where: {
      machine: { in: ['resting', 'stopped'] },
      NOT: { providerRef: null },
      packStage: null,
      botId: { notIn: skip },
      AND: [{ OR: [{ lastWorkedAt: { lte: before } }, { lastWorkedAt: null, madeAt: { lte: before } }] }, { OR: [{ packTriedAt: null }, { packTriedAt: { lte: new Date(now.getTime() - backoffMs(1)) } }] }],
    },
    select: { botId: true, packTriedAt: true, packFailures: true },
    // Computers never tried come first, then the one tried longest ago: a computer that keeps failing never holds up the ones behind it
    orderBy: [{ packTriedAt: { sort: 'asc', nulls: 'first' } }, { lastWorkedAt: 'asc' }],
    take: take * 5 + 20,
  });
  const idle: string[] = [];
  for (const row of rows) {
    if (row.packTriedAt && now.getTime() - row.packTriedAt.getTime() < backoffMs(row.packFailures)) continue;
    // Anything queued or running, or any job made or ended inside the idle days, means the Brick was used
    // A paused job is not use: it holds nothing and may wait for weeks, and when it is resumed it goes through the line, which brings the computer back
    if ((await prisma.computerJob.count({ where: { botId: row.botId, OR: [{ status: { in: ['running', 'waiting'] } }, { status: 'queued', ...NOT_PAUSED }, { createdAt: { gt: before } }, { endedAt: { gt: before } }] } })) > 0) continue;
    idle.push(row.botId);
    if (idle.length >= take) break;
  }
  return idle;
}

/** Computers a pack-away or a return left half way: picked up where they stopped, or put back. */
async function recover(provider: Cold, now: Date): Promise<{ resumed: number; recovered: number }> {
  let resumed = 0;
  let recovered = 0;
  const stale = new Date(now.getTime() - STUCK_MS);
  for (const row of await prisma.brickComputer.findMany({ where: { machine: 'packing', packClaimedAt: { lte: stale } }, select: { botId: true, packClaimedAt: true }, take: 20 })) {
    // One sweep resumes it: the claim is moved to now with an id of its own, and only the sweep that moved it goes on (the run it took over can no
    // longer change anything: every step it takes names the old id)
    const claimId = randomUUID();
    const took = await prisma.brickComputer.updateMany({ where: { botId: row.botId, machine: 'packing', packClaimedAt: row.packClaimedAt }, data: { packClaimedAt: now, packClaimId: claimId } });
    if (took.count !== 1) continue;
    resumed++;
    await runPack(row.botId, provider, claimId);
  }
  for (const row of await prisma.brickComputer.findMany({ where: { machine: 'restoring', packStage: 'returning', packClaimedAt: { lte: stale } }, select: { botId: true, providerRef: true, packClaimedAt: true }, take: 20 })) {
    // A new claim id: the return that stopped (or is only slow) can change nothing from here on
    const claimId = randomUUID();
    const took = await prisma.brickComputer.updateMany({ where: { botId: row.botId, machine: 'restoring', packStage: 'returning', packClaimedAt: row.packClaimedAt }, data: { packClaimedAt: now, packClaimId: claimId } });
    if (took.count !== 1) continue;
    try {
      // The computer a return was making is half restored: it is removed and the Brick is cold again (the next job brings it back whole)
      if (row.providerRef) {
        await provider.remove(row.providerRef);
        if ((await provider.confirmRemoved(row.providerRef)) !== 'gone') throw new Error('still listed');
      }
      await prisma.brickComputer.updateMany({ where: { botId: row.botId, machine: 'restoring', packStage: 'returning', packClaimId: claimId }, data: { machine: 'cold', providerRef: null, packStage: null, packClaimedAt: null } });
      recovered++;
    } catch (error) {
      console.error('[Computer] Could not clean up after a return that stopped:', words(error));
    }
  }
  return { resumed, recovered };
}

/** One restore drill a week: a random proved copy, restored on a throwaway computer and checked, so a copy that cannot be restored is found before anyone needs it. */
export async function restoreDrill(provider: ComputerProvider | null, now: Date = new Date()): Promise<'ok' | 'failed' | null> {
  const cold = coldProvider(provider);
  if (!cold) return null;
  const last = await prisma.computerColdRun.findFirst({ where: { kind: 'drill', scratch: true }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  if (last && now.getTime() - last.startedAt.getTime() < DRILL_EVERY_MS) return null;
  const count = await prisma.computerArchive.count({ where: { state: 'verified' } });
  if (count === 0) return null;
  const picked = await prisma.computerArchive.findFirst({ where: { state: 'verified' }, orderBy: { generation: 'asc' }, skip: Math.floor(Math.random() * count) });
  if (!picked) return null;
  const archive = (await archiveById(picked.id)) as ArchiveRow;
  try {
    const result = await proveOnScratch(cold, archive, 'drill', archive.botId);
    if (result.ok) return 'ok';
    throw new ColdError(`The drill's restore failed (${result.reason ?? 'unknown'})`, 'restore');
  } catch (error) {
    console.error('[Computer] The weekly restore drill failed:', words(error));
    Sentry.captureMessage('The weekly restore drill failed: a stored copy could not be restored', { level: 'error', tags: { area: 'computer', step: 'cold_drill' }, extra: { archiveId: archive.id, reason: words(error) } });
    return 'failed';
  }
}

let lastScratchSweep = 0;
let lastStraySweep = 0;
let lastDeletionAlert = 0;
/** Said again at most this often: one message per few hours while a deletion stays blocked, not one per sweep. */
const DELETION_ALERT_EVERY_MS = 6 * 60 * MIN;
let stepRunning = false;

/**
 * What a sweep does for cold storage, a little at a time: removes throwaway computers a stopped run left, finishes or puts back what stopped half
 * way, packs the next idle computers away, runs the weekly drill, and cleans old copies. Never throws and takes a bounded number of steps.
 */
export async function coldStep(provider: ComputerProvider | null, now: Date = new Date(), windingDown = false): Promise<ColdSweep> {
  const out: ColdSweep = { packed: 0, failed: 0, resumed: 0, recovered: 0, drilled: null };
  const cold = coldProvider(provider);
  // One step at a time in this process: a sweep that comes while the last one is still packing leaves it alone (claims keep two servers apart)
  if (!cold || stepRunning) return out;
  stepRunning = true;
  try {
    if (now.getTime() - lastScratchSweep > 30 * MIN) {
      lastScratchSweep = now.getTime();
      await cold.removeScratches(SCRATCH_MAX_AGE_MS).catch((error) => console.error('[Computer] Could not clear old throwaway computers:', words(error)));
    }
    const done = await recover(cold, now);
    out.resumed = done.resumed;
    out.recovered = done.recovered;
    await closeInterruptedRuns(cold, now).catch((error) => console.error('[Computer] Could not close cold storage runs that stopped:', words(error)));
    await bookMissingRuns(cold, now).catch((error) => console.error('[Computer] Could not write cold storage time that was missing:', words(error)));
    await settleColdLevels(now).catch((error) => console.error('[Computer] Could not write what a cold computer keeps:', words(error)));
    // Old copies that could not be deleted before, and ones left half written
    for (const row of await prisma.computerArchive.findMany({ where: { state: { in: ['superseded', 'failed', 'staging'] } }, distinct: ['botId'], select: { botId: true }, take: 50 })) {
      await pruneArchives(row.botId, null, now);
    }
    // Copies of a Brick that no longer has a computer record were left by a pack-away that met its Brick's purge: a Brick that is gone keeps nothing
    const orphans = await prisma.$queryRaw<Array<{ bot_id: string }>>(Prisma.sql`SELECT DISTINCT a."bot_id" FROM "computer_archives" a WHERE NOT EXISTS (SELECT 1 FROM "brick_computers" c WHERE c."bot_id" = a."bot_id") LIMIT 50`);
    for (const orphan of orphans) await deleteAllArchives(orphan.bot_id).catch((error) => console.error('[Computer] Could not delete the copies of a purged Brick:', words(error)));
    // Objects no row points at (a write that stopped after a purge took its row) are found by looking at the bucket itself, now and then
    if (now.getTime() - lastStraySweep > 30 * MIN) {
      lastStraySweep = now.getTime();
      await removeStrayCopies(now).catch((error) => console.error('[Computer] Could not look for copies no row points at:', words(error)));
    }
    // A deletion that has waited more than a day is not a slow bucket: it is said, with how many and since when, and again every few hours while it lasts
    const waiting = await storageDeletionsWaiting(now).catch(() => null);
    if (waiting && waiting.ageMs !== null && waiting.ageMs > STORAGE_DELETION_ALERT_MS && now.getTime() - lastDeletionAlert > DELETION_ALERT_EVERY_MS) {
      lastDeletionAlert = now.getTime();
      Sentry.captureMessage('A deletion of stored computer copies has waited more than a day: the bucket may have stopped accepting deletes', {
        level: 'warning',
        tags: { area: 'computer', step: 'storage_deletion_waiting' },
        extra: { waiting: waiting.count, since: waiting.oldestSince?.toISOString(), strayCopiesSince: waiting.strayCopiesSince?.toISOString() ?? null },
      });
    }
    if (windingDown) return out;
    const { coldStorageDays } = await getBrickLimits();
    for (const botId of await candidates(now, coldStorageDays, PACK_PER_SWEEP)) {
      const result = await packAway(botId, cold, now);
      if (result === 'packed') out.packed++;
      else if (result === 'failed') out.failed++;
    }
    out.drilled = await restoreDrill(cold, now);
  } catch (error) {
    console.error('[Computer] Cold storage could not go on:', words(error));
    Sentry.captureException(error, { tags: { area: 'computer', step: 'cold_sweep' } });
  } finally {
    stepRunning = false;
  }
  return out;
}

// ---------- What the team reads ----------

export interface ColdStatus {
  cold: number;
  packing: number;
  failing: number;
  lastDrill: { at: Date; ok: boolean } | null;
  /** The longest return from cold storage measured so far, in milliseconds, and how many returns it is from. Measured, never promised. */
  slowestReturnMs: number | null;
  returns: number;
  /** The bytes of every cold-storage copy kept right now (what the bucket really holds, by real data size), and what keeping them costs a month at the storage Limit (null when that Limit is not set). */
  storedBytes: number;
  storageMonthMicros: number | null;
  /** Seconds a computer was awake for cold storage in the last 30 days: the Brick's own (pack, return) and throwaway ones (proofs, drills). Measured, so the real cost can be read, never guessed. */
  last30Days: { packSeconds: number; returnSeconds: number; scratchSeconds: number; runs: number };
}

export async function coldStatus(now: Date = new Date()): Promise<ColdStatus> {
  const since = new Date(now.getTime() - 30 * DAY);
  const [cold, packing, failing, drill, slowest, returns, stored, runs, settings] = await Promise.all([
    prisma.brickComputer.count({ where: { machine: 'cold' } }),
    prisma.brickComputer.count({ where: { machine: 'packing' } }),
    prisma.brickComputer.count({ where: { packFailures: { gt: 0 }, machine: { in: ['resting', 'stopped'] } } }),
    prisma.computerColdRun.findFirst({ where: { kind: 'drill', scratch: true, outcome: { in: ['ok', 'failed'] } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, outcome: true } }),
    prisma.brickComputer.aggregate({ _max: { returnMs: true } }),
    prisma.brickComputer.count({ where: { returnMs: { not: null } } }),
    prisma.computerArchive.aggregate({ _sum: { bytes: true }, where: { state: { in: ['stored', 'verified', 'superseded'] } } }),
    prisma.computerColdRun.groupBy({ by: ['kind', 'scratch'], _sum: { seconds: true }, _count: { _all: true }, where: { startedAt: { gte: since } } }),
    getMeterSettings().catch(() => null),
  ]);
  const storedBytes = stored._sum.bytes ?? BigInt(0);
  const seconds = (pick: (run: (typeof runs)[number]) => boolean) => runs.filter(pick).reduce((sum, run) => sum + (run._sum.seconds ?? 0), 0);
  return {
    cold,
    packing,
    failing,
    lastDrill: drill ? { at: drill.startedAt, ok: drill.outcome === 'ok' } : null,
    slowestReturnMs: slowest._max.returnMs ?? null,
    returns,
    storedBytes: Number(storedBytes),
    storageMonthMicros: settings && settings.storageMicrosPerGbMonth !== null ? storageMonthMicros(storedBytes, settings) : null,
    last30Days: {
      packSeconds: seconds((run) => run.kind === 'pack' && !run.scratch),
      returnSeconds: seconds((run) => run.kind === 'return' && !run.scratch),
      scratchSeconds: seconds((run) => run.scratch),
      runs: runs.reduce((sum, run) => sum + run._count._all, 0),
    },
  };
}
