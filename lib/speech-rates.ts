import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * What speech costs Universe, as a versioned rate card (billing consensus v2, P2). One rate for each voice company and job:
 *
 *  - `hearing`: by time, per hour of audio the company hears.
 *  - `speaking`: by characters where the company bills so (`thousand_characters`), or by time (`hour`) where it bills so.
 *  - `talk`: an integrated audio model that hears and speaks in one. Its charge is ONE bundled rate per hour of audio, counted once: hearing and
 *    speaking seconds of such a model are each priced at it and never also at a hearing and a speaking rate.
 *
 * `adapter` is the company's adapter name as lib/voice-providers.ts keeps it; `*` is any company with no rate of its own. Every rate says
 * whether it is `published` (read from the company's own price page) or an `estimate`, with its basis in words, so the Budget page can say
 * which figures are estimates and why. Estimated rates are still priced with: speech is never free and never unknown.
 *
 * The card is a saved setting ('speech-rates'), read on every check and changed by a super admin. Any change to a rate is a NEW VERSION: an
 * admission records the version it used, and its receipt is priced at that version, so a price change never reprices what was already let
 * through. Older versions are kept in `history`. Nothing here is a constant: starting values come from one migration that never overwrites a
 * saved card. With no card, speech that needs a price is stopped (nothing is assumed).
 */
export const SPEECH_JOBS = ['hearing', 'speaking', 'talk'] as const;
export type SpeechJob = (typeof SPEECH_JOBS)[number];
export const RATE_UNITS = ['hour', 'thousand_characters'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
export const RATE_BASES = ['published', 'estimate'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

export interface SpeechRate {
  adapter: string;
  job: SpeechJob;
  unit: RateUnit;
  /** Millionths of a dollar per hour of audio, or per 1,000 characters. */
  microsPerUnit: number;
  basis: RateBasis;
  /** Where the figure comes from, in words. */
  basisNote: string;
}

export interface RateCard {
  version: number;
  /** How many characters a second of speech is, to turn the seconds of a reply into characters when a company bills by characters and the game did not say how many were sent. */
  charactersPerSecond: number;
  rates: SpeechRate[];
}

export const SPEECH_RATES_KEY = 'speech-rates';
/** Older versions kept, so a receipt can be priced at the version it was admitted under. */
const HISTORY_KEPT = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** The supported range of each number (so a page can say it before anything is sent). They limit nobody. */
export const RATE_RANGES = {
  version: { min: 1, max: 1_000_000 },
  charactersPerSecond: { min: 1, max: 1_000 },
  microsPerUnit: { min: 0, max: 1_000_000_000_000 },
} as const;

const ADAPTER = /^(\*|[a-z0-9][a-z0-9-]{0,48})$/;

export function readRate(value: unknown): SpeechRate | null {
  if (!isRecord(value)) return null;
  const { adapter, job, unit, microsPerUnit, basis, basisNote } = value;
  if (typeof adapter !== 'string' || !ADAPTER.test(adapter)) return null;
  if (!oneOf(SPEECH_JOBS, job) || !oneOf(RATE_UNITS, unit) || !oneOf(RATE_BASES, basis)) return null;
  // Hearing and a bundled model are by time. Only speaking may be by characters
  if (job !== 'speaking' && unit !== 'hour') return null;
  if (!whole(microsPerUnit, RATE_RANGES.microsPerUnit.min, RATE_RANGES.microsPerUnit.max)) return null;
  return { adapter, job, unit, microsPerUnit, basis, basisNote: typeof basisNote === 'string' ? basisNote.slice(0, 500) : '' };
}

function readCardBody(value: unknown): Omit<RateCard, 'version'> | null {
  if (!isRecord(value) || !whole(value.charactersPerSecond, RATE_RANGES.charactersPerSecond.min, RATE_RANGES.charactersPerSecond.max) || !Array.isArray(value.rates)) return null;
  const rates: SpeechRate[] = [];
  for (const raw of value.rates) {
    const rate = readRate(raw);
    if (!rate) return null;
    // One rate for a company and job
    if (rates.some((other) => other.adapter === rate.adapter && other.job === rate.job)) return null;
    rates.push(rate);
  }
  return { charactersPerSecond: value.charactersPerSecond, rates };
}

/** The saved card read back: null when there is none or it cannot be read (nothing is assumed). */
export function readRateCard(saved: unknown): RateCard | null {
  if (!isRecord(saved) || !whole(saved.version, RATE_RANGES.version.min, RATE_RANGES.version.max)) return null;
  const body = readCardBody(saved);
  return body ? { version: saved.version, ...body } : null;
}

/** The card as it was at an older version, or null when that version is not kept (and is not the current one). */
export function rateCardAt(saved: unknown, version: number): RateCard | null {
  const current = readRateCard(saved);
  if (current && current.version === version) return current;
  if (!isRecord(saved) || !isRecord(saved.history)) return null;
  const body = readCardBody(saved.history[String(version)]);
  return body ? { version, ...body } : null;
}

type SettingsDb = Pick<typeof prisma, 'appSetting'>;

/** The current card. A read that fails is logged and reads as no card, which stops the speech that needs a price: never a reason to spend. */
export async function getRateCard(db: SettingsDb = prisma): Promise<RateCard | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SPEECH_RATES_KEY } });
    return readRateCard(row?.value);
  } catch (error) {
    console.error('[Speech] Could not read the rates:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The card at an older version (a receipt is priced at the version it was admitted under), else the current one. */
export async function getRateCardAt(version: number | null, db: SettingsDb = prisma): Promise<RateCard | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SPEECH_RATES_KEY } });
    const current = readRateCard(row?.value);
    if (version === null || (current && current.version === version)) return current;
    return rateCardAt(row?.value, version) ?? current;
  } catch (error) {
    console.error('[Speech] Could not read the rates:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The rate for a company and job: its own, else the one for any company. Null when the card has neither. */
export function findRate(card: RateCard, adapter: string | null, job: SpeechJob): SpeechRate | null {
  return (adapter ? card.rates.find((rate) => rate.adapter === adapter && rate.job === job) : undefined) ?? card.rates.find((rate) => rate.adapter === '*' && rate.job === job) ?? null;
}

/** The rate that prices a stretch of audio: a bundled model's own, else the hearing or speaking one. */
export function rateFor(card: RateCard, adapter: string | null, job: 'hearing' | 'speaking', talk: boolean): SpeechRate | null {
  return (talk ? findRate(card, adapter, 'talk') : null) ?? findRate(card, adapter, job);
}

export interface SpeechPrice {
  /** Millionths of a dollar. Never 0 for audio that was heard or spoken at a rate that is above 0. */
  micros: number;
  rateVersion: number;
  adapter: string;
  job: SpeechJob;
  unit: RateUnit;
  basis: RateBasis;
  basisNote: string;
  /** Characters a speaking price was worked on, and whether they were guessed from the seconds. */
  characters?: number;
  charactersEstimated?: boolean;
}

/** What `seconds` of audio, or `characters` of text, cost at a rate. Rounded up to the next millionth, never down to a false 0. */
export function priceOf(card: RateCard, rate: SpeechRate, use: { seconds: number; characters?: number | null }): SpeechPrice {
  const base = { rateVersion: card.version, adapter: rate.adapter, job: rate.job, unit: rate.unit, basis: rate.basis, basisNote: rate.basisNote };
  if (rate.unit === 'hour') return { ...base, micros: Math.ceil((use.seconds * rate.microsPerUnit) / 3600) };
  const given = typeof use.characters === 'number' && Number.isFinite(use.characters) && use.characters >= 0;
  const characters = given ? Math.trunc(use.characters as number) : Math.ceil(use.seconds * card.charactersPerSecond);
  return { ...base, micros: Math.ceil((characters * rate.microsPerUnit) / 1000), characters, charactersEstimated: !given };
}

/** The price of a use of audio, or null when the card has no rate for it (the caller stops, never assumes). */
export function priceSpeech(card: RateCard, input: { adapter: string | null; part: 'hearing' | 'speaking'; seconds: number; characters?: number | null; talk?: boolean }): SpeechPrice | null {
  const rate = rateFor(card, input.adapter, input.part, input.talk === true);
  // A bundled model's seconds are priced once at its hour rate, whichever way the audio went
  return rate ? priceOf(card, rate, { seconds: input.seconds, characters: rate.job === 'talk' ? null : input.characters }) : null;
}

/**
 * The most one spoken reply may cost Universe: the enforceable longest reply. Billed by characters, that is the longest text a reply may be
 * (`replyCharacters`, the voice limit); billed by time, the longest audio (`replySeconds`).
 */
export function replyExposure(card: RateCard, input: { adapter: string | null; talk?: boolean; replySeconds: number; replyCharacters: number }): SpeechPrice | null {
  const rate = rateFor(card, input.adapter, 'speaking', input.talk === true);
  if (!rate) return null;
  return rate.unit === 'hour' ? priceOf(card, rate, { seconds: input.replySeconds }) : priceOf(card, rate, { seconds: input.replySeconds, characters: input.replyCharacters });
}

/** What `seconds` of hearing for one person may cost at most. */
export function hearingExposure(card: RateCard, input: { adapter: string | null; talk?: boolean; seconds: number }): SpeechPrice | null {
  return priceSpeech(card, { adapter: input.adapter, part: 'hearing', seconds: input.seconds, talk: input.talk });
}

/** Millionths of a dollar a second of audio costs at a rate, to value seconds that were counted before they were priced. */
export function microsPerSecond(card: RateCard, rate: SpeechRate): number {
  return rate.unit === 'hour' ? rate.microsPerUnit / 3600 : (rate.microsPerUnit * card.charactersPerSecond) / 1000;
}

// ---------- Saving ----------

export interface RateCardChange {
  charactersPerSecond?: number;
  /** The whole list of rates, replacing the saved one. */
  rates?: unknown;
}

export function checkRateChange(input: unknown): { ok: true; value: { charactersPerSecond?: number; rates?: SpeechRate[] } } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: { charactersPerSecond?: number; rates?: SpeechRate[] } = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'charactersPerSecond') {
      if (!whole(value, RATE_RANGES.charactersPerSecond.min, RATE_RANGES.charactersPerSecond.max)) return { ok: false, error: `charactersPerSecond must be a whole number from ${RATE_RANGES.charactersPerSecond.min} to ${RATE_RANGES.charactersPerSecond.max}` };
      out.charactersPerSecond = value;
    } else if (key === 'rates') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 500) return { ok: false, error: 'rates must be a list of 1 to 500 rates' };
      const rates: SpeechRate[] = [];
      for (const raw of value) {
        const rate = readRate(raw);
        if (!rate) return { ok: false, error: 'Each rate needs adapter (or *), job (hearing, speaking or talk), unit (hour; thousand_characters for speaking only), microsPerUnit (whole, 0 or more) and basis (published or estimate)' };
        if (rates.some((other) => other.adapter === rate.adapter && other.job === rate.job)) return { ok: false, error: `There is more than one rate for ${rate.adapter} ${rate.job}` };
        rates.push(rate);
      }
      out.rates = rates;
    } else return { ok: false, error: `Unknown setting: ${key}` };
  }
  return { ok: true, value: out };
}

const sameRates = (a: SpeechRate[], b: SpeechRate[]) =>
  a.length === b.length && a.every((rate) => b.some((other) => other.adapter === rate.adapter && other.job === rate.job && other.unit === rate.unit && other.microsPerUnit === rate.microsPerUnit));

/**
 * Saves a change. A change to any price or to how characters are counted is a new version (the old one goes to the history); a change that
 * only rewords a basis keeps the version, since it prices nothing differently. Returns the card now in effect.
 */
export async function saveRateCard(change: { charactersPerSecond?: number; rates?: SpeechRate[] }, userId: string): Promise<RateCard> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('speech:rates'))`;
    const row = await tx.appSetting.findUnique({ where: { key: SPEECH_RATES_KEY } });
    const saved = isRecord(row?.value) ? row.value : {};
    const current = readRateCard(saved);
    const rates = change.rates ?? current?.rates;
    const charactersPerSecond = change.charactersPerSecond ?? current?.charactersPerSecond;
    if (!rates || charactersPerSecond === undefined) throw new Error('A first rate card needs rates and charactersPerSecond');
    const changesPrices = !current || current.charactersPerSecond !== charactersPerSecond || !sameRates(current.rates, rates);
    const version = current ? (changesPrices ? current.version + 1 : current.version) : 1;
    const history: Record<string, unknown> = isRecord(saved.history) ? { ...saved.history } : {};
    if (current && changesPrices) {
      history[String(current.version)] = { charactersPerSecond: current.charactersPerSecond, rates: current.rates };
      const kept = Object.keys(history).map(Number).sort((a, b) => a - b);
      for (const old of kept.slice(0, Math.max(0, kept.length - HISTORY_KEPT))) delete history[String(old)];
    }
    const next = { version, charactersPerSecond, rates, history, changedAt: new Date().toISOString() };
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: SPEECH_RATES_KEY }, create: { key: SPEECH_RATES_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return { version, charactersPerSecond, rates };
  });
}
