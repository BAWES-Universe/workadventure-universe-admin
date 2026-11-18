import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { readCodeJobLimits, type CodeJobLimits } from '@/lib/workbench/values';

/**
 * What a super admin set for code jobs, and whether they are paused. Both live in the app's own settings table, never in code, so
 * nothing about how long, how big or how many is hardcoded and a pause is one row that every job reads first.
 */

const LIMITS_KEY = 'code-job-limits';
const STATE_KEY = 'code-job-state';

/** Held while the pause is changed, and by admission while it checks it: a pause that lands first is seen by the job being admitted. */
export const STATE_LOCK = 'codejob:state';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type SettingsDb = Pick<typeof prisma, 'appSetting'>;

/** The Limits as saved. A read that fails reads as empty (so nothing starts): never a reason to run. */
export async function getCodeJobLimits(db: SettingsDb = prisma): Promise<CodeJobLimits> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    return readCodeJobLimits(row?.value);
  } catch (error) {
    console.error('[CodeJob] Could not read the limits:', error instanceof Error ? error.message : 'unknown');
    return readCodeJobLimits(null);
  }
}

/** Saves a change on top of what is saved (only the names it carries change; null empties one) and returns all of them. */
export async function saveCodeJobLimits(change: Partial<Record<keyof CodeJobLimits, number | null>>, userId: string): Promise<CodeJobLimits> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('codejob:limits'))`;
    const row = await tx.appSetting.findUnique({ where: { key: LIMITS_KEY } });
    const saved = isRecord(row?.value) ? row.value : {};
    const next: Record<string, unknown> = { ...saved };
    for (const [key, value] of Object.entries(change)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: LIMITS_KEY }, create: { key: LIMITS_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return readCodeJobLimits(next);
  });
}

export interface CodeJobPause {
  paused: boolean;
  /** A fixed word for why: provider_ran_tools or manual. */
  reason: string | null;
  at: string | null;
}

export async function getCodeJobPause(db: SettingsDb = prisma): Promise<CodeJobPause> {
  try {
    return await readCodeJobPause(db);
  } catch (error) {
    // A pause that cannot be read is a pause: nothing starts on a guess
    console.error('[CodeJob] Could not read the pause:', error instanceof Error ? error.message : 'unknown');
    return { paused: true, reason: 'unreadable', at: null };
  }
}

/** The pause as saved, and a read that fails throws: for a change that must not be made, or reported as made, on a guess. */
async function readCodeJobPause(db: SettingsDb): Promise<CodeJobPause> {
  const row = await db.appSetting.findUnique({ where: { key: STATE_KEY } });
  const value = isRecord(row?.value) ? row.value : {};
  if (value.paused !== true) return { paused: false, reason: null, at: null };
  return { paused: true, reason: typeof value.reason === 'string' ? value.reason : 'manual', at: typeof value.at === 'string' ? value.at : null };
}

/** Pauses new jobs (jobs already going finish and are settled). The first reason stands until it is resumed. */
export async function pauseCodeJobs(reason: string, userId: string | null = null): Promise<CodeJobPause> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${STATE_LOCK}))`;
    // A read that fails fails the pause (the caller sees it and tries again): an unreadable pause is not "already paused", so nothing is skipped and nothing is reported as written
    const current = await readCodeJobPause(tx);
    if (current.paused) return current;
    const state = { paused: true, reason, at: new Date().toISOString() };
    const value = state as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    console.error(`[CodeJob] Paused: ${reason}`);
    return state;
  });
}

/** A super admin turns code jobs back on after looking at why they stopped. */
export async function resumeCodeJobs(userId: string): Promise<CodeJobPause> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${STATE_LOCK}))`;
    const value = { paused: false } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return { paused: false, reason: null, at: null };
  });
}
