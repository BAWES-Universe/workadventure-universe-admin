import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { controlInternals, providerFor } from '@/lib/computer';
import { lockJob } from '@/lib/computer-owner';
import { afterPause, decidePauseIn } from '@/lib/computer-job-controls';
import { pauseWhenRowFree } from '@/lib/computer-power';
import { settlePendingResumesIn } from '@/lib/computer-commands';
import { grantsPrintIn, tellIn } from '@/lib/computer-tellings';
import { getMeterSettings } from '@/lib/meter';
import { roomWouldFit } from '@/lib/meter-allowance';
import { roomFor } from '@/lib/computer-values';

/**
 * Out of the month's computer time, or over a spending limit the person set, in the middle of a job: the job PAUSES and waits, it does not end (piece 3 of the computer job controls; Fable's decisions of 23 Nov,
 * section 1, under Khalid's delegation; Opus's eight rules for "pause instead of end").
 *
 *  - Where: exactly the places that ended a job for `allowance` or `rule` before. A renewal that finds no room (lib/computer `renewJob`, decided inside its own transaction) and a model call refused for it
 *    (`pauseForLimit`, below). The same conditional write under the same locks as that ending (Rule A): the owner's epoch, the refused call's own key still good and the owner's, status running or waiting, no kept
 *    finish intent and no decided pool cutoff (Rule B: those win, and the job ends as they say). A refusal from an old worker or key pauses nothing (E3).
 *  - What it does: what a person's pause does (lib/computer-job-controls): the stretch so far is charged under its own event at its own room's terms, the unused room goes back at once, nothing is held while it
 *    waits, the epoch and lease version move and every key ends, the provider's turn is cancelled after the commit (Rule C). `paused_why` says `allowance` or `rule`. Nothing is given back: a pause is not a fault.
 *  - Our own pool being full is NOT this: it ends the job as ours, given back, exactly as before.
 *  - While the person holds the screen it pauses too (Fable's ruling of 23 Nov, section 7): the screen is taken back in the same write, the pause is marked `heldScreen`, and it never carries on by itself (Brick asks).
 *    In practice a model call is not let through while the person holds the screen (their take over ends the keys), so this is the renewal's case.
 *  - Brick tells the person once, from the same commit (lib/computer-tellings `paused`).
 *
 * Carrying on (`carryOnPaused`, every sweep): when more arrives (extra usage, a top-up, a new month, the person raising their own limit) the oldest job of each person that their month or a limit paused carries on
 * by itself, ONE at a time: a conditional flip (`queued_for = 'paused' AND paused_why IN ('allowance','rule')`, under the job's locks) back into the line, then the normal start with a NEW reservation. Only if
 * nothing about it changed while it waited: no step with an unknown outcome, the Brick's Apps the same as at its pause, its computer still on. Otherwise it stays paused and Brick asks once whether to carry on.
 * A job the person paused themselves never carries on by itself.
 */

export type LimitPaused = 'paused' | 'not';

/**
 * A model call of a running job was refused for the person's month or a limit they set: the job pauses, under the conditions an ending had (above). `from`: the refused call's key and the epoch it was made under
 * (none: a worker that knows no epoch, good only for a job nobody claimed). `not`: nothing changed (another owner, a key that ended, a kept intent or cutoff, a job already paused or over): only the call is
 * refused. It never ends the job (the month and a limit only ever pause). Never throws.
 */
export async function pauseForLimit(jobId: string, why: 'allowance' | 'rule', now: Date = new Date(), from?: { epoch: number; tokenId: string }, blocked?: { kind: 'call' | 'renewal'; micros: number }): Promise<LimitPaused> {
  try {
    const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true } });
    if (!first) return 'not';
    // The provider's price is read before the transaction opens (a read that fails inside it would leave the transaction aborted)
    const provider = providerFor(await prisma.brickComputer.findUnique({ where: { botId: first.botId } }));
    // A take-over leader's stop may hold the computer's row: the pause yields and is tried again once it is free (see `pauseWhenRowFree`)
    const decided = await pauseWhenRowFree(first.botId, now, (clock) => prisma.$transaction((tx) => decidePauseIn(tx, jobId, why, now, provider, { clock, ownerEpoch: from ? from.epoch : 0, key: from?.tokenId, heldOnly: true, heldScreen: true, ...(blocked ? { blocked } : {}) }), { timeout: 15_000, maxWait: 15_000 }));
    if (decided.kind !== 'held') return 'not';
    await afterPause(jobId, decided, now);
    return 'paused';
  } catch (error) {
    console.error('[Computer] Could not pause a job its month or a limit stopped:', error instanceof Error ? error.message : 'unknown');
    // Every try found the computer's row taken (or timed out): the job keeps running and the next refused call tries again, but it is seen (Opus on #1040, F4)
    Sentry.captureException(error, { tags: { area: 'computer', step: 'limit-pause' } });
    return 'not';
  }
}

/** Why a job paused by its month or a limit does not carry on by itself even though more arrived: something about it changed while it waited. Null when it may. */
type Changed = 'unknown_step' | 'apps' | 'computer' | 'held_screen' | null;

/**
 * The sweep's part: for each person, the oldest job their month or a limit paused that now has room carries on by itself (one per person per sweep; the next one in a later sweep, once this one holds its room), or
 * Brick asks about it once when something about it changed. Returns how many carried on. Never throws.
 */
/** Where the last sweep stopped: the next one starts AFTER it, so jobs that still cannot carry on never hold up the ones behind them. Null = from the oldest. */
let scanAfter: { pausedAt: Date; id: string } | null = null;

/** For tests: start the scan again from the oldest paused job. */
export function resetCarryOnScanForTests(): void {
  scanAfter = null;
}

export async function carryOnPaused(now: Date = new Date(), batch = 50): Promise<number> {
  let carried = 0;
  try {
    const page = Math.max(1, batch) * 4;
    // A page of jobs that are still over their limits would be the same page at every sweep, and a newer job whose allowance has recovered would never be looked at. The scan carries a cursor from sweep to sweep
    // (paused-at order, then id) and starts again from the oldest once it has gone past the last one (CodeRabbit on #1025, lib/computer-limit-pause.ts:66)
    const after = scanAfter;
    const paused = await prisma.computerJob.findMany({
      where: {
        status: 'queued',
        queuedFor: 'paused',
        pausedWhy: { in: ['allowance', 'rule'] },
        bot: { deletedAt: null },
        ...(after ? { OR: [{ pausedAt: { gt: after.pausedAt } }, { pausedAt: after.pausedAt, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      take: page,
      select: { id: true, botId: true, personId: true, pausedAt: true },
    });
    const settings = await getMeterSettings();
    const done = new Set<string>();
    let examined: (typeof paused)[number] | undefined;
    for (const job of paused) {
      examined = job;
      if (done.has(job.personId)) continue;
      try {
        const outcome = await carryOnOne(job, settings.renewMinutes, now);
        if (outcome === 'carried' || outcome === 'asked') done.add(job.personId);
        if (outcome === 'carried') carried++;
      } catch (error) {
        console.error('[Computer] Could not carry on a paused job:', error instanceof Error ? error.message : 'unknown');
      }
      if (done.size >= batch) break;
    }
    // The cursor is the last job the loop LOOKED AT: when it stopped early (the batch was full), the jobs after that one are the next sweep's, never skipped. A short page is the end of the list: the next sweep starts again from the oldest
    // (CodeRabbit on #1025, 33)
    scanAfter = paused.length >= page && examined?.pausedAt ? { pausedAt: examined.pausedAt, id: examined.id } : null;
  } catch (error) {
    console.error('[Computer] Could not look for paused jobs to carry on:', error instanceof Error ? error.message : 'unknown');
  }
  return carried;
}

/** One person's oldest paused job, looked at once. `carried`: it was put back in line and tried. `asked`: Brick asks the person first. `waits`: no room yet, or it moved meanwhile. */
async function carryOnOne(job: { id: string; botId: string; personId: string }, renewMinutes: number, now: Date): Promise<'carried' | 'asked' | 'waits'> {
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row || !row.enabled || !provider) return 'waits';
  // More arrived? Read the way the start reads it, taking nothing. Only the person's own money keeps it paused: a line that is busy or a pool that is full is the line's to wait for.
  // Finding 5 (GPT round 6): enough to START is not enough. The pause remembers what was refused: a model call's estimate (it will be asked again first thing) must fit on top of the room to run, or the job
  // would start, meet the same refusal, book another stretch of time and pause again, sweep after sweep. With nothing more arrived, nothing is written at all
  const room = roomFor(renewMinutes, provider.microsPerMinute());
  // The estimate belongs to ONE pause (its number): the flip below carries the job on only while it is still paused by that very pause (CodeRabbit on #1025, 55)
  const funded = await blockedCallMicros(job.id);
  const amountMicros = room + funded.micros;
  const no = await roomWouldFit({ personId: job.personId, amountMicros, botId: job.botId, jobId: job.id }, now);
  if (no && (no.reason === 'allowance' || no.reason === 'rule' || no.reason === 'not_set')) return 'waits';
  const decided = await prisma.$transaction(
    async (tx) => {
      const locked = await lockJob(tx, job.id);
      if (!locked || locked.status !== 'queued') return 'waits' as const;
      const current = await tx.computerJob.findUniqueOrThrow({ where: { id: job.id }, select: { queuedFor: true, pausedWhy: true, pausedAt: true, pauses: true } });
      if (current.queuedFor !== 'paused' || (current.pausedWhy !== 'allowance' && current.pausedWhy !== 'rule')) return 'waits' as const;
      // The estimate above belongs to ONE pause: a job that paused again since is judged by its own pause's estimate on a later sweep, never by this one (no question is asked and nothing is written for it here)
      if (current.pauses !== funded.pauses) return 'waits' as const;
      // Read in this same transaction, with the job locked: anything that changed while it waited
      const changed = await changedSincePause(tx, job.id, job.botId, current.pauses);
      if (changed) {
        // Brick asks once per pause, and only once more time is there to carry on with
        const asked = await tx.computerJobTelling.count({ where: { jobId: job.id, kind: 'can_carry_on', createdAt: { gte: current.pausedAt ?? new Date(0) } } });
        if (asked > 0) return 'waits' as const;
        await tellIn(tx, job.id, 'can_carry_on', null, now);
        return 'asked' as const;
      }
      // A Resume of this job that is still pending (its request stopped before it kept an answer) is settled from the job as it stands, before the flip: the start of this carry-on is never its answer (CodeRabbit on #1025, N1)
      await settlePendingResumesIn(tx, job.id);
      // The flip is conditional: only a job still paused by its month or a limit (never one the person paused) goes back in line, first of its Brick's, as a resume would put it
      const top = await tx.computerJob.aggregate({ where: { botId: job.botId, status: 'queued' }, _max: { queueRank: true } });
      // Finding 5: the flip writes NO telling. `carried_on` is written by the start in the very write that sets the job running (`carry_on_pending`, once); a job still in line after the try is told `back_in_line`
      const flipped = await tx.computerJob.updateMany({
        where: { id: job.id, status: 'queued', queuedFor: 'paused', pausedWhy: { in: ['allowance', 'rule'] }, pauses: funded.pauses },
        data: { queuedFor: 'turn', pausedAt: null, pausedWhy: null, queueRank: (top._max.queueRank ?? 0) + 1, lastTriedAt: null, startDecidedAt: null, leaseVersion: { increment: 1 }, carryOnPending: true },
      });
      if (flipped.count !== 1) return 'waits' as const;
      return 'carried' as const;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  // Through the normal start: a NEW reservation (its key is new with the moment), a new claim by the runner, its own browser back
  if (decided === 'carried') {
    // The telling that says where the job stands is written whether or not the start came back: a start that rejects after the commit leaves the job in line with its mark set, and nothing else would tell (CodeRabbit on #1025, 56)
    try {
      await controlInternals.tryStart(job.id, now);
    } finally {
      await afterCarryOn(job.id, now, funded.pauses);
    }
  }
  return decided;
}

/** The refused model call's estimate the job's last pause remembers (finding 5), or 0: a renewal's own room, a pause of before this, or the person's own pause. */
async function blockedCallMicros(jobId: string): Promise<{ micros: number; pauses: number }> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { pauses: true } });
  if (!job || job.pauses === 0) return { micros: 0, pauses: job?.pauses ?? 0 };
  const last = await prisma.computerJobPause.findUnique({ where: { jobId_n: { jobId, n: job.pauses } }, select: { blockedKind: true, blockedMicros: true } });
  return { micros: last?.blockedKind === 'call' && last.blockedMicros !== null ? Number(last.blockedMicros) : 0, pauses: job.pauses };
}

/**
 * After the start a carry-on made (finding 5): a job that is running was told `carried_on` by that start's own write. A job still in line (another job holds the computer, every computer is busy) is told
 * `back_in_line`, once per pause (by the pause's number: none since that pause was made). One the start put back as paused (its month or limit refused it again) is not carried on: nothing is told and its
 * pending mark is cleared. Never throws.
 */
async function afterCarryOn(jobId: string, now: Date, /** The number of the pause the flip that triggered this carried the job on from: the pending mark is read only while it still belongs to it. */ pause: number): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const row = await lockJob(tx, jobId);
        if (!row) return;
        const job = await tx.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, queuedFor: true, carryOnPending: true, pauses: true } });
        // The pending mark belongs to the pause the flip carried on from: a job that paused again since and was carried on again by a later flip has a mark of THAT pause's, which this call must neither tell nor clear (CodeRabbit on #1025, O1)
        if (job.pauses !== pause) return;
        if (!job.carryOnPending) return;
        if (job.status !== 'queued' || job.queuedFor === 'paused') {
          // Over, or paused again: nothing is carried on. (A running job cleared it in its own start)
          if (job.status !== 'running' && job.status !== 'waiting') await tx.computerJob.update({ where: { id: jobId }, data: { carryOnPending: false } });
          return;
        }
        const pauseRow = job.pauses > 0 ? await tx.computerJobPause.findUnique({ where: { jobId_n: { jobId, n: job.pauses } }, select: { at: true } }) : null;
        const told = await tx.computerJobTelling.count({ where: { jobId, kind: 'back_in_line', createdAt: { gte: pauseRow?.at ?? new Date(0) } } });
        if (told === 0) await tellIn(tx, jobId, 'back_in_line', null, now);
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  } catch (error) {
    console.error('[Computer] Could not tell a carried-on job is back in line:', error instanceof Error ? error.message : 'unknown');
  }
}

/** What changed about a paused job while it waited (read inside the caller's transaction): a step tried with an outcome not known, the Brick's Apps, or its computer being off. */
async function changedSincePause(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], jobId: string, botId: string, pauses: number): Promise<Changed> {
  if ((await tx.computerEffect.count({ where: { jobId, state: 'planned' } })) > 0) return 'unknown_step';
  const computer = await tx.brickComputer.findUnique({ where: { botId }, select: { enabled: true } });
  if (!computer?.enabled) return 'computer';
  // A job that never held the machine has nothing to compare: it carries on as it is. One that did compares with its last pause (a print not known asks first)
  if (pauses > 0) {
    const last = await tx.computerJobPause.findUnique({ where: { jobId_n: { jobId, n: pauses } }, select: { grantsPrint: true, heldScreen: true } });
    // The person was in the middle of their own step when the screen was taken back: like a step whose outcome is not known, it never carries on by itself (section 7)
    if (last?.heldScreen) return 'held_screen';
    if (!last?.grantsPrint || last.grantsPrint !== (await grantsPrintIn(tx, botId))) return 'apps';
  }
  return null;
}

/** Test seam: the telling after a carry-on, for the pause the flip carried the job on from. */
export const afterCarryOnForTests = afterCarryOn;
