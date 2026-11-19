import { Prisma } from '@prisma/client';
import { monthOf } from '@/lib/meter-values';

/**
 * What the month's speech Limits (lib/speech-cap.ts) must still hold for speech that is certain to be spent but is not in the books yet,
 * read in the same transaction, under the same lock, as the Limit check, so every use is counted once: as pending here, or as an event in
 * the books, never both and never neither. Two kinds of use:
 *
 * - Voice notes Universe AI hears (`voice_note_turns`): from the moment a note is reserved until its event is written. The event is written
 *   in the same transaction that sets `heard_seconds` (lib/voice-note-turns.ts), so `heard_seconds` being empty is exactly "no event yet".
 *   A note stays reserved after its worker's lease runs out (the lease only says who may run the next step): a late `heard` is still
 *   accepted, so only the note's end frees its seconds: heard (the event takes over), or given back (`released`: nothing was charged). A
 *   hearing that failed with a charge, or was lost, stays counted: nothing says it was free.
 * - Spoken replies admitted for a person (`voice_reply_uses`): the longest a reply may be, from admission until the usage of what was said
 *   has had time to arrive (`REPLY_HOLD_MS`), or the reply is given back (its row is deleted).
 *
 * Every writer that moves seconds between these two states, or admits a new use, takes `lockSpeech` first.
 */
export const SPEECH_LOCK = { maxWait: 5_000, timeout: 15_000 };

/**
 * How long an admitted reply holds its seconds. A reply is spoken within the longest a reply may be, and what was spoken is reported
 * right after; the usage report carries no link to the admission, so the hold ends on time instead (and then the report is in the books).
 */
export const REPLY_HOLD_MS = 10 * 60_000;

/** A note reserved and never started stops counting as one waiting to be heard after this long: it is given back at its next lease or sweep. */
export const NOTE_START_MS = 2 * 60_000;

type Tx = Pick<Prisma.TransactionClient, '$executeRaw' | 'voiceNoteTurn' | 'voiceReplyUse'>;

/** The one lock every speech reservation and every move of pending speech into the books is made under. Held to the end of the transaction. */
export const lockSpeech = (tx: Pick<Prisma.TransactionClient, '$executeRaw'>) => tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('voice-note-reserve'))`);

/** Notes Universe AI hears whose speech is not in the books yet (and not given back). */
export const pendingNotes = (now: Date): Prisma.VoiceNoteTurnWhereInput => ({
  payer: 'universe-ai',
  released: false,
  heardSeconds: null,
  createdAt: { gte: monthOf(now).start },
  OR: [{ state: 'reserved', createdAt: { gt: new Date(now.getTime() - NOTE_START_MS) } }, { state: { in: ['hearing', 'uncertain', 'failed'] } }],
});

/**
 * Seconds held for everyone (`all`) and for one person (`mine`, by their key). Each admitted reply holds what it was admitted for (its own
 * `seconds`, so changing the setting later changes nothing already admitted); `replySeconds` is only what a row from before that was kept holds.
 * Call it under `lockSpeech`, in the transaction that goes on to check the Limit.
 */
export async function speechReserved(tx: Tx, input: { personKey: string | null; replySeconds: number; now: Date }): Promise<{ all: number; mine: number }> {
  const { now, personKey, replySeconds } = input;
  const notes = pendingNotes(now);
  const replies: Prisma.VoiceReplyUseWhereInput = { createdAt: { gt: new Date(now.getTime() - REPLY_HOLD_MS), gte: monthOf(now).start } };
  const held = async (where: Prisma.VoiceReplyUseWhereInput) => {
    const [kept, unkept] = await Promise.all([tx.voiceReplyUse.aggregate({ _sum: { seconds: true }, where }), tx.voiceReplyUse.count({ where: { ...where, seconds: null } })]);
    return (kept._sum.seconds ?? 0) + unkept * replySeconds;
  };
  const [allNotes, myNotes, allReplies, myReplies] = await Promise.all([
    tx.voiceNoteTurn.aggregate({ _sum: { seconds: true }, where: notes }),
    personKey ? tx.voiceNoteTurn.aggregate({ _sum: { seconds: true }, where: { ...notes, personKey } }) : null,
    held(replies),
    personKey ? held({ ...replies, personKey }) : 0,
  ]);
  return {
    all: (allNotes._sum.seconds ?? 0) + allReplies,
    mine: (myNotes?._sum.seconds ?? 0) + myReplies,
  };
}
