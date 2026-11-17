import { Prisma } from '@prisma/client';
import { monthOf } from '@/lib/meter-values';
import { getRateCard, microsPerSecond, rateFor, type RateCard } from '@/lib/speech-rates';
import { getSpeechTerms } from '@/lib/speech-terms';

/**
 * What the Speech budget (lib/speech-cap.ts) must still hold for speech that is certain to be spent but is not in the books yet, read in the
 * same transaction, under the same lock, as the check, so every use is counted once: as set aside here, or as an event in the books, never both
 * and never neither. Three kinds, each in seconds for the person's own entitlement and in money for Universe's exposure:
 *
 * - Voice notes Universe AI hears (`voice_note_turns`): from the moment a note is reserved until its event is written. The event is written in
 *   the same transaction that sets `heard_seconds` (lib/voice-note-turns.ts), so `heard_seconds` being empty is exactly "no event yet". A note
 *   stays reserved after its worker's lease runs out; only the note's end frees it: heard (the event takes over), or given back (`released`).
 *   A hearing that failed with a charge, or was lost, stays counted as unknown: nothing says it was free.
 * - Spoken replies (`voice_reply_uses`). A reply admitted by a game that names it on its receipt (contract 2) is set aside from admission until
 *   the receipt with its turn id arrives, or the reply is given back (its row is deleted). NEVER on a timer: past the saved grace with no
 *   receipt it is shown as unknown, and it keeps counting. A reply admitted without that (contract 1, an older game) is set aside for the
 *   saved `legacyHoldSeconds`, because nothing can name it on a receipt.
 * - Live hearing (`voice_hearing_windows`): what a window admitted and the hearing events that name it have not used yet, until the window is
 *   released. Past its length and the grace, with no release, it is unknown and keeps counting.
 *
 * Every writer that moves seconds between these states, or admits a new use, takes `lockSpeech` first.
 */
export const SPEECH_LOCK = { maxWait: 5_000, timeout: 15_000 };

/** A note reserved and never started stops counting as one waiting to be heard after this long: it is given back at its next lease or sweep. */
export const NOTE_START_MS = 2 * 60_000;

type Tx = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw' | 'appSetting'>;

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

export interface SpeechHeld {
  /** Seconds the person's own entitlement counts as set aside (by their key). */
  mineSeconds: number;
  /** Money set aside for speech still within the time it could take, in millionths of a dollar. */
  openMicros: number;
  /** Money counted as unknown: past what it could take, with no receipt. Still counted. */
  unknownMicros: number;
  /** How long until the earliest open hold is expected to end, in seconds (what waiting could free); null when nothing is open. */
  nextEndsInSeconds: number | null;
  /** What each kind holds in money, for the Budget page. */
  parts: { notes: { open: number; unknown: number }; replies: { open: number; unknown: number }; hearing: { open: number; unknown: number } };
}

type Row = { seconds: number | null; open_micros: bigint | null; unknown_micros: bigint | null; next_ends: number | null };

const num = (value: bigint | number | null | undefined) => Number(value ?? 0);

/** Money for rows that were held before holds carried their own money (before the migration): their seconds at the card's rate for any company. */
function perSecondOf(card: RateCard | null, part: 'hearing' | 'speaking'): number {
  const rate = card ? rateFor(card, null, part, false) : null;
  return card && rate ? microsPerSecond(card, rate) : 0;
}

/**
 * What is set aside for everyone, and for one person (by their key), at `now`. Call it under `lockSpeech`, in the transaction that goes on to
 * check the budget. `replySeconds` is the longest a reply may be now, used only for a row from before holds carried their own length.
 */
export async function speechReserved(tx: Tx, input: { personKey: string | null; replySeconds: number; now: Date }): Promise<{ all: SpeechHeld; mine: SpeechHeld }> {
  const { now, personKey, replySeconds } = input;
  const [card, terms] = await Promise.all([getRateCard(tx), getSpeechTerms(tx)]);
  const monthStart = monthOf(now).start;
  const hearingPerSecond = perSecondOf(card, 'hearing');
  const speakingPerSecond = perSecondOf(card, 'speaking');
  // With no saved time a reply from an older game holds nothing past the moment it is asked (the admission itself is stopped without terms)
  const legacyCutoff = new Date(now.getTime() - (terms.legacyHoldSeconds ?? 0) * 1000);
  const grace = terms.receiptGraceSeconds ?? 0;
  const noteCutoff = new Date(now.getTime() - NOTE_START_MS);

  const notes = (who: Prisma.Sql) =>
    tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT COALESCE(SUM("seconds"), 0)::int AS seconds,
             COALESCE(SUM(CASE WHEN "state" NOT IN ('uncertain', 'failed') THEN COALESCE("hold_micros", CEIL("seconds" * ${hearingPerSecond}::float8)::bigint) ELSE 0 END), 0)::bigint AS open_micros,
             COALESCE(SUM(CASE WHEN "state" IN ('uncertain', 'failed') THEN COALESCE("hold_micros", CEIL("seconds" * ${hearingPerSecond}::float8)::bigint) ELSE 0 END), 0)::bigint AS unknown_micros,
             NULL::float8 AS next_ends
      FROM "voice_note_turns"
      WHERE "payer" = 'universe-ai' AND "released" = false AND "heard_seconds" IS NULL AND "created_at" >= ${monthStart}::timestamp
        AND (("state" = 'reserved' AND "created_at" > ${noteCutoff}::timestamp) OR "state" IN ('hearing', 'uncertain', 'failed'))
        ${who}`);

  const replies = (who: Prisma.Sql) =>
    tx.$queryRaw<Row[]>(Prisma.sql`
      WITH held AS (
        SELECT COALESCE("member_seconds", "seconds", ${replySeconds}::int) AS member_seconds,
               COALESCE("hold_micros", CEIL(COALESCE("seconds", ${replySeconds}::int) * ${speakingPerSecond}::float8)::bigint) AS micros,
               ("contract" >= 2 AND "settled_at" IS NULL AND "created_at" + (COALESCE("seconds", ${replySeconds}::int) + ${grace}::int) * INTERVAL '1 second' <= ${now}::timestamp) AS unknown,
               EXTRACT(EPOCH FROM ("created_at" + COALESCE("seconds", ${replySeconds}::int) * INTERVAL '1 second' - ${now}::timestamp)) AS ends_in
        FROM "voice_reply_uses"
        WHERE "created_at" >= ${monthStart}::timestamp
          AND (("contract" >= 2 AND "settled_at" IS NULL) OR ("contract" < 2 AND "created_at" > ${legacyCutoff}::timestamp))
          ${who}
      )
      SELECT COALESCE(SUM(member_seconds), 0)::int AS seconds,
             COALESCE(SUM(CASE WHEN NOT unknown THEN micros ELSE 0 END), 0)::bigint AS open_micros,
             COALESCE(SUM(CASE WHEN unknown THEN micros ELSE 0 END), 0)::bigint AS unknown_micros,
             MIN(CASE WHEN NOT unknown THEN GREATEST(ends_in, 0) END)::float8 AS next_ends
      FROM held`);

  const windows = (who: Prisma.Sql) =>
    tx.$queryRaw<Row[]>(Prisma.sql`
      WITH held AS (
        SELECT GREATEST("admitted_seconds" - "used_seconds", 0) AS seconds,
               CEIL("hold_micros"::numeric * GREATEST("admitted_seconds" - "used_seconds", 0) / GREATEST("admitted_seconds", 1))::bigint AS micros,
               ("created_at" + ("admitted_seconds" + ${grace}::int) * INTERVAL '1 second' <= ${now}::timestamp) AS unknown,
               EXTRACT(EPOCH FROM ("created_at" + "admitted_seconds" * INTERVAL '1 second' - ${now}::timestamp)) AS ends_in
        FROM "voice_hearing_windows"
        WHERE "closed_at" IS NULL AND "created_at" >= ${monthStart}::timestamp
          ${who}
      )
      SELECT COALESCE(SUM(seconds), 0)::int AS seconds,
             COALESCE(SUM(CASE WHEN NOT unknown THEN micros ELSE 0 END), 0)::bigint AS open_micros,
             COALESCE(SUM(CASE WHEN unknown THEN micros ELSE 0 END), 0)::bigint AS unknown_micros,
             MIN(CASE WHEN NOT unknown THEN GREATEST(ends_in, 0) END)::float8 AS next_ends
      FROM held`);

  const everyone = Prisma.empty;
  const one = personKey ? Prisma.sql`AND "person_key" = ${personKey}` : null;
  const [allNotes, allReplies, allWindows, myNotes, myReplies, myWindows] = await Promise.all([
    notes(everyone),
    replies(everyone),
    windows(everyone),
    one ? notes(one) : null,
    one ? replies(one) : null,
    one ? windows(one) : null,
  ]);

  const fold = (n: Row[] | null, r: Row[] | null, w: Row[] | null): SpeechHeld => {
    const [a, b, c] = [n?.[0], r?.[0], w?.[0]];
    const nexts = [b?.next_ends, c?.next_ends].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return {
      mineSeconds: num(a?.seconds) + num(b?.seconds) + num(c?.seconds),
      openMicros: num(a?.open_micros) + num(b?.open_micros) + num(c?.open_micros),
      unknownMicros: num(a?.unknown_micros) + num(b?.unknown_micros) + num(c?.unknown_micros),
      nextEndsInSeconds: nexts.length > 0 ? Math.ceil(Math.min(...nexts)) : null,
      parts: {
        notes: { open: num(a?.open_micros), unknown: num(a?.unknown_micros) },
        replies: { open: num(b?.open_micros), unknown: num(b?.unknown_micros) },
        hearing: { open: num(c?.open_micros), unknown: num(c?.unknown_micros) },
      },
    };
  };
  const empty: SpeechHeld = { mineSeconds: 0, openMicros: 0, unknownMicros: 0, nextEndsInSeconds: null, parts: { notes: { open: 0, unknown: 0 }, replies: { open: 0, unknown: 0 }, hearing: { open: 0, unknown: 0 } } };
  return { all: fold(allNotes, allReplies, allWindows), mine: personKey ? fold(myNotes, myReplies, myWindows) : empty };
}
