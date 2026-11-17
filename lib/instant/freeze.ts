import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Freezing one Instant tool (billing consensus v2, S4). When Composio's own listing of a tool's price changes in a way we cannot read as "the
 * same unit, a price that is no higher" (the unit or tier words differ, the figure cannot be read, the figure is higher, or the tool is no
 * longer served as Instant), THAT tool stops taking new runs, and every other tool carries on. Runs already reserved finish and settle at the
 * top price they were reserved at. The freeze clears by itself when the live words match the words the table was read against again.
 *
 * A freeze is lifted for a tool, without the live words matching, only by a proven independent ceiling: a figure a super admin saved for that
 * tool with the proof they hold (a provider-side cap, a contract price), at or below the top price the table reserves for one unit. That covers
 * what is outstanding and every new attempt, because no run can cost more than the ceiling, which is no more than what was reserved.
 *
 * Both lists live in the app's settings table, never in code. A read that fails reads as frozen: nothing runs on a guess.
 */

const FROZEN_KEY = 'instant-frozen';
const CEILINGS_KEY = 'instant-ceilings';

export type FreezeReason = 'unit_or_tier' | 'unreadable' | 'higher' | 'gone';
export interface Frozen {
  reason: FreezeReason;
  /** The words the table was read against, and the words Composio gives now (nothing a person sees). */
  listed: string;
  live: string | null;
  at: string;
}
export interface Ceiling {
  /** The most one unit of the tool can cost, in millionths of a dollar. */
  unitMicros: number;
  /** What proves it, in words (who holds the cap and where it is written down). Required. */
  proof: string;
  savedAt: string;
  savedById: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
type SettingsDb = Pick<typeof prisma, 'appSetting'>;

const REASONS: readonly string[] = ['unit_or_tier', 'unreadable', 'higher', 'gone'];

function readFrozen(value: unknown): Record<string, Frozen> {
  const out: Record<string, Frozen> = {};
  if (!isRecord(value)) return out;
  for (const [tool, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.reason !== 'string' || !REASONS.includes(entry.reason)) continue;
    out[tool] = { reason: entry.reason as FreezeReason, listed: typeof entry.listed === 'string' ? entry.listed : '', live: typeof entry.live === 'string' ? entry.live : null, at: typeof entry.at === 'string' ? entry.at : '' };
  }
  return out;
}

function readCeilings(value: unknown): Record<string, Ceiling> {
  const out: Record<string, Ceiling> = {};
  if (!isRecord(value)) return out;
  for (const [tool, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.unitMicros !== 'number' || !Number.isSafeInteger(entry.unitMicros) || entry.unitMicros < 1) continue;
    if (typeof entry.proof !== 'string' || !entry.proof.trim()) continue;
    out[tool] = { unitMicros: entry.unitMicros, proof: entry.proof.slice(0, 1000), savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : '', savedById: typeof entry.savedById === 'string' ? entry.savedById : null };
  }
  return out;
}

/** The tools that are frozen now; null when the list cannot be read (everything is then treated as frozen). */
export async function getFrozenTools(db: SettingsDb = prisma): Promise<Record<string, Frozen> | null> {
  try {
    return readFrozen((await db.appSetting.findUnique({ where: { key: FROZEN_KEY } }))?.value);
  } catch (error) {
    console.error('[Instant] Could not read the frozen tools:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The proven independent ceilings, by tool; empty when none or when they cannot be read (a ceiling that cannot be read lifts nothing). */
export async function getCeilings(db: SettingsDb = prisma): Promise<Record<string, Ceiling>> {
  try {
    return readCeilings((await db.appSetting.findUnique({ where: { key: CEILINGS_KEY } }))?.value);
  } catch (error) {
    console.error('[Instant] Could not read the ceilings:', error instanceof Error ? error.message : 'unknown');
    return {};
  }
}

/** A ceiling covers a tool when it is no higher than the top price the table reserves for one unit of it. */
export const ceilingCovers = (ceiling: Ceiling | undefined, tableUnitMicros: number): boolean => !!ceiling && ceiling.unitMicros <= tableUnitMicros;

/** Whether new runs of this tool are held back now: frozen with no covering ceiling, or the lists cannot be read. */
export async function toolIsFrozen(tool: string, tableUnitMicros: number, db: SettingsDb = prisma): Promise<boolean> {
  const frozen = await getFrozenTools(db);
  if (frozen === null) return true;
  if (!Object.prototype.hasOwnProperty.call(frozen, tool)) return false;
  return !ceilingCovers((await getCeilings(db))[tool], tableUnitMicros);
}

async function change(key: string, edit: (current: Record<string, unknown>) => Record<string, unknown> | null, lock: string, userId: string | null = null): Promise<void> {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))`;
    const row = await tx.appSetting.findUnique({ where: { key } });
    const next = edit(isRecord(row?.value) ? { ...row.value } : {});
    if (next === null) return;
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key }, create: { key, value, updatedById: userId }, update: { value, updatedById: userId } });
  });
}

/** Freezes a tool (the first record stands until it clears: a worse reading replaces a milder one only by clearing first). */
export async function freezeTool(tool: string, entry: { reason: FreezeReason; listed: string; live: string | null }, now: Date = new Date()): Promise<void> {
  await change(FROZEN_KEY, (current) => (Object.prototype.hasOwnProperty.call(current, tool) ? null : { ...current, [tool]: { ...entry, at: now.toISOString() } }), 'instant:freeze');
}

/** Clears the freeze of tools, by name; returns how many were frozen. Safe to say twice. */
export async function unfreezeTools(tools: string[]): Promise<number> {
  let cleared = 0;
  if (tools.length === 0) return 0;
  await change(
    FROZEN_KEY,
    (current) => {
      const next = { ...current };
      for (const tool of tools) {
        if (Object.prototype.hasOwnProperty.call(next, tool)) {
          delete next[tool];
          cleared += 1;
        }
      }
      return cleared > 0 ? next : null;
    },
    'instant:freeze',
  );
  return cleared;
}

/** A super admin saves (or, with null, removes) the proven independent ceiling of one tool. The proof is required: no proof, no ceiling. */
export async function saveCeiling(tool: string, input: { unitMicros: number; proof: string } | null, userId: string): Promise<Record<string, Ceiling>> {
  if (input && (!Number.isSafeInteger(input.unitMicros) || input.unitMicros < 1)) throw new Error('A ceiling is a whole number of millionths of a dollar, 1 or more');
  if (input && !input.proof.trim()) throw new Error('A ceiling needs the proof that backs it');
  await change(
    CEILINGS_KEY,
    (current) => {
      const next = { ...current };
      if (input) next[tool] = { unitMicros: input.unitMicros, proof: input.proof.trim().slice(0, 1000), savedAt: new Date().toISOString(), savedById: userId };
      else delete next[tool];
      return next;
    },
    'instant:ceilings',
    userId,
  );
  return getCeilings();
}
