import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { orderedPair, sharesMemberWorld } from '@/lib/friends';
import { sendPush } from '@/lib/push';
import { getActivity, messageDecision, isFront } from '@/lib/push-activity';
import { getPushSettings, type DmSource } from '@/lib/push-settings';

/**
 * Orbit as the Matrix push gateway for direct messages (game #863). Each device's game registers a standard HTTP
 * pusher on Synapse pointing here; Synapse posts every message that its push rules say to notify about, and Orbit
 * keeps the ones the approved rules want: a direct message from a friend or a member (or anyone, by setting), or a
 * bot replying to you, that the person is not already looking at.
 * Spec: https://spec.matrix.org/v1.11/push-gateway-api/
 */

export const PUSH_APP_ID = 'net.bawes.universe.web';
export const GATEWAY_PATH = '/_matrix/push/v1/notify';

/** Bots are the `universe-bots` app service users. */
const BOT_SENDER = /^@bot_[^:]+:/;
const PREVIEW_LENGTH = 120;

interface GatewayDevice {
  pushkey: string;
  data: Record<string, unknown>;
  tweaks: Record<string, unknown>;
}

export interface GatewayNotification {
  eventId: string | null;
  roomId: string | null;
  type: string | null;
  sender: string | null;
  senderName: string | null;
  roomName: string | null;
  content: Record<string, unknown> | null;
  devices: GatewayDevice[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function readNotification(body: unknown): GatewayNotification | null {
  const notification = record(record(body)?.notification);
  if (!notification || !Array.isArray(notification.devices)) return null;
  const devices: GatewayDevice[] = [];
  for (const item of notification.devices) {
    const device = record(item);
    const pushkey = text(device?.pushkey);
    if (device && pushkey && device.app_id === PUSH_APP_ID) {
      devices.push({ pushkey, data: record(device.data) ?? {}, tweaks: record(device.tweaks) ?? {} });
    }
  }
  return {
    eventId: text(notification.event_id),
    roomId: text(notification.room_id),
    type: text(notification.type),
    sender: text(notification.sender),
    senderName: text(notification.sender_display_name),
    roomName: text(notification.room_name),
    content: record(notification.content),
    devices,
  };
}

/**
 * A message in a chat of two. Synapse's push rule for chats of two adds a sound and no highlight; a mention adds a
 * highlight in any chat, so there a chat without a name (a direct message has none) decides.
 */
export function isDirectMessage(notification: GatewayNotification, tweaks: Record<string, unknown>): boolean {
  if (notification.type !== 'm.room.message' && notification.type !== 'm.room.encrypted') return false;
  if (tweaks.highlight === true) return notification.roomName === null;
  return tweaks.sound !== undefined;
}

/**
 * "are you coming to standup?", or what kind of message it is; "New message from Sara" when message text is off or
 * cannot be read.
 */
export function messageLine(notification: GatewayNotification, previews: boolean, senderName: string): string {
  const content = notification.content;
  const plain = `New message from ${senderName}`;
  if (!previews || notification.type !== 'm.room.message' || !content) return plain;
  switch (content.msgtype) {
    case 'm.image':
      return 'sent an image';
    case 'm.video':
      return 'sent a video';
    case 'm.audio':
      return 'sent a voice message';
    case 'm.file':
      return 'sent a file';
    default: {
      const body = text(content.body)?.replace(/\s+/g, ' ').trim();
      if (!body) return plain;
      return body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH - 1)}…` : body;
    }
  }
}

function secretMatches(stored: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether `dmFrom` lets this sender through. Someone blocked either way never does. */
async function senderAllowed(recipientId: string, sender: string, dmFrom: DmSource): Promise<boolean> {
  if (BOT_SENDER.test(sender)) return true;
  const person = await prisma.user.findFirst({ where: { matrixChatId: sender }, select: { id: true } });
  if (!person) return dmFrom === 'anyone';
  if (person.id === recipientId) return false;
  const pair = await prisma.friendship.findUnique({ where: { user1Id_user2Id: orderedPair(recipientId, person.id) }, select: { status: true } });
  if (pair?.status === 'blocked') return false;
  if (pair?.status === 'accepted' || dmFrom === 'anyone') return true;
  return dmFrom === 'friends_members' && sharesMemberWorld(recipientId, person.id);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function notifyDevice(userId: string, deviceId: string, notification: GatewayNotification, sender: string): Promise<void> {
  const roomId = notification.roomId!;
  const decision = messageDecision(await getActivity(userId), roomId, new Date());
  if ('skip' in decision) return;
  if ('waitMs' in decision) {
    await wait(decision.waitMs);
    // Back in Universe within the minute: they see it there
    if (isFront(await getActivity(userId), new Date())) return;
  }
  const settings = await getPushSettings(userId);
  const senderName = notification.senderName ?? sender;
  await sendPush(
    userId,
    'directMessages',
    {
      title: senderName,
      body: messageLine(notification, settings.previews, senderName),
      tag: `chat:${roomId}`,
      chatRoomId: roomId,
    },
    { urgency: 'high', deviceIds: [deviceId] },
  );
}

/**
 * Handles one post from Synapse and answers the pushkeys it should drop: devices that are gone, or that moved to
 * someone else since the pusher was set (their secret no longer matches). Sending goes on after the answer.
 */
export async function handleGatewayNotification(body: unknown): Promise<{ rejected: string[] } | null> {
  const notification = readNotification(body);
  if (!notification) return null;
  const rejected: string[] = [];
  const pushkeys = notification.devices.map((device) => device.pushkey);
  const stored = pushkeys.length
    ? await prisma.pushDevice.findMany({ where: { id: { in: pushkeys } }, select: { id: true, userId: true, gatewaySecret: true, user: { select: { matrixChatId: true } } } })
    : [];

  for (const device of notification.devices) {
    const row = stored.find((item) => item.id === device.pushkey);
    if (!row || !row.gatewaySecret || !secretMatches(row.gatewaySecret, device.data.secret)) {
      rejected.push(device.pushkey);
      continue;
    }
    // A change of unread counts only, or an event this does not notify about
    const { eventId, roomId, sender } = notification;
    if (!eventId || !roomId || !sender || sender === row.user.matrixChatId || !isDirectMessage(notification, device.tweaks)) continue;

    void (async () => {
      const settings = await getPushSettings(row.userId);
      if (!settings.directMessages || !(await senderAllowed(row.userId, sender, settings.dmFrom))) return;
      await notifyDevice(row.userId, row.id, notification, sender);
    })().catch((error) => console.error('[Push] Direct message failed:', error instanceof Error ? error.message : 'unknown'));
  }
  return { rejected };
}
