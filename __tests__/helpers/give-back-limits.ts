import { prisma } from '@/lib/db';

/**
 * The numbers the bound on computer give-backs reads, as the launch migration seeds them (Instant's pause rule: 20% once 10 runs happened; the give-back
 * numbers stay empty). A suite that gives a failed job back through the runner's finish needs them, as production has them.
 *
 * They live in ONE settings row shared by every database suite, so these suites must never run side by side: jest.config.js runs them with one worker whenever
 * ROLES_DB_TEST is set (`npm test` included), and __tests__/helpers/serial-db-suites.test.ts keeps it that way.
 */
export const LAUNCH_INSTANT_LIMITS = { maxRunMicros: 30_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 2000, pauseMinRuns: 10 };

export async function seedGiveBackLimits(extra: Record<string, number> = {}): Promise<void> {
  const value = { ...LAUNCH_INSTANT_LIMITS, ...extra };
  await prisma.appSetting.upsert({ where: { key: 'instant-limits' }, create: { key: 'instant-limits', value }, update: { value } });
}

export async function clearGiveBackLimits(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: 'instant-limits' } });
}
