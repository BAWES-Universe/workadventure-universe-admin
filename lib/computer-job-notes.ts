import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { computerView, providerFor, type ComputerView } from '@/lib/computer';
import { ownersJob } from '@/lib/computer-job-access';
import { hasFinishIntent, hasPoolCutoff } from '@/lib/computer-faults';
import { epochMatches, lockJob, SUPERSEDED, type EpochSaid } from '@/lib/computer-owner';
import { isOver } from '@/lib/computer-values';
import type { Prisma } from '@prisma/client';
import { claimCommandIn, commandRow, keepOutcome, seenCommand, type Claimed, type Command } from '@/lib/computer-commands';

/**
 * Telling a job something new after it started (computers full plan, piece 2): "use 12 March instead", "skip the hotel", or the answer to the
 * question Brick asked. The person says it in the chat with Brick (Brick's door) or on the panel; the note reaches the agent on the computer within
 * seconds, in the SAME conversation, and the job carries on with the change. Nothing is stopped or started again.
 *
 * Each note gets the job's next sequence number (`computer_jobs.note_seq`), so notes arrive in order and once each: the runner reads the pending ones,
 * gives them to the agent, and says the highest number it gave (`notes-sent`); a retry never repeats a note and a lost answer never drops one.
 *
 * What a note does depends on where the job is, decided under the job's cutoff lock with its row locked (the order used everywhere):
 *  - running, Brick in control: the note is kept, and the turn the agent is on is cancelled so the next turn starts with the note. The ownership
 *    epoch does NOT move: the same worker carries on. The cancel is for the turn read in the write that kept the note (a conditional write on the
 *    owner epoch AND that turn's id), sent to the provider only after the write committed (never under a lock), so a late note can never cancel a
 *    later turn. A turn cancelled for a note is never a failure, a fault, a pool or an allowance refusal: the runner sees the pending note.
 *  - waiting for the person (Brick asked a question, or asked them to step in) and the person has NOT taken the screen: the note is their answer and
 *    reaches the job at once (decisions 23 Nov, 3e). It is kept and the wait ends: the job runs again, its lease version moves (a sweep that picked the
 *    wait from an older look leaves it alone). `delivery` is `answer` for a question, `now` for any other wait.
 *  - the person has the screen: the note is kept and given to the agent when Brick has the job again (after the hand back).
 *  - in line or paused: the note is kept, and given with the job's first turn (or its first turn after resume).
 *  - over: nothing is kept (`over`). Ending (a finish intent kept or a pool cutoff decided): nothing is kept (`ending`), the finaliser owns it.
 *
 * Notes are the person's own words: given to the agent of that job only, shown back to the person alone in the job's Activity, and gone with the job.
 *
 * One note, one number (finding 4, GPT round 6): a note given with a command id (the panel's send, or Brick's tool call) keeps its row under the job's locks in the write that numbers it, with its number, where it went
 * and the one turn it cancels. The same id again answers that and writes nothing: no second number, no second note, no cancel (the turn is cancelled once, by the request that kept the note). A second identical
 * note the person really sends comes with a new id, and is a second note.
 */

/** Where a kept note goes next, so Brick (or the panel) can say it plainly. */
export type NoteDelivery = 'now' | 'answer' | 'after_hand_back' | 'when_it_starts';

export type Noted =
  | { ok: true; view: ComputerView; note: { seq: number; delivery: NoteDelivery } }
  | { ok: false; reason: 'not_found' | 'empty' | 'over' | 'ending' | 'command_reused' };

/** The longest note kept, in characters: the column's width (the same as a job's brief). A longer one is refused at the route, never cut silently there. */
export const NOTE_MAX = 4000;

type Decided =
  | { kind: 'over' }
  | { kind: 'ending' }
  | { kind: 'kept'; seq: number; delivery: NoteDelivery; cancel: { responseId: string } | null }
  | { kind: 'seen'; seen: Exclude<Claimed, { fresh: true }> };

/**
 * The person (the Brick's owner) tells one job of that Brick something new. See the file's comment for what it does in each state. Answers the
 * computer view as it stands after, and the note's number and where it goes next.
 */
export async function addJobNote(botId: string, ownerId: string, jobId: string, text: string, now: Date = new Date(), command?: Command): Promise<Noted> {
  const job = await ownersJob(botId, ownerId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const words = text.trim();
  if (!words) return { ok: false, reason: 'empty' };
  const kept = Array.from(words).slice(0, NOTE_MAX).join('');
  const under = command ? { command, row: commandRow(botId, ownerId, jobId, 'note', { text: kept }) } : null;
  if (under) {
    const seen = await seenCommand(under.command, under.row);
    if (seen) return notedOf(botId, ownerId, seen, now);
  }
  const decided: Decided = await prisma.$transaction(
    async (tx) => {
      const row = await lockJob(tx, jobId);
      if (!row) return { kind: 'over' as const };
      // The command's row after the job's locks: a copy of this note waits for the first, then finds its row (and its number)
      if (under) {
        const claimed = await claimCommandIn(tx, under.command, under.row);
        if (!('fresh' in claimed)) return { kind: 'seen' as const, seen: claimed };
      }
      const out = await noteIn(tx, jobId, row, kept, now);
      if (under) await keepOutcome(tx, under.command, out.kind === 'kept' ? { ok: true, note: { seq: out.seq, delivery: out.delivery } } : { ok: false, reason: out.kind }, { turnResponseId: out.kind === 'kept' ? (out.cancel?.responseId ?? null) : null });
      return out;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  if (decided.kind === 'seen') return notedOf(botId, ownerId, decided.seen, now);
  if (decided.kind === 'over') return { ok: false, reason: 'over' };
  if (decided.kind === 'ending') return { ok: false, reason: 'ending' };
  // After the write, outside any lock, and only for the turn that write read (Rule C)
  if (decided.cancel) await cancelTurnFor(botId, decided.cancel.responseId);
  const view = await computerView(botId, ownerId, now);
  if (!view) return { ok: false, reason: 'not_found' };
  return { ok: true, view, note: { seq: decided.seq, delivery: decided.delivery } };
}

/** A note's command seen before: what it came to (its number and where it went), with the computer as it stands now. Nothing is written and no turn is cancelled. */
async function notedOf(botId: string, ownerId: string, seen: Exclude<Claimed, { fresh: true }>, now: Date): Promise<Noted> {
  if ('reused' in seen) return { ok: false, reason: 'command_reused' };
  const outcome = seen.replay;
  if (outcome && !outcome.ok) return { ok: false, reason: outcome.reason as 'over' | 'ending' };
  const view = await computerView(botId, ownerId, now);
  if (!view) return { ok: false, reason: 'not_found' };
  if (!outcome?.note) return { ok: false, reason: 'over' };
  return { ok: true, view, note: { seq: outcome.note.seq, delivery: outcome.note.delivery as NoteDelivery } };
}

/** The note itself, under the job's locks (see the file's comment). */
async function noteIn(tx: Prisma.TransactionClient, jobId: string, row: NonNullable<Awaited<ReturnType<typeof lockJob>>>, kept: string, now: Date): Promise<Exclude<Decided, { kind: 'seen' }>> {
      if (isOver(row.status)) return { kind: 'over' as const };
      if ((await hasFinishIntent(tx, jobId)) || (await hasPoolCutoff(tx, jobId))) return { kind: 'ending' as const };
      const detail = await tx.computerJob.findUnique({ where: { id: jobId }, select: { waitingFor: true } });
      const numbered = await tx.$queryRaw<Array<{ note_seq: number }>>`UPDATE "computer_jobs" SET "note_seq" = "note_seq" + 1 WHERE "id" = ${jobId} RETURNING "note_seq"`;
      const seq = numbered[0].note_seq;
      await tx.$executeRaw`INSERT INTO "computer_job_notes" ("id", "job_id", "seq", "text", "state", "created_at") VALUES (${randomUUID()}, ${jobId}, ${seq}, ${kept}, 'pending', ${now})`;
      if (row.status === 'running' && row.control === 'brick') {
        if (!row.agentResponseId) return { kind: 'kept' as const, seq, delivery: 'now' as const, cancel: null };
        // The turn to cancel is the one read here, under the lock: the write is conditional on the owner epoch AND that turn, and moves the lease version (never the epoch)
        const marked = await tx.computerJob.updateMany({
          where: { id: jobId, status: 'running', control: 'brick', ownerEpoch: row.ownerEpoch, agentResponseId: row.agentResponseId },
          data: { leaseVersion: { increment: 1 } },
        });
        return { kind: 'kept' as const, seq, delivery: 'now' as const, cancel: marked.count === 1 ? { responseId: row.agentResponseId } : null };
      }
      if (row.status === 'waiting' && row.control === 'brick') {
        // Brick asked the person something (a question, or to step in) and they have not taken the screen: what they said in words is the answer, and it
        // reaches the job at once. The wait ends and Brick carries on with it (the stretch keeps counting from when the wait began, as a hand back does).
        // Brick still never signs in, pays or submits itself: if the step still needs the person, the agent asks again.
        const ended = await tx.computerJob.updateMany({
          where: { id: jobId, status: 'waiting', control: 'brick', leaseVersion: row.leaseVersion },
          data: { status: 'running', waitingFor: null, readyWhat: null, readyWhere: null, leaseVersion: { increment: 1 } },
        });
        const answered = ended.count === 1 ? (detail?.waitingFor === 'answer' ? ('answer' as const) : ('now' as const)) : ('after_hand_back' as const);
        return { kind: 'kept' as const, seq, delivery: answered, cancel: null };
      }
      if (row.status === 'waiting') return { kind: 'kept' as const, seq, delivery: 'after_hand_back' as const, cancel: null };
      return { kind: 'kept' as const, seq, delivery: 'when_it_starts' as const, cancel: null };
}

/** Cancels exactly one turn of the agent on a Brick's machine. Best effort: a turn already over, or a machine that does not answer, is not an error. Never throws. */
async function cancelTurnFor(botId: string, responseId: string): Promise<void> {
  try {
    const row = await prisma.brickComputer.findUnique({ where: { botId } });
    const provider = providerFor(row);
    if (!row?.providerRef || !provider) return;
    await provider.cancelTurn(row.providerRef, responseId);
  } catch (error) {
    console.error('[Computer] Could not cancel a turn for a note:', error instanceof Error ? error.message : 'unknown');
  }
}

/** The notes a job's runner has still to give the agent, in order. */
export async function pendingNotes(jobId: string): Promise<{ seq: number; text: string }[]> {
  return prisma.computerJobNote.findMany({ where: { jobId, state: 'pending' }, orderBy: { seq: 'asc' }, select: { seq: true, text: true } });
}

export type NotesSent = { ok: true; sent: number } | typeof SUPERSEDED | { ok: false; reason: 'over' };

/**
 * The runner gave the agent every pending note up to `through`: those are marked sent, once. Only the job's OWNER may say so (the epoch it won by its
 * claim; none = a worker that knows none, only while the job has none), in ONE conditional write: a worker that was replaced marks nothing, so a note
 * it never delivered is still there for the owner. Saying it twice changes nothing the second time.
 */
export async function notesSent(jobId: string, input: { through: number; epoch?: EpochSaid }, now: Date = new Date()): Promise<NotesSent> {
  const epoch = input.epoch ?? 0;
  const sent = await prisma.$executeRaw`
    UPDATE "computer_job_notes" n SET "state" = 'sent', "sent_at" = ${now}
    WHERE n."job_id" = ${jobId} AND n."state" = 'pending' AND n."seq" <= ${input.through}
      AND EXISTS (SELECT 1 FROM "computer_jobs" j WHERE j."id" = ${jobId} AND j."owner_epoch" = ${epoch} AND j."status" IN ('queued', 'running', 'waiting'))`;
  if (sent > 0) return { ok: true, sent };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, ownerEpoch: true } });
  if (!job || isOver(job.status)) return { ok: false, reason: 'over' };
  if (!epochMatches(job.ownerEpoch, input.epoch)) return SUPERSEDED;
  return { ok: true, sent: 0 };
}
