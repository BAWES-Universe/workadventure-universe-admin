import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { readInstantLimits, type InstantLimits } from '@/lib/instant/values';

/**
 * What a super admin set for Instant, and whether it is paused. Both live in the app's own settings table, never in code, so
 * nothing about how much may be spent is hardcoded and a pause is one row that every run reads first.
 */

const LIMITS_KEY = 'instant-limits';
const STATE_KEY = 'instant-state';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type SettingsDb = Pick<typeof prisma, 'appSetting'>;

/** The limits as saved. A read that fails reads as empty (so nothing runs): never a reason to spend. */
export async function getInstantLimits(db: SettingsDb = prisma): Promise<InstantLimits> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    return readInstantLimits(row?.value);
  } catch (error) {
    console.error('[Instant] Could not read the limits:', error instanceof Error ? error.message : 'unknown');
    return readInstantLimits(null);
  }
}

/** Saves a change on top of what is saved (only the names it carries change; null empties one) and returns all of them. */
export async function saveInstantLimits(change: Partial<Record<keyof InstantLimits, number | null>>, userId: string): Promise<InstantLimits> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:limits'))`;
    const row = await tx.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    const saved = isRecord(row?.value) ? row.value : {};
    const next: Record<string, unknown> = { ...saved };
    for (const [key, value] of Object.entries(change)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: LIMITS_KEY }, create: { key: LIMITS_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return readInstantLimits(next);
  });
}

export interface InstantPause {
  paused: boolean;
  /** A fixed word for why: failure_rate, price_over_top, price_drift, provider_empty, or manual. */
  reason: string | null;
  at: string | null;
  /** When a super admin last turned it back on: the failure rate only counts runs that finished after this. */
  resumedAt?: string | null;
}

export async function getInstantPause(db: SettingsDb = prisma): Promise<InstantPause> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: STATE_KEY } });
    const value = isRecord(row?.value) ? row.value : {};
    if (value.paused !== true) return { paused: false, reason: null, at: null, resumedAt: typeof value.resumedAt === 'string' ? value.resumedAt : null };
    return { paused: true, reason: typeof value.reason === 'string' ? value.reason : 'manual', at: typeof value.at === 'string' ? value.at : null };
  } catch (error) {
    // A pause that cannot be read is a pause: nothing runs on a guess
    console.error('[Instant] Could not read the pause:', error instanceof Error ? error.message : 'unknown');
    return { paused: true, reason: 'unreadable', at: null };
  }
}

/** Pauses Instant (new runs only: runs already going finish and are settled). The first reason stands until it is resumed. */
export async function pauseInstant(reason: string, userId: string | null = null, within?: Prisma.TransactionClient): Promise<InstantPause> {
  // Called from inside a transaction, it uses that one: a second connection from the pool is never taken while one is held
  const pause = async (tx: Prisma.TransactionClient): Promise<InstantPause> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:state'))`;
    const current = await getInstantPause(tx);
    if (current.paused) return current;
    const state = { paused: true, reason, at: new Date().toISOString() };
    const value = state as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    console.error(`[Instant] Paused: ${reason}`);
    return state;
  };
  return within ? pause(within) : prisma.$transaction(pause);
}

/** A super admin turns Instant back on after looking at why it stopped. */
export async function resumeInstant(userId: string): Promise<InstantPause> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instant:state'))`;
    const value = { paused: false, resumedAt: new Date().toISOString() } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return { paused: false, reason: null, at: null, resumedAt: (value as { resumedAt: string }).resumedAt };
  });
}
