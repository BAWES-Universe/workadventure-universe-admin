import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * How long things last in the speech admission contract (docs/speech-admission-contract.md), as a super admin saved them. Every one is a saved
 * setting, read on every check, so a change is used by the next admission with no restart. None is a constant in code and none limits a
 * person: they say how a window of live hearing is cut, when a hold with no receipt is shown as unknown, and how long a hold lasts for a game
 * that cannot name the reply on its receipt. Starting values come from one migration that never overwrites a saved one. A value that is
 * missing stops the speech that needs it (nothing is assumed), as every empty money setting does.
 */
export interface SpeechTerms {
  /** The length of one admitted stretch of live hearing, in seconds. */
  hearingWindowSeconds: number | null;
  /** The game asks for the next window when this many seconds of the current one are left. */
  hearingRenewLeadSeconds: number | null;
  /** A hold whose reply or window could have ended this long ago, with no receipt, is shown as unknown. It keeps counting either way. */
  receiptGraceSeconds: number | null;
  /** How long a reply admitted without a receipt id (an older game) holds its money. */
  legacyHoldSeconds: number | null;
}

export const SPEECH_TERM_RANGES: Record<keyof SpeechTerms, { min: number; max: number }> = {
  hearingWindowSeconds: { min: 5, max: 3_600 },
  hearingRenewLeadSeconds: { min: 1, max: 3_600 },
  receiptGraceSeconds: { min: 0, max: 7 * 86_400 },
  legacyHoldSeconds: { min: 0, max: 86_400 },
};

export const SPEECH_TERMS_KEY = 'speech-terms';

const EMPTY: SpeechTerms = { hearingWindowSeconds: null, hearingRenewLeadSeconds: null, receiptGraceSeconds: null, legacyHoldSeconds: null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fits = (value: unknown, range: { min: number; max: number }): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

export function readSpeechTerms(saved: unknown): SpeechTerms {
  const out: SpeechTerms = { ...EMPTY };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(SPEECH_TERM_RANGES) as (keyof SpeechTerms)[]) {
    if (fits(saved[key], SPEECH_TERM_RANGES[key])) out[key] = saved[key] as number;
  }
  return out;
}

type SettingsDb = Pick<typeof prisma, 'appSetting'>;

/** The terms as saved. A read that fails is logged and reads as empty, which stops the speech that needs them: never a reason to spend. */
export async function getSpeechTerms(db: SettingsDb = prisma): Promise<SpeechTerms> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SPEECH_TERMS_KEY } });
    return readSpeechTerms(row?.value);
  } catch (error) {
    console.error('[Speech] Could not read the terms:', error instanceof Error ? error.message : 'unknown');
    return { ...EMPTY };
  }
}

/** A change to the terms: only known names, each inside its range. */
export function checkSpeechTerms(input: unknown): { ok: true; value: Partial<SpeechTerms> } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<SpeechTerms> = {};
  for (const [key, value] of Object.entries(input)) {
    const range = Object.prototype.hasOwnProperty.call(SPEECH_TERM_RANGES, key) ? SPEECH_TERM_RANGES[key as keyof SpeechTerms] : undefined;
    if (!range) return { ok: false, error: `Unknown setting: ${key}` };
    if (!fits(value, range)) return { ok: false, error: `${key} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    (out as Record<string, number>)[key] = value;
  }
  return { ok: true, value: out };
}

export async function saveSpeechTerms(change: Partial<SpeechTerms>, userId: string): Promise<SpeechTerms> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('speech:terms'))`;
    const row = await tx.appSetting.findUnique({ where: { key: SPEECH_TERMS_KEY } });
    const next: Record<string, unknown> = { ...(isRecord(row?.value) ? row.value : {}), ...change };
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: SPEECH_TERMS_KEY }, create: { key: SPEECH_TERMS_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return readSpeechTerms(next);
  });
}
