import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The ready-made apps: a built-in list (DEFAULT_READY_MADE_APPS), every one on, signing in through the provider's own pages with
 * its own managed sign-in setup, so nothing has to be set for them to work. A super admin MAY change that, never must:
 *   app_settings 'ready-made-apps' = { apps: { [key]: { name?, authConfigId?, enabled? } } }
 * adds an app, renames one, turns one off, or points one at a sign-in setup of their own.
 */

const SETTING_KEY = 'ready-made-apps';
const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

/** The provider's app names (its toolkit slugs) and what people call them. */
export const DEFAULT_READY_MADE_APPS: { key: string; name: string }[] = [
  { key: 'gmail', name: 'Gmail' },
  { key: 'googlecalendar', name: 'Google Calendar' },
  { key: 'googledrive', name: 'Google Drive' },
  { key: 'googledocs', name: 'Google Docs' },
  { key: 'googlesheets', name: 'Google Sheets' },
  { key: 'outlook', name: 'Outlook' },
  { key: 'notion', name: 'Notion' },
  { key: 'slack', name: 'Slack' },
  { key: 'github', name: 'GitHub' },
  { key: 'linear', name: 'Linear' },
  { key: 'asana', name: 'Asana' },
  { key: 'trello', name: 'Trello' },
  { key: 'airtable', name: 'Airtable' },
  { key: 'hubspot', name: 'HubSpot' },
  { key: 'dropbox', name: 'Dropbox' },
  { key: 'todoist', name: 'Todoist' },
];

export const readyMadeAppSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    authConfigId: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const readyMadeSettingsSchema = z.object({ apps: z.record(z.string().regex(KEY), readyMadeAppSchema.nullable()) }).strict();

export interface ReadyMadeApp {
  key: string;
  name: string;
  /** A sign-in setup a super admin chose; null means the provider's own managed one, found or made when first needed. */
  authConfigId: string | null;
  enabled: boolean;
}

/** The built-in list with whatever a super admin changed laid over it. Always has the built-in apps, so it needs no setup. */
export async function readReadyMadeApps(): Promise<ReadyMadeApp[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  const value = row?.value;
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? (value as { apps?: unknown }).apps : null;
  const apps = new Map<string, ReadyMadeApp>(DEFAULT_READY_MADE_APPS.map((app) => [app.key, { ...app, authConfigId: null, enabled: true }]));
  if (saved && typeof saved === 'object') {
    for (const [key, raw] of Object.entries(saved as Record<string, unknown>)) {
      const parsed = readyMadeAppSchema.safeParse(raw);
      if (!parsed.success || !KEY.test(key)) continue;
      const base = apps.get(key);
      // An app that is not built in needs a name to be listed
      const name = parsed.data.name ?? base?.name;
      if (!name) continue;
      apps.set(key, { key, name, authConfigId: parsed.data.authConfigId ?? base?.authConfigId ?? null, enabled: parsed.data.enabled ?? base?.enabled ?? true });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A super admin's change: each key set, or removed with null (a built-in app then goes back to its built-in form). Only the keys it names change. */
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

