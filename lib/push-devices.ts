import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The browsers and installed apps where someone turned on notifications (game #863). Each is a Web Push subscription that
 * Orbit sends to while Universe is closed; the person sees them under Settings > Notifications > Your devices.
 */

/** Oldest devices beyond this are dropped when another registers, so one account cannot pile them up. */
export const MAX_PUSH_DEVICES = 20;

export interface PushDeviceInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
}

export interface PushDeviceView {
  id: string;
  label: string;
  enabled: boolean;
  lastNotifiedAt: string | null;
  createdAt: string;
}

// Orbit sends to these addresses, so only the push services of the main browsers are kept: Chrome and the browsers
// built on it, Firefox, Edge and Safari.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The subscription a browser hands the game (`PushSubscription.toJSON()`) plus the device's name; null when unusable. */
export function readPushDeviceInput(body: unknown): PushDeviceInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { endpoint, keys, label } = body as { endpoint?: unknown; keys?: unknown; label?: unknown };
  if (!isPushEndpoint(endpoint)) return null;
  if (typeof keys !== 'object' || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  // A P-256 public key is 65 bytes (87 characters), the secret 16 bytes (22); a little room for padding.
  if (typeof p256dh !== 'string' || p256dh.length < 80 || p256dh.length > 100 || !BASE64URL.test(p256dh)) return null;
  if (typeof auth !== 'string' || auth.length < 16 || auth.length > 40 || !BASE64URL.test(auth)) return null;
  return { endpoint, p256dh, auth, label: deviceLabel(label) };
}

/** One plain line of at most 60 characters; "This browser" when none was given. */
export function deviceLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, 60) || 'This browser';
}

export function toPushDeviceView(device: {
  id: string;
  label: string;
  enabled: boolean;
  lastNotifiedAt: Date | null;
  createdAt: Date;
}): PushDeviceView {
  return {
    id: device.id,
    label: device.label,
    enabled: device.enabled,
    lastNotifiedAt: device.lastNotifiedAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
  };
}

const VIEW_SELECT = { id: true, label: true, enabled: true, lastNotifiedAt: true, createdAt: true } as const;

export async function listPushDevices(userId: string): Promise<PushDeviceView[]> {
  const devices = await prisma.pushDevice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: VIEW_SELECT });
  return devices.map(toPushDeviceView);
}

/**
 * Saves this browser's subscription for this person. The game calls it on every start, so the keys and name stay
 * current. A subscription another account registered on the same browser moves here: notifications follow whoever is
 * signed in, never the one who signed out. Keeps its own on/off switch when it was already this person's.
 */
export async function registerPushDevice(userId: string, input: PushDeviceInput): Promise<PushDeviceView> {
  try {
    return await savePushDevice(userId, input);
  } catch (error) {
    // Two tabs registering the same new browser at once: the second one finds the first one's row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return savePushDevice(userId, input);
    throw error;
  }
}

async function savePushDevice(userId: string, input: PushDeviceInput): Promise<PushDeviceView> {
  const now = new Date();
  const existing = await prisma.pushDevice.findUnique({ where: { endpoint: input.endpoint }, select: { userId: true } });
  const sameOwner = existing?.userId === userId;
  const device = await prisma.pushDevice.upsert({
    where: { endpoint: input.endpoint },
    create: { userId, ...input, lastSeenAt: now },
    update: {
      userId,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label,
      lastSeenAt: now,
      ...(sameOwner ? {} : { enabled: true, lastNotifiedAt: null, createdAt: now }),
    },
    select: VIEW_SELECT,
  });
  await dropOldestBeyondLimit(userId);
  return toPushDeviceView(device);
}

async function dropOldestBeyondLimit(userId: string): Promise<void> {
  const extra = await prisma.pushDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
    skip: MAX_PUSH_DEVICES,
    select: { id: true },
  });
  if (extra.length > 0) {
    await prisma.pushDevice.deleteMany({ where: { userId, id: { in: extra.map((device) => device.id) } } });
  }
}

/** The device's own switch; false when it is not this person's. */
export async function setPushDeviceEnabled(userId: string, id: string, enabled: boolean): Promise<boolean> {
  const result = await prisma.pushDevice.updateMany({ where: { id, userId }, data: { enabled } });
  return result.count > 0;
}

/** Remove in Your devices; false when it is not this person's. */
export async function removePushDevice(userId: string, id: string): Promise<boolean> {
  const result = await prisma.pushDevice.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** Signing out on a browser removes its subscription, so nothing arrives there after sign-out. */
export async function removePushDeviceByEndpoint(userId: string, endpoint: string): Promise<boolean> {
  const result = await prisma.pushDevice.deleteMany({ where: { endpoint, userId } });
  return result.count > 0;
}
