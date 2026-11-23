import { prisma } from '@/lib/db';
import { controlInternals, providerFor } from '@/lib/computer';
import { lockJob } from '@/lib/computer-owner';
import { afterPause, decidePauseIn } from '@/lib/computer-job-controls';
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
export async function pauseForLimit(jobId: string, why: 'allowance' | 'rule', now: Date = new Date(), from?: { epoch: number; tokenId: string }): Promise<LimitPaused> {
  try {
    const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true } });
    if (!first) return 'not';
    // The provider's price is read before the transaction opens (a read that fails inside it would leave the transaction aborted)
    const provider = providerFor(await prisma.brickComputer.findUnique({ where: { botId: first.botId } }));
    const decided = await prisma.$transaction((tx) => decidePauseIn(tx, jobId, why, now, provider, { ownerEpoch: from ? from.epoch : 0, key: from?.tokenId, heldOnly: true, heldScreen: true }), { timeout: 15_000, maxWait: 15_000 });
    if (decided.kind !== 'held') return 'not';
    await afterPause(jobId, decided, now);
    return 'paused';
  } catch (error) {
    console.error('[Computer] Could not pause a job its month or a limit stopped:', error instanceof Error ? error.message : 'unknown');
    return 'not';
  }
}

/** Why a job paused by its month or a limit does not carry on by itself even though more arrived: something about it changed while it waited. Null when it may. */
type Changed = 'unknown_step' | 'apps' | 'computer' | 'held_screen' | null;

/**
 * The sweep's part: for each person, the oldest job their month or a limit paused that now has room carries on by itself (one per person per sweep; the next one in a later sweep, once this one holds its room), or
 * Brick asks about it once when something about it changed. Returns how many carried on. Never throws.
 */
export async function carryOnPaused(now: Date = new Date(), batch = 50): Promise<number> {
  let carried = 0;
  try {
    const paused = await prisma.computerJob.findMany({
      where: { status: 'queued', queuedFor: 'paused', pausedWhy: { in: ['allowance', 'rule'] }, bot: { deletedAt: null } },
      orderBy: [{ pausedAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, batch) * 4,
      select: { id: true, botId: true, personId: true },
    });
    const settings = await getMeterSettings();
    const done = new Set<string>();
    for (const job of paused) {
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
  // More arrived? Read the way the start reads it, taking nothing. Only the person's own money keeps it paused: a line that is busy or a pool that is full is the line's to wait for
  const no = await roomWouldFit({ personId: job.personId, amountMicros: roomFor(renewMinutes, provider.microsPerMinute()), botId: job.botId, jobId: job.id }, now);
  if (no && (no.reason === 'allowance' || no.reason === 'rule' || no.reason === 'not_set')) return 'waits';
  const decided = await prisma.$transaction(
    async (tx) => {
      const locked = await lockJob(tx, job.id);
      if (!locked || locked.status !== 'queued') return 'waits' as const;
      const current = await tx.computerJob.findUniqueOrThrow({ where: { id: job.id }, select: { queuedFor: true, pausedWhy: true, pausedAt: true, pauses: true } });
      if (current.queuedFor !== 'paused' || (current.pausedWhy !== 'allowance' && current.pausedWhy !== 'rule')) return 'waits' as const;
      // Read in this same transaction, with the job locked: anything that changed while it waited
      const changed = await changedSincePause(tx, job.id, job.botId, current.pauses);
      if (changed) {
        // Brick asks once per pause, and only once more time is there to carry on with
        const asked = await tx.computerJobTelling.count({ where: { jobId: job.id, kind: 'can_carry_on', createdAt: { gte: current.pausedAt ?? new Date(0) } } });
        if (asked > 0) return 'waits' as const;
        await tellIn(tx, job.id, 'can_carry_on', null, now);
        return 'asked' as const;
      }
      // The flip is conditional: only a job still paused by its month or a limit (never one the person paused) goes back in line, first of its Brick's, as a resume would put it
      const top = await tx.computerJob.aggregate({ where: { botId: job.botId, status: 'queued' }, _max: { queueRank: true } });
      const flipped = await tx.computerJob.updateMany({
        where: { id: job.id, status: 'queued', queuedFor: 'paused', pausedWhy: { in: ['allowance', 'rule'] } },
        data: { queuedFor: 'turn', pausedAt: null, pausedWhy: null, queueRank: (top._max.queueRank ?? 0) + 1, lastTriedAt: null, leaseVersion: { increment: 1 } },
      });
      if (flipped.count !== 1) return 'waits' as const;
      await tellIn(tx, job.id, 'carried_on', null, now);
      return 'carried' as const;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  // Through the normal start: a NEW reservation (its key is new with the moment), a new claim by the runner, its own browser back
  if (decided === 'carried') await controlInternals.tryStart(job.id, now);
  return decided;
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
