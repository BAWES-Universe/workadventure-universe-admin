import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * A setting that suites of the real-database run share (the global limits, the meter settings, ...): read it before a suite changes it,
 * and put it back as it was afterwards, also when a test fails (call the returned function in `afterAll` or `finally`). A row that did not
 * exist is removed again; a row that did is written back with its own value and its own `updatedById`. Only the keys named are touched.
 */
export async function snapshotSettings(keys: string[]): Promise<() => Promise<void>> {
  const before = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
  return async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    for (const row of before) await prisma.appSetting.create({ data: { key: row.key, value: row.value as Prisma.InputJsonValue, updatedById: row.updatedById } });
  };
}
