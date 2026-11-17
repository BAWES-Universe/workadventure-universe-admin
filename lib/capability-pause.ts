import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getInstantPause, pauseInstant, resumeInstant } from '@/lib/instant/state';

/**
 * The team's pause for each paid capability on its own: Instant, Apps and computers (spec "pause now"). A pause is one row in the
 * app's own settings table that every new piece of work reads first, so it takes hold at once and needs no restart. A paused
 * capability takes no NEW work and says so kindly; what it already made (files, pages, finished jobs) is kept, and work already
 * going finishes and is settled as always. Nothing here is a setting for people: only a super admin pauses and resumes.
 *
 * Instant keeps its own state (`lib/instant/state.ts`): it also pauses itself when too many runs fail or a price moves, and a super
 * admin's pause is the same pause, so one resume answers both. Apps and computers keep a row each.
 */

export const CAPABILITIES = ['instant', 'apps', 'computers'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (value: unknown): value is Capability => typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);

export interface CapabilityPause {
  paused: boolean;
  /** A fixed word for why: `manual` for a super admin's pause; for Instant also what it paused itself for; `unreadable` when the row could not be read. */
  reason: string | null;
  /** When it was paused (ISO), when known. */
  at: string | null;
}

const KEYS = { apps: 'apps-pause', computers: 'computer-pause' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type SettingsDb = Pick<typeof prisma, 'appSetting'>;

async function readRow(key: string, db: SettingsDb = prisma): Promise<CapabilityPause> {
  try {
    const row = await db.appSetting.findUnique({ where: { key } });
    const value = isRecord(row?.value) ? row.value : {};
    if (value.paused !== true) return { paused: false, reason: null, at: null };
    return { paused: true, reason: 'manual', at: typeof value.at === 'string' ? value.at : null };
  } catch (error) {
    // A pause that cannot be read is a pause: nothing new runs on a guess
    console.error(`[Pause] Could not read the pause (${key}):`, error instanceof Error ? error.message : 'unknown');
    return { paused: true, reason: 'unreadable', at: null };
  }
}

/** Where one capability stands now. */
export async function getCapabilityPause(capability: Capability): Promise<CapabilityPause> {
  if (capability === 'instant') {
    const pause = await getInstantPause();
    return { paused: pause.paused, reason: pause.reason, at: pause.at };
  }
  return readRow(KEYS[capability]);
}

/** All three, for the page and for the team's own checks. */
export async function getCapabilityPauses(): Promise<Record<Capability, CapabilityPause>> {
  const [instant, apps, computers] = await Promise.all([getCapabilityPause('instant'), getCapabilityPause('apps'), getCapabilityPause('computers')]);
  return { instant, apps, computers };
}

/** True while Apps are paused: a use of an App is refused before anything is counted or sent. */
export async function appsArePaused(): Promise<boolean> {
  return (await readRow(KEYS.apps)).paused;
}

/**
 * Whether a call to an App is refused because the team paused Apps. A call id that was already asked (the books hold its line,
 * `app:<brick>:<call id>`) is never "paused": the retry of a call that already ran must hear "already asked", never "not done",
 * so it is not sent again. Reads like the pause does: a read that fails is a pause.
 */
export async function appCallIsPaused(botId: string, callId: string | null | undefined): Promise<boolean> {
  if (!(await appsArePaused())) return false;
  if (!callId) return true;
  try {
    return !(await prisma.meterEvent.findUnique({ where: { eventId: `app:${botId}:${callId}` }, select: { id: true } }));
  } catch {
    return true;
  }
}

/** True while computers are paused: no new job starts, and a job in line waits with its work saved. */
export async function computersArePaused(): Promise<boolean> {
  return (await readRow(KEYS.computers)).paused;
}

async function writeRow(key: string, value: Record<string, unknown>, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pause:${key}`}))`;
    const json = value as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key }, create: { key, value: json, updatedById: userId }, update: { value: json, updatedById: userId } });
  });
}

/** Pauses one capability at once. Asked twice it is the same: the first time stands (and for Instant the first reason stands). */
export async function pauseCapability(capability: Capability, userId: string): Promise<CapabilityPause> {
  if (capability === 'instant') {
    await pauseInstant('manual', userId);
    return getCapabilityPause('instant');
  }
  const key = KEYS[capability];
  const now = await readRow(key);
  if (now.paused && now.reason === 'manual') return now;
  await writeRow(key, { paused: true, at: new Date().toISOString() }, userId);
  console.warn(`[Pause] ${capability} paused by`, userId);
  return readRow(key);
}

/** Resumes one capability at once. Asked twice it is the same. */
export async function resumeCapability(capability: Capability, userId: string): Promise<CapabilityPause> {
  if (capability === 'instant') {
    await resumeInstant(userId);
    return getCapabilityPause('instant');
  }
  const key = KEYS[capability];
  await writeRow(key, { paused: false, at: null }, userId);
  console.warn(`[Pause] ${capability} resumed by`, userId);
  return readRow(key);
}

/** Why Instant is paused, in the team's words (it can pause itself). */
export function pauseReasonWords(capability: Capability, reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'manual') return 'Paused by the team';
  if (reason === 'unreadable') return 'Paused: its state could not be read';
  if (capability !== 'instant') return 'Paused';
  switch (reason) {
    case 'failure_rate':
      return 'Paused by itself: too many runs failed';
    case 'price_over_top':
      return 'Paused by itself: a price went over its top';
    case 'price_drift':
      return 'Paused by itself: a price changed';
    case 'provider_empty':
      return 'Paused by itself: the provider’s balance ran out';
    default:
      return 'Paused';
  }
}
