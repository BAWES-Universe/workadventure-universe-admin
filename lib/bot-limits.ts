import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  FAIR_USAGE_WINDOW_HOURS,
  artifactBytes,
  limitsForBot,
  readReplyLimits,
  readServerLimits,
  type ReplyLimits,
  type ServerLimits,
} from '@/lib/bot-limit-values';

/**
 * Bot limits (#666), saved. A super admin's are one JSON value in app_settings ("bot-limits"); a key's are on the key
 * (`replyLimits`); a bot's own longest reply and steps are on the bot. Nothing saved means the recommended value
 * (lib/bot-limit-values.ts), so a new server and a new key start on those.
 */

const SETTING_KEY = 'bot-limits';

/**
 * The super admin's limits as saved, the recommended value for anything never changed. A read that fails is logged and
 * gives the recommended values, so a reply or a save never fails over its limits alone.
 */
export async function getServerLimits(): Promise<ServerLimits> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    return readServerLimits(row?.value);
  } catch (error) {
    console.error('[BotLimits] Could not read the saved limits:', error instanceof Error ? error.message : 'unknown');
    return readServerLimits(null);
  }
}

type ServerChange = Partial<{ [K in keyof ServerLimits]: ServerLimits[K] extends object ? Partial<ServerLimits[K]> : ServerLimits[K] }>;

/** Saves a super admin's change on top of what is saved (only the values it names change) and returns all of them. */
export async function saveServerLimits(change: ServerChange, userId: string): Promise<ServerLimits> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const now = readServerLimits(row?.value);
    const next: ServerLimits = {
      universeAi: { ...now.universeAi, ...change.universeAi },
      artifacts: { ...now.artifacts, ...change.artifacts },
      guard: change.guard ?? now.guard,
      fairUsage: { ...now.fairUsage, ...change.fairUsage },
    };
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
 * Universe AI fair usage (#1159) for the reply checks: replies for a signed-in person, for a guest, and for all guests on
 * one bot, in each window of `windowHours`. 30, 10, 200 and 5 until a super admin changes them.
 */
export async function getUniverseAiReplyLimits(): Promise<{ signedIn: number; guest: number; guestPool: number; windowHours: number }> {
  const { fairUsage } = await getServerLimits();
  return { ...fairUsage, windowHours: FAIR_USAGE_WINDOW_HOURS };
}

/** A key's reply limits: what its owner changed, the recommended value for the rest. */
export const keyReplyLimits = (key: { replyLimits?: Prisma.JsonValue | null }): ReplyLimits => readReplyLimits(key.replyLimits);

/**
 * What the bot server is told with a bot's credentials: every limit for this one bot. `replyTokens` is also served as
 * the provider's `maxTokens`, so a bot server that has not learnt the other names still gets the longest reply.
 */
export interface ServedLimits {
  replyTokens: number;
  steps: number;
  continuations: number;
  messages: number;
  readChars: number;
  waitSeconds: number;
  artifactBytes: number;
  /** 0 keeps every version. */
  artifactVersions: number;
  artifactSaveSeconds: number;
  /** "Say when nothing was saved". */
  guard: boolean;
}

export function servedLimits(reply: ReplyLimits, server: ServerLimits, bot: { maxReplyTokens?: number | null; maxSteps?: number | null }): ServedLimits {
  const own = limitsForBot(reply, bot);
  return {
    replyTokens: own.reply,
    steps: own.steps,
    continuations: own.continue,
    messages: own.memory,
    readChars: own.read,
    waitSeconds: own.wait,
    artifactBytes: artifactBytes(server.artifacts),
    artifactVersions: server.artifacts.versions,
    artifactSaveSeconds: server.artifacts.save,
    guard: server.guard,
  };
}

/** A bot's own longest reply and steps (#666), as its pages save them: null follows its key, a higher one is kept but never used. */
export const maxReplyTokensSchema = z.number().int('maxReplyTokens must be a whole number').min(256, 'maxReplyTokens must be at least 256').max(1_000_000).optional().nullable();
export const maxStepsSchema = z.number().int('maxSteps must be a whole number').min(1, 'maxSteps must be at least 1').max(500).optional().nullable();
