import { createHash } from 'node:crypto';
import webpush, { WebPushError } from 'web-push';
import { prisma } from '@/lib/db';
import { getPushSettings, type PushSettings, type QuietHours } from '@/lib/push-settings';
import { vapidPublicKey } from '@/lib/push-vapid';

/**
 * Sends a notification to every device where someone turned them on (game #863), when their settings want this kind
 * and it is not their quiet hours. What arrives is a title and one line; a tap opens `url` or the chat.
 */

/** The "Notify me about" switch each notification belongs to. */
export type PushKind = 'directMessages' | 'friendRequests' | 'memberships' | 'friendInRoom' | 'friendLive';

export interface PushMessage {
  title: string;
  body: string;
  /** One notification per tag on a device: a newer one takes the place of the one still showing. */
  tag: string;
  chatRoomId?: string;
  url?: string;
}

export interface PushOptions {
  /** How long the push service keeps it for a device that is offline, in seconds. */
  ttl?: number;
  urgency?: 'normal' | 'high';
  /** Only these of the person's devices (a direct message arrives once per device); all of them when left out. */
  deviceIds?: string[];
}

const DAY = 24 * 60 * 60;

function vapidDetails() {
  const publicKey = vapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** "HH:MM" now in `timeZone`. */
function localTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Inside quiet hours, including ones that run past midnight (22:00 to 07:00). */
export function inQuietHours(quietHours: QuietHours | null, now: Date): boolean {
  if (!quietHours) return false;
  const time = localTime(now, quietHours.timeZone);
  const { start, end } = quietHours;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function wantsPush(settings: PushSettings, kind: PushKind, now: Date): boolean {
  return settings[kind] && !inQuietHours(settings.quietHours, now);
}

/** The push service keeps only the newest undelivered push of one topic: at most 32 URL-safe characters. */
export function pushTopic(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/**
 * Sends `message` to the person's switched-on devices; answers how many took it. Never throws: a notification that
 * fails must not fail what caused it. A device the push service says is gone (404, 410) is removed.
 */
export async function sendPush(userId: string, kind: PushKind, message: PushMessage, options: PushOptions = {}): Promise<number> {
  try {
    const vapid = vapidDetails();
    if (!vapid) return 0;
    const now = new Date();
    if (!wantsPush(await getPushSettings(userId), kind, now)) return 0;

    const devices = await prisma.pushDevice.findMany({
      where: { userId, enabled: true, ...(options.deviceIds ? { id: { in: options.deviceIds } } : {}) },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (devices.length === 0) return 0;

    const payload = JSON.stringify(message);
    const sendOptions = {
      vapidDetails: vapid,
      TTL: options.ttl ?? DAY,
      urgency: options.urgency ?? 'normal',
      topic: pushTopic(message.tag),
    };
    const results = await Promise.all(
      devices.map(async (device) => {
        try {
          await webpush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, sendOptions);
          return device.id;
        } catch (error) {
          if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
            await prisma.pushDevice.deleteMany({ where: { id: device.id } });
          } else {
            console.error('[Push] Send failed:', error instanceof WebPushError ? error.statusCode : error instanceof Error ? error.message : 'unknown');
          }
          return null;
        }
      }),
    );
    const delivered = results.filter((id): id is string => id !== null);
    if (delivered.length > 0) {
      await prisma.pushDevice.updateMany({ where: { id: { in: delivered } }, data: { lastNotifiedAt: now } });
    }
    return delivered.length;
  } catch (error) {
    console.error('[Push] Notify failed:', error instanceof Error ? error.message : 'unknown');
    return 0;
  }
}

// A friend request sent, taken back and sent again notifies once a day, not every time.
const ONCE_A_DAY_MS = DAY * 1000;
const recentlySent = new Map<string, number>();

/** Like sendPush, but the same tag reaches the same person at most once a day (kept in memory, so per server). */
export async function sendPushOnceADay(userId: string, kind: PushKind, message: PushMessage, options?: PushOptions): Promise<number> {
  const key = `${userId}:${message.tag}`;
  const now = Date.now();
  const last = recentlySent.get(key);
  if (last !== undefined && now - last < ONCE_A_DAY_MS) return 0;
  if (recentlySent.size > 10_000) {
    for (const [entry, at] of recentlySent) if (now - at >= ONCE_A_DAY_MS) recentlySent.delete(entry);
  }
  recentlySent.set(key, now);
  return sendPush(userId, kind, message, options);
}
