import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { readModels } from '@/lib/voice-providers';
import { getRateCard, hearingExposure, replyExposure, type RateCard, type SpeechPrice } from '@/lib/speech-rates';
import { getSpeechTerms, type SpeechTerms } from '@/lib/speech-terms';

/**
 * What an admission needs before any speech is let through (docs/speech-admission-contract.md): the rate card, the saved terms, which voice
 * company the use is for, whether that company's funds are available, and the two amounts of the contract: the member estimate (the usual
 * length) and Universe's exposure (the enforceable longest). Everything is read fresh, so a change a super admin saves is used by the next
 * admission with no restart. Reads only (the caller holds the speech lock and writes the row).
 */

/** The reasons a refusal can carry (P3). A visitor sees the word, never a balance. */
export const SPEECH_REASONS = ['person', 'budget', 'hold', 'provider', 'capacity'] as const;
export type SpeechReason = (typeof SPEECH_REASONS)[number];

type Db = Pick<typeof prisma, 'appSetting' | 'voiceProvider' | 'meterEvent'>;

const ADAPTER = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** How many of the latest replies the usual length is taken from: the definition of the statistic, not a limit on anyone. */
export const USUAL_LENGTH_SAMPLE = 20;

export interface SpeechCompany {
  /** The company's adapter name, or null when none could be named (the rate for any company is used). */
  adapter: string | null;
  /** The model is an integrated audio model, priced as one bundled charge. */
  talk: boolean;
}

/**
 * Which voice company a use is for: the one the game names (`provider`, with the `model` it used), else the server's default for the job.
 * A model the company lists as a talking model is bundled.
 */
export async function resolveCompany(db: Pick<Db, 'voiceProvider'>, job: 'hearing' | 'speaking', input: { provider?: unknown; model?: unknown } = {}): Promise<SpeechCompany> {
  const named = typeof input.provider === 'string' && ADAPTER.test(input.provider.trim().toLowerCase()) ? input.provider.trim().toLowerCase() : null;
  const model = typeof input.model === 'string' ? input.model.slice(0, 255) : null;
  try {
    const row = named
      ? await db.voiceProvider.findFirst({ where: { adapter: named, ownerId: null }, select: { adapter: true, models: true } })
      : await db.voiceProvider.findFirst({ where: { ownerId: null, enabled: true, ...(job === 'hearing' ? { defaultRecognition: true } : { defaultSpeech: true }) }, select: { adapter: true, models: true } });
    const adapter = named ?? row?.adapter ?? null;
    const talk = !!model && !!row && readModels(row.models).some((listed) => listed.id === model && listed.kind === 'talk');
    return { adapter, talk };
  } catch (error) {
    console.error('[Speech] Could not look the voice company up:', error instanceof Error ? error.message : 'unknown');
    return { adapter: named, talk: false };
  }
}

// ---------- Companies whose funds are out ----------

const FUNDS_KEY = 'speech-provider-funds';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The companies a receipt or a super admin said have no funds, by adapter. Unknown is not out: a company with no entry is taken to be funded. */
export async function unfundedCompanies(db: Pick<Db, 'appSetting'> = prisma): Promise<Record<string, { since: string }>> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: FUNDS_KEY } });
    const out: Record<string, { since: string }> = {};
    if (isRecord(row?.value)) {
      for (const [adapter, entry] of Object.entries(row.value)) {
        if (isRecord(entry) && entry.unavailable === true) out[adapter] = { since: typeof entry.since === 'string' ? entry.since : '' };
      }
    }
    return out;
  } catch (error) {
    console.error('[Speech] Could not read the provider funds:', error instanceof Error ? error.message : 'unknown');
    return {};
  }
}

/** Says a company's funds are out (`unavailable: true`) or back. Said twice, it changes nothing. */
export async function setCompanyFunds(adapter: string, unavailable: boolean, now: Date = new Date(), db: Pick<typeof prisma, '$transaction'> = prisma): Promise<void> {
  if (!ADAPTER.test(adapter)) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('speech:provider-funds'))`;
    const row = await tx.appSetting.findUnique({ where: { key: FUNDS_KEY } });
    const next: Record<string, unknown> = isRecord(row?.value) ? { ...row.value } : {};
    const was = isRecord(next[adapter]) && (next[adapter] as Record<string, unknown>).unavailable === true;
    if (unavailable && was) return;
    if (!unavailable && !was) return;
    if (unavailable) next[adapter] = { unavailable: true, since: now.toISOString() };
    else delete next[adapter];
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: FUNDS_KEY }, create: { key: FUNDS_KEY, value }, update: { value } });
  });
}

// ---------- The amounts of one admission ----------

export type Unready = { ok: false; stop: 'not_set' | 'provider'; adapter?: string | null };

/**
 * The usual length of a spoken reply, in seconds, for the member's own count: the median of the latest replies Universe AI spoke, never more
 * than the longest a reply may be. With no replies yet it is that longest, so nothing is assumed shorter than it can be.
 */
export async function usualReplySeconds(db: Pick<Db, 'meterEvent'>, maxSeconds: number): Promise<number> {
  try {
    const rows = await db.meterEvent.findMany({
      where: { kind: 'speech', payerKind: 'universe', detail: { path: ['part'], equals: 'speaking' }, quantity: { gt: 0 } },
      orderBy: { occurredAt: 'desc' },
      take: USUAL_LENGTH_SAMPLE,
      select: { quantity: true },
    });
    if (rows.length === 0) return maxSeconds;
    const sorted = rows.map((row) => Number(row.quantity)).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[middle] : Math.ceil((sorted[middle - 1] + sorted[middle]) / 2);
    return Math.max(1, Math.min(maxSeconds, median));
  } catch (error) {
    console.error('[Speech] Could not read the usual length of a reply:', error instanceof Error ? error.message : 'unknown');
    return maxSeconds;
  }
}

export interface ReplyPlan {
  card: RateCard;
  terms: SpeechTerms;
  company: SpeechCompany;
  price: SpeechPrice;
  /** The enforceable longest reply, in seconds. */
  maxSeconds: number;
  /** The member's estimate, in seconds. */
  memberSeconds: number;
}

/** What admitting one spoken reply sets aside, or why it cannot be admitted at all (no rate card, no terms, or the company's funds are out). */
export async function planReply(db: Db, input: { provider?: unknown; model?: unknown; replySeconds: number; replyCharacters: number }): Promise<{ ok: true; plan: ReplyPlan } | Unready> {
  const [card, terms, company] = await Promise.all([getRateCard(db), getSpeechTerms(db), resolveCompany(db, 'speaking', input)]);
  if (!card) return { ok: false, stop: 'not_set' };
  const price = replyExposure(card, { adapter: company.adapter, talk: company.talk, replySeconds: input.replySeconds, replyCharacters: input.replyCharacters });
  if (!price) return { ok: false, stop: 'not_set', adapter: company.adapter };
  if (company.adapter && (await unfundedCompanies(db))[company.adapter]) return { ok: false, stop: 'provider', adapter: company.adapter };
  return { ok: true, plan: { card, terms, company, price, maxSeconds: input.replySeconds, memberSeconds: await usualReplySeconds(db, input.replySeconds) } };
}

export interface HearingPlan {
  card: RateCard;
  terms: SpeechTerms;
  company: SpeechCompany;
  price: SpeechPrice;
  seconds: number;
}

/** What admitting one window of live hearing sets aside, or why it cannot be admitted. */
export async function planHearing(db: Db, input: { provider?: unknown; model?: unknown }): Promise<{ ok: true; plan: HearingPlan } | Unready> {
  const [card, terms, company] = await Promise.all([getRateCard(db), getSpeechTerms(db), resolveCompany(db, 'hearing', input)]);
  if (!card || terms.hearingWindowSeconds === null || terms.hearingRenewLeadSeconds === null) return { ok: false, stop: 'not_set' };
  const price = hearingExposure(card, { adapter: company.adapter, talk: company.talk, seconds: terms.hearingWindowSeconds });
  if (!price) return { ok: false, stop: 'not_set', adapter: company.adapter };
  if (company.adapter && (await unfundedCompanies(db))[company.adapter]) return { ok: false, stop: 'provider', adapter: company.adapter };
  return { ok: true, plan: { card, terms, company, price, seconds: terms.hearingWindowSeconds } };
}
