import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The ready-made apps a super admin lists (never in code), and the adapter's sign-in setup for each:
 *   app_settings 'ready-made-apps' = { apps: { [key]: { name, authConfigId, enabled } } }
 */

const SETTING_KEY = 'ready-made-apps';
const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

export const readyMadeAppSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    authConfigId: z.string().trim().min(1).max(255),
    enabled: z.boolean().default(true),
  })
  .strict();

export const readyMadeSettingsSchema = z.object({ apps: z.record(z.string().regex(KEY), readyMadeAppSchema.nullable()) }).strict();

export interface ReadyMadeApp {
  key: string;
  name: string;
  authConfigId: string;
  enabled: boolean;
}

export async function readReadyMadeApps(): Promise<ReadyMadeApp[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  const value = row?.value;
  const apps = value && typeof value === 'object' && !Array.isArray(value) ? (value as { apps?: unknown }).apps : null;
  if (!apps || typeof apps !== 'object') return [];
  const out: ReadyMadeApp[] = [];
  for (const [key, raw] of Object.entries(apps as Record<string, unknown>)) {
    const parsed = readyMadeAppSchema.safeParse(raw);
    if (parsed.success && KEY.test(key)) out.push({ key, ...parsed.data });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A super admin's change: each key set, or removed with null. Only the keys it names change. */
export async function saveReadyMadeApps(change: z.infer<typeof readyMadeSettingsSchema>, userId: string): Promise<ReadyMadeApp[]> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ready-made-apps'))`;
    const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const saved = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? ((row.value as { apps?: Record<string, unknown> }).apps ?? {}) : {};
    const apps: Record<string, unknown> = { ...saved };
    for (const [key, app] of Object.entries(change.apps)) {
      if (app === null) delete apps[key];
      else apps[key] = app;
    }
    const value = { apps } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
  });
  return readReadyMadeApps();
}

export const authConfigFor = async (key: string): Promise<string | null> => (await readReadyMadeApps()).find((app) => app.key === key && app.enabled)?.authConfigId ?? null;

