import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerLimits } from '@/lib/bot-limits';
import { FAIR_USAGE_WINDOW_HOURS } from '@/lib/bot-limit-values';
import { readVoiceLimits, textReserve, voiceReplies, type VoiceLimits } from '@/lib/voice-limit-values';

/**
 * Voice limits (#740), saved. One JSON value in app_settings ("voice-limits"): the limits and a revision that goes up with
 * every save, so the game can tell when what it holds is old. Nothing saved means the recommended values
 * (lib/voice-limit-values.ts).
 */

const SETTING_KEY = 'voice-limits';

export interface SavedVoiceLimits {
  limits: VoiceLimits;
  /** 0 until a super admin first saves; goes up by one with every save. */
  revision: number;
}

const read = (value: unknown): SavedVoiceLimits => {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const revision = typeof saved.revision === 'number' && Number.isInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0;
  return { limits: readVoiceLimits(saved.limits), revision };
};

/**
 * The voice limits as saved, the recommended value for anything never changed. A read that fails is logged and gives the
 * recommended values, so a bot never stops over its limits alone.
 */
export async function getVoiceLimits(): Promise<SavedVoiceLimits> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    return read(row?.value);
  } catch (error) {
    console.error('[VoiceLimits] Could not read the saved limits:', error instanceof Error ? error.message : 'unknown');
    return read(null);
  }
}

/** Saves a change on top of what is saved (only the values it names change) and returns all of them. */
export async function saveVoiceLimits(change: Partial<VoiceLimits>, userId: string): Promise<SavedVoiceLimits> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const now = read(row?.value);
    const next: SavedVoiceLimits = { limits: { ...now.limits, ...change }, revision: now.revision + 1 };
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value, updatedById: userId },
      update: { value, updatedById: userId },
    });
    return next;
  });
}

/**
 * What the game reads: the limits, and the voice replies they leave inside today's fair usage windows (the reply limits
 * a super admin already sets), so the game never works the text reserve out for itself.
 */
export async function servedVoiceLimits() {
  const [{ limits, revision }, server] = await Promise.all([getVoiceLimits(), getServerLimits()]);
  const { signedIn, guest } = server.fairUsage;
  return {
    revision,
    limits,
    window: {
      hours: FAIR_USAGE_WINDOW_HOURS,
      signedIn: { replies: signedIn, textReserve: textReserve(signedIn, limits.textReserveShare), voiceReplies: voiceReplies(signedIn, limits, false) },
      guest: { replies: guest, textReserve: textReserve(guest, limits.textReserveShare), voiceReplies: voiceReplies(guest, limits, true) },
    },
  };
}
