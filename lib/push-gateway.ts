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

/** Bots are the `universe-bots` app service users, on our own homeserver. */
const BOT_SENDER = /^@bot_[^:]+:(.+)$/;
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

/** Synapse sends one device per notification; a body with many is not from it. */
const MAX_DEVICES = 20;

export function readNotification(body: unknown): GatewayNotification | null {
  const notification = record(record(body)?.notification);
  if (!notification || !Array.isArray(notification.devices)) return null;
  const devices: GatewayDevice[] = [];
  for (const item of notification.devices) {
    if (devices.length >= MAX_DEVICES) break;
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
      // Only a recorded voice note is a voice message: Element's flag (MSC3245), `m.voice` once stable. A song or any
      // other audio file a person or bot sends has no flag.
      return content['org.matrix.msc3245.voice'] !== undefined || content['m.voice'] !== undefined
        ? 'sent a voice message'
        : 'sent an audio file';
    case 'm.file':
      return 'sent a file';
    default: {
      const body = text(content.body)?.replace(/\s+/g, ' ').trim();
      if (!body) return plain;
      return body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH - 1)}…` : body;
    }
  }
}

/**
 * What a Brick's message carries when it sent it by itself (a goal reached, a check that needs the person; game #2002,
 * mock t-3-lock). The bot server sets it on those messages only, never on an answer in a chat the person is in.
 */
export const OWN_INITIATIVE_KEY = 'net.bawes.universe.alone';
/** The news line that fills the title of the push: longer than this and the message is shown the ordinary way. */
const HEADLINE_LENGTH = 70;

/** Markdown read as plain words: only paired marks and a mark that opens a line, so `doc_id_42` and a bare `5 * 3` stay as written. */
const plainWords = (value: string) =>
  value
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gm, '')
    // A link's address may hold one level of balanced parentheses: [page](https://x.test/a_(b))
    .replace(/\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** What ends a sentence in the scripts people write in: Latin, Arabic and Urdu, Devanagari (danda), Armenian, Burmese, Khmer, Chinese and Japanese. */
const TERMINATORS = '.!?\\u061F\\u06D4\\u0964\\u0965\\u0589\\u104A\\u104B\\u17D4\\u17D5\\u3002\\uFF01\\uFF1F\\uFF0E\\u2026';
/** Quotes and brackets that may close after the stop: “Visa approved.” */
const CLOSERS = '\\u201D\\u2019"\'\\u00BB\\u300D\\u300F\\uFF09)\\]';
const ENDS_SENTENCE = new RegExp(`[${TERMINATORS}][${CLOSERS}]*$`, 'u');
const TRAILING_STOPS = new RegExp(`[${TERMINATORS}]+(?=[${CLOSERS}]*$)`, 'u');

/** A sentence that stops at one of these is not over yet ("Dr. Lee approved it"). Sentence breaking alone does not know them. */
const ABBREVIATION = new RegExp(`(?:^|[^\\p{L}])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|e\\.g|i\\.e|inc|ltd)\\.[${CLOSERS}]*$`, 'iu');
/** A capital initial on its own ("J. Smith"); case matters here, so a lowercase letter before the stop does not count. */
const INITIAL = new RegExp(`(?:^|[^\\p{L}])\\p{Lu}\\.[${CLOSERS}]*$`, 'u');

/** The first sentence of some words, for any script; null when there is none. */
function firstSentence(words: string): string | null {
  let sentence = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(words)) {
    sentence += segment;
    const done = sentence.trim();
    if (!ABBREVIATION.test(done) && !INITIAL.test(done)) return ENDS_SENTENCE.test(done) ? done : null;
  }
  return null;
}

/**
 * What a locked phone shows. A message a Brick sent by itself opens with its news, so that is the title and the rest
 * follows with the Brick's name: "Your visa is approved" / "Brick: it's in our chat and saved in my files. Goal done."
 * Everything else, and a message whose first sentence is too long to be a title, shows as before: the sender's name and
 * the message.
 */
export function pushText(
  notification: GatewayNotification,
  previews: boolean,
  senderName: string,
  ourBot: boolean,
): { title: string; body: string } {
  const ordinary = { title: senderName, body: messageLine(notification, previews, senderName) };
  const content = notification.content;
  if (!ourBot || !previews || notification.type !== 'm.room.message' || content?.msgtype === undefined || content[OWN_INITIATIVE_KEY] !== true) return ordinary;
  if (content.msgtype !== 'm.text' && content.msgtype !== 'm.notice') return ordinary;
  const words = plainWords(text(content.body) ?? '');
  const first = firstSentence(words);
  const title = first?.replace(TRAILING_STOPS, '').trim();
  if (!first || !title || title.length < 3 || title.length > HEADLINE_LENGTH) return ordinary;
  const rest = words.slice(first.length).trim();
  if (!rest) return { title, body: senderName };
  const line = `${senderName}: ${rest}`;
  return { title, body: line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line };
}

function secretMatches(stored: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One of our bots: `@bot_…` on the recipient's own homeserver. The same name from another server is someone else, and
 * goes through the checks below like any person.
 */
export function isOurBot(sender: string, recipientMatrixId: string | null): boolean {
  const server = BOT_SENDER.exec(sender)?.[1];
  const colon = recipientMatrixId?.indexOf(':') ?? -1;
  return server !== undefined && colon > 0 && recipientMatrixId!.slice(colon + 1) === server;
}

/** Whether `dmFrom` lets this sender through. Someone blocked either way never does. */
async function senderAllowed(recipientId: string, recipientMatrixId: string | null, sender: string, dmFrom: DmSource): Promise<boolean> {
  if (isOurBot(sender, recipientMatrixId)) return true;
  const person = await prisma.user.findFirst({ where: { matrixChatId: sender }, select: { id: true } });
  if (!person) return dmFrom === 'anyone';
  if (person.id === recipientId) return false;
  const pair = await prisma.friendship.findUnique({ where: { user1Id_user2Id: orderedPair(recipientId, person.id) }, select: { status: true } });
  if (pair?.status === 'blocked') return false;
  if (pair?.status === 'accepted' || dmFrom === 'anyone') return true;
  return dmFrom === 'friends_members' && sharesMemberWorld(recipientId, person.id);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function notifyDevice(userId: string, deviceId: string, notification: GatewayNotification, sender: string, ourBot: boolean): Promise<void> {
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
      ...pushText(notification, settings.previews, senderName, ourBot),
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
      if (!settings.directMessages || !(await senderAllowed(row.userId, row.user.matrixChatId, sender, settings.dmFrom))) return;
      await notifyDevice(row.userId, row.id, notification, sender, isOurBot(sender, row.user.matrixChatId));
    })().catch((error) => console.error('[Push] Direct message failed:', error instanceof Error ? error.message : 'unknown'));
  }
  return { rejected };
}
