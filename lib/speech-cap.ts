import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { monthOf } from '@/lib/meter-values';
import { extendedCeiling, runningEntitlement } from '@/lib/entitlement-grants';
import { getRateCard, microsPerSecond, rateFor, type RateCard } from '@/lib/speech-rates';
import type { SpeechReason } from '@/lib/speech-admission';
import type { SpeechHeld } from '@/lib/speech-reserved';

/**
 * The stops on the speech Universe AI pays for (billing consensus v2, P2 and P3). Speech is counted in MONEY: every heard and spoken second of a
 * live call and every heard voice note is a `speech` event written against whoever paid (POST /api/meter/events, lib/meter-speech.ts), priced at
 * the rate card (lib/speech-rates.ts). A new use is held back BEFORE it is made, when it would pass either of two things:
 *
 *  - `speechBudgetMicros`, the platform's Speech budget for the calendar month (UTC), all people together: what was spent, plus what is counted
 *    unknown, plus the use's own exposure (the most it could cost Universe, the enforceable longest reply or the window admitted). Hours are
 *    no longer a stop: speech carries on past 100 metered hours while the budget allows.
 *  - `speechMemberCeilingSeconds`, one person's own entitlement in seconds (hearing plus speaking), with the extra an admin gave them while it
 *    runs (lib/entitlement-grants.ts). What is asked for is the member estimate: the usual length of a reply, the exact length of a note.
 *
 * Every refusal carries one reason, kept apart (P3): `person` (their own entitlement), `budget` (spent or unknown fills the platform budget),
 * `hold` (it would fit if what is only set aside right now were released; waiting helps), and from the callers `provider` and `capacity`. Nobody
 * is told a number. A setting that is empty stops everything it covers: nothing is assumed, and 0 pauses it.
 */
export type SpeechStop = { stopped: 'person' | 'budget' | 'hold' | 'not_set'; reason: SpeechReason; resetsAt: string; retryAfterSeconds?: number };

type Db = Pick<typeof prisma, 'appSetting' | '$queryRaw' | 'meterEntitlementGrant'>;

export interface SpeechSpent {
  /** What was written with a price, plus what was written without one at the current rates, in millionths of a dollar. */
  micros: number;
  /** Seconds heard and spoken. */
  seconds: number;
  /** Money that had no price when it was written and is valued at the current rates (an estimate). */
  unpricedMicros: number;
}

type SpentRow = { priced: bigint | null; seconds: bigint | null; unpriced_hearing: bigint | null; unpriced_speaking: bigint | null };

/** What Universe AI's speech has used in a calendar month: all people, or one. Reads the books only. */
export async function speechSpent(db: Pick<typeof prisma, '$queryRaw'>, card: RateCard | null, now: Date, personId?: string | null): Promise<SpeechSpent> {
  const month = monthOf(now);
  const one = personId ? Prisma.sql`AND "person_id" = ${personId}` : Prisma.empty;
  const rows = await db.$queryRaw<SpentRow[]>(Prisma.sql`
    SELECT COALESCE(SUM("cost_micros"), 0)::bigint AS priced,
           COALESCE(SUM("quantity"), 0)::bigint AS seconds,
           COALESCE(SUM(CASE WHEN "cost_micros" IS NULL AND COALESCE("detail"->>'part', 'hearing') <> 'speaking' THEN "quantity" END), 0)::bigint AS unpriced_hearing,
           COALESCE(SUM(CASE WHEN "cost_micros" IS NULL AND "detail"->>'part' = 'speaking' THEN "quantity" END), 0)::bigint AS unpriced_speaking
    FROM "meter_events"
    WHERE "kind" = 'speech' AND "payer_kind" = 'universe' AND "occurred_at" >= ${month.start}::timestamp AND "occurred_at" < ${month.end}::timestamp ${one}`);
  const row = rows[0];
  const perSecond = (part: 'hearing' | 'speaking') => {
    const rate = card ? rateFor(card, null, part, false) : null;
    return card && rate ? microsPerSecond(card, rate) : 0;
  };
  // Seconds written before there was a price for them are valued at today's rates, never as 0
  const unpricedMicros = Math.ceil(Number(row?.unpriced_hearing ?? 0) * perSecond('hearing') + Number(row?.unpriced_speaking ?? 0) * perSecond('speaking'));
  return { micros: Number(row?.priced ?? 0) + unpricedMicros, seconds: Number(row?.seconds ?? 0), unpricedMicros };
}

export interface SpeechAsk {
  personId: string | null;
  /** What the person's own entitlement counts for the use: the usual length of a reply, the length of a note, the seconds of a window. */
  memberSeconds: number;
  /** The most the use may cost Universe, in millionths of a dollar. */
  exposureMicros: number;
  /** What is set aside already, read under the speech lock (lib/speech-reserved.ts). */
  held: { all: SpeechHeld; mine: SpeechHeld };
}

export async function checkSpeechCap(input: SpeechAsk, now: Date = new Date(), db: Db = prisma): Promise<SpeechStop | null> {
  const resetsAt = monthOf(now).end.toISOString();
  const [settings, card] = await Promise.all([getMeterSettings(db), getRateCard(db)]);
  if (settings.speechBudgetMicros === null || settings.speechMemberCeilingSeconds === null || !card) return { stopped: 'not_set', reason: 'budget', resetsAt };

  // The person's own entitlement first: it is theirs, and "Give more" lifts it
  if (input.personId) {
    const extra = await runningEntitlement(input.personId, 'speech', now, db);
    const ceiling = extendedCeiling(settings.speechMemberCeilingSeconds, extra);
    if (ceiling !== null) {
      const mine = await speechSpent(db, card, now, input.personId);
      if (mine.seconds + input.held.mine.mineSeconds + input.memberSeconds > ceiling) return { stopped: 'person', reason: 'person', resetsAt };
    }
  }

  const all = await speechSpent(db, card, now);
  // What is spent and what is unknown cannot be freed by waiting: if they alone fill the budget it is the budget
  const fixed = all.micros + input.held.all.unknownMicros + input.exposureMicros;
  if (fixed > settings.speechBudgetMicros) return { stopped: 'budget', reason: 'budget', resetsAt };
  // What is only set aside for speech that is still going on is freed when its receipt arrives: waiting helps
  if (fixed + input.held.all.openMicros > settings.speechBudgetMicros) {
    return { stopped: 'hold', reason: 'hold', resetsAt, ...(input.held.all.nextEndsInSeconds !== null ? { retryAfterSeconds: Math.max(1, input.held.all.nextEndsInSeconds) } : {}) };
  }
  return null;
}
