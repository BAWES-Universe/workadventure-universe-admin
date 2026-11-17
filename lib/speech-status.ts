import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { monthOf } from '@/lib/meter-values';
import { speechSpent } from '@/lib/speech-cap';
import { getRateCard, type RateBasis } from '@/lib/speech-rates';
import { lockSpeech, speechReserved, SPEECH_LOCK, type SpeechHeld } from '@/lib/speech-reserved';
import { replyEventId } from '@/lib/speech-receipts';
import { recordMeterEvent } from '@/lib/meter';
import { unfundedCompanies } from '@/lib/speech-admission';

/**
 * Where the Speech budget stands, and the reconcile pass (docs/speech-admission-contract.md, section 6), for the Budget page and for the team's
 * own checks. Reads only, except `reconcileSpeech` (housekeeping that never changes what is counted) and `resolveSpeechHold` (a super admin's
 * decision about one hold whose receipt never came).
 *
 * What is counted is in three parts, kept apart so the page can say which remedy helps: SPENT (events in the books, priced), UNKNOWN (set aside
 * and past the time its reply or window could have taken, with no receipt: it keeps counting), and SET ASIDE (speech still going on, freed when
 * its receipt arrives). Hours heard and hours spoken are information only.
 */
export interface SpeechStatus {
  month: { start: string; end: string };
  /** The Speech budget in millionths of a dollar; null while none is set (speech is stopped until one is). */
  budgetMicros: number | null;
  spentMicros: number;
  /** Of what was spent, the part written with no price and valued at today's rates (an estimate). */
  spentEstimatedMicros: number;
  setAsideMicros: number;
  unknownMicros: number;
  /** What is left for new speech: the budget less all three. Never negative. */
  leftMicros: number | null;
  /** Information only: nothing stops on these. */
  secondsHeard: number;
  secondsSpoken: number;
  held: SpeechHeld['parts'];
  /** Holds of earlier months that never got a receipt: not counted into this month, still waiting to be reconciled. */
  unreconciledEarlier: { replies: number; windows: number };
  rates: { version: number; estimates: { adapter: string; job: string; basis: RateBasis; basisNote: string }[] } | null;
  /** Voice companies whose funds are out (a receipt said so), by adapter. */
  providersWithoutFunds: string[];
}

export async function speechStatus(now: Date = new Date(), db: Pick<typeof prisma, '$queryRaw' | '$executeRaw' | 'appSetting' | 'voiceNoteTurn' | 'voiceReplyUse'> = prisma): Promise<SpeechStatus> {
  const month = monthOf(now);
  const [settings, card] = await Promise.all([getMeterSettings(db), getRateCard(db)]);
  const [spent, held, parts, earlier, unfunded] = await Promise.all([
    speechSpent(db, card, now),
    speechReserved(db, { personKey: null, replySeconds: 0, now }),
    db.$queryRaw<{ part: string | null; seconds: bigint | null }[]>(Prisma.sql`
      SELECT COALESCE("detail"->>'part', 'hearing') AS part, COALESCE(SUM("quantity"), 0)::bigint AS seconds
      FROM "meter_events"
      WHERE "kind" = 'speech' AND "payer_kind" = 'universe' AND "occurred_at" >= ${month.start}::timestamp AND "occurred_at" < ${month.end}::timestamp
      GROUP BY 1`),
    db.$queryRaw<{ replies: bigint; windows: bigint }[]>(Prisma.sql`
      SELECT (SELECT COUNT(*) FROM "voice_reply_uses" WHERE "contract" >= 2 AND "settled_at" IS NULL AND "created_at" < ${month.start}::timestamp) AS replies,
             (SELECT COUNT(*) FROM "voice_hearing_windows" WHERE "closed_at" IS NULL AND "used_seconds" < "admitted_seconds" AND "created_at" < ${month.start}::timestamp) AS windows`),
    unfundedCompanies(db),
  ]);
  const seconds = (part: string) => Number(parts.find((row) => row.part === part)?.seconds ?? 0);
  const all = held.all;
  const counted = spent.micros + all.openMicros + all.unknownMicros;
  return {
    month: { start: month.start.toISOString(), end: month.end.toISOString() },
    budgetMicros: settings.speechBudgetMicros,
    spentMicros: spent.micros,
    spentEstimatedMicros: spent.unpricedMicros,
    setAsideMicros: all.openMicros,
    unknownMicros: all.unknownMicros,
    leftMicros: settings.speechBudgetMicros === null ? null : Math.max(0, settings.speechBudgetMicros - counted),
    secondsHeard: seconds('hearing'),
    secondsSpoken: seconds('speaking'),
    held: all.parts,
    unreconciledEarlier: { replies: Number(earlier[0]?.replies ?? 0), windows: Number(earlier[0]?.windows ?? 0) },
    rates: card ? { version: card.version, estimates: card.rates.filter((rate) => rate.basis === 'estimate').map(({ adapter, job, basis, basisNote }) => ({ adapter, job, basis, basisNote })) } : null,
    providersWithoutFunds: Object.keys(unfunded).sort(),
  };
}

export interface ReconcileReport {
  /** Windows whose seconds were all used and that were closed. */
  closedWindows: number;
  status: SpeechStatus;
}

/**
 * Housekeeping, safe to run twice at once, run with the existing sweep: a window whose admitted seconds were all used holds nothing more and is
 * closed. It never makes a hold go away that has no receipt: those stay counted as unknown until their receipt or their release arrives (or a
 * super admin resolves one), and an earlier month's are reported, not counted into this month. A timer alone never proves nothing was charged.
 */
export async function reconcileSpeech(now: Date = new Date()): Promise<ReconcileReport> {
  const closed = await prisma.$transaction(async (tx) => {
    await lockSpeech(tx);
    return tx.$executeRaw(Prisma.sql`UPDATE "voice_hearing_windows" SET "closed_at" = ${now}::timestamp WHERE "closed_at" IS NULL AND "used_seconds" >= "admitted_seconds"`);
  }, SPEECH_LOCK);
  return { closedWindows: closed, status: await speechStatus(now) };
}

export type HoldResolution = { ok: true; outcome: 'released' | 'charged' | 'already_settled' } | { ok: false; error: 'not_found' };

/**
 * A super admin's decision about one reply whose receipt never came: `release` (it was never spoken or charged: the hold goes) or `charge` (count
 * what it could have cost at the rate admitted, as an estimate, so the money stays counted but is no longer unknown). Either settles the row, so
 * it is never counted twice. Said twice it changes nothing.
 */
export async function resolveSpeechHold(input: { botId: string; turnId: string; outcome: 'release' | 'charge' }, now: Date = new Date()): Promise<HoldResolution> {
  return prisma.$transaction(async (tx) => {
    await lockSpeech(tx);
    const row = await tx.voiceReplyUse.findUnique({ where: { botId_turnId: { botId: input.botId, turnId: input.turnId } } });
    if (!row) return { ok: false, error: 'not_found' };
    if (row.settledAt) return { ok: true, outcome: 'already_settled' };
    if (input.outcome === 'charge') {
      const bot = await tx.bot.findUnique({ where: { id: row.botId }, select: { roomId: true, ownerId: true } });
      const personId = row.personKey.startsWith('person:') ? row.personKey.slice('person:'.length) : null;
      await recordMeterEvent(
        {
          eventId: replyEventId(row.botId, row.turnId),
          kind: 'speech',
          pool: 'chat',
          occurredAt: now,
          personKey: row.personKey.startsWith('person:') || row.personKey.startsWith('guest:') ? row.personKey : 'unknown',
          personId,
          botId: row.botId,
          brick: bot ? bot.roomId === null : null,
          payerKind: 'universe',
          payerPersonId: null,
          route: 'universe-ai',
          jobId: null,
          quantity: row.memberSeconds ?? row.seconds ?? 0,
          unit: 'second',
          costMicros: row.holdMicros === null ? null : Number(row.holdMicros),
          basis: 'estimated',
          sourceRef: null,
          detail: { part: 'speaking', turnId: row.turnId, reconciled: 'charged_at_admitted_amount', rateVersion: row.rateVersion },
        },
        tx,
      );
    }
    await tx.voiceReplyUse.update({ where: { id: row.id }, data: { settledAt: now, settledSeconds: input.outcome === 'charge' ? (row.memberSeconds ?? row.seconds ?? 0) : 0, settledMicros: input.outcome === 'charge' ? row.holdMicros : BigInt(0) } });
    return { ok: true, outcome: input.outcome === 'charge' ? 'charged' : 'released' };
  }, SPEECH_LOCK);
}
