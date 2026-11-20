import { prisma } from '@/lib/db';

/**
 * The numbers the bound on computer give-backs reads, as the launch migration seeds them (Instant's pause rule: 20% once 10 runs happened; the give-back
 * numbers stay empty). A suite that gives a failed job back through the runner's finish needs them, as production has them.
 */
export const LAUNCH_INSTANT_LIMITS = { maxRunMicros: 30_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 2000, pauseMinRuns: 10 };

export async function seedGiveBackLimits(extra: Record<string, number> = {}): Promise<void> {
  const value = { ...LAUNCH_INSTANT_LIMITS, ...extra };
  await prisma.appSetting.upsert({ where: { key: 'instant-limits' }, create: { key: 'instant-limits', value }, update: { value } });
}

export async function clearGiveBackLimits(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
}
