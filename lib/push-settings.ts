import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * What someone wants notifications about, from whom and when (#863, Settings > Notifications). Kept as one
 * preference row, written only through /api/me/push/settings, so it is not in the general preference allowlist.
 */
export const PUSH_SETTINGS_KEY = 'notifications.push';

export const DM_SOURCES = ['friends_members', 'friends', 'anyone'] as const;
export type DmSource = (typeof DM_SOURCES)[number];

export interface QuietHours {
  /** "HH:MM", 24 hours, in `timeZone` */
  start: string;
  end: string;
  timeZone: string;
}

export interface PushSettings {
  /** Notify me about */
  directMessages: boolean;
  friendRequests: boolean;
  memberships: boolean;
  friendInRoom: boolean;
  friendLive: boolean;
  /** Direct messages from */
  dmFrom: DmSource;
  /** Show message text; off shows "New message from Sara" */
  previews: boolean;
  /** null = Off */
  quietHours: QuietHours | null;
}

/** The approved defaults: messages, friend requests and memberships on; a friend in your room and going live off. */
export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  directMessages: true,
  friendRequests: true,
  memberships: true,
  friendInRoom: false,
  friendLive: false,
  dmFrom: 'friends_members',
  previews: true,
  quietHours: null,
};

const SWITCHES = ['directMessages', 'friendRequests', 'memberships', 'friendInRoom', 'friendLive', 'previews'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readQuietHours(value: unknown): QuietHours | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { start, end, timeZone } = value as Record<string, unknown>;
  if (typeof start !== 'string' || !TIME.test(start) || typeof end !== 'string' || !TIME.test(end) || start === end) {
    return undefined;
  }
  return isTimeZone(timeZone) ? { start, end, timeZone } : undefined;
}

/**
 * Applies a change of some settings on top of `current`. Null when anything in it is unknown or the wrong shape,
 * so a typo never half-saves.
 */
export function applyPushSettingsChange(current: PushSettings, change: unknown): PushSettings | null {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return null;
  const next: PushSettings = { ...current };
  for (const [key, value] of Object.entries(change)) {
    if ((SWITCHES as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return null;
      next[key as (typeof SWITCHES)[number]] = value;
    } else if (key === 'dmFrom') {
      if (!(DM_SOURCES as readonly unknown[]).includes(value)) return null;
      next.dmFrom = value as DmSource;
    } else if (key === 'quietHours') {
      const quietHours = readQuietHours(value);
      if (quietHours === undefined) return null;
      next.quietHours = quietHours;
    } else {
      return null;
    }
  }
  return next;
}

/** A stored row read leniently: anything missing or no longer valid falls back to its default. */
export function readStoredPushSettings(value: unknown): PushSettings {
  const settings: PushSettings = { ...DEFAULT_PUSH_SETTINGS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return settings;
  for (const [key, item] of Object.entries(value)) {
    const applied = applyPushSettingsChange(settings, { [key]: item });
    if (applied) Object.assign(settings, applied);
  }
  return settings;
}

export async function getPushSettings(userId: string): Promise<PushSettings> {
  const row = await prisma.userPreference.findUnique({
    where: { userId_key: { userId, key: PUSH_SETTINGS_KEY } },
    select: { value: true },
  });
  return readStoredPushSettings(row?.value);
}

/** Saves a change of some settings; null when the change is not valid. */
export async function updatePushSettings(userId: string, change: unknown): Promise<PushSettings | null> {
  const next = applyPushSettingsChange(await getPushSettings(userId), change);
  if (!next) return null;
  const value = next as unknown as Prisma.InputJsonValue;
  await prisma.userPreference.upsert({
    where: { userId_key: { userId, key: PUSH_SETTINGS_KEY } },
    create: { userId, key: PUSH_SETTINGS_KEY, value },
    update: { value },
  });
  return next;
}
