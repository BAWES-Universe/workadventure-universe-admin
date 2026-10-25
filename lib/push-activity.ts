import { prisma } from '@/lib/db';

/**
 * Where someone is in Universe right now (game #863). The game reports it while Universe is in front, and when it
 * goes to the back, so a direct message they are looking at, or will see in Universe, sends no notification.
 */

/** The game reports every 30 seconds while in front; a report older than this means Universe is not in front. */
export const FRONT_FRESH_MS = 45_000;
/** A message in a chat just left waits this long from leaving: they may come straight back to it. */
export const JUST_LEFT_HOLD_MS = 60_000;

export interface ActivityReport {
  /** Random per tab, so another tab going to the back does not undo this one being in front */
  tabId: string;
  front: boolean;
  /** The chat open in front, if any */
  chatRoomId: string | null;
}

export interface Activity {
  frontAt: Date | null;
  frontTabId: string | null;
  openChatRoomId: string | null;
  leftChatRoomId: string | null;
  leftChatAt: Date | null;
}

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function readActivityReport(body: unknown): ActivityReport | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { tabId, front, chatRoomId } = body as Record<string, unknown>;
  if (typeof tabId !== 'string' || !TAB_ID.test(tabId) || typeof front !== 'boolean') return null;
  if (chatRoomId !== null && chatRoomId !== undefined && (typeof chatRoomId !== 'string' || chatRoomId.length > 255)) return null;
  return { tabId, front, chatRoomId: front ? (chatRoomId ?? null) : null };
}

/** The row after a report: a chat that stops being the one open in front becomes the one just left. */
export function nextActivity(current: Activity | null, report: ActivityReport, now: Date): Activity {
  const previous: Activity = current ?? { frontAt: null, frontTabId: null, openChatRoomId: null, leftChatRoomId: null, leftChatAt: null };
  // Another tab still counts as in front until its own report goes stale
  if (!report.front && previous.frontTabId !== null && previous.frontTabId !== report.tabId && isFront(previous, now)) {
    return previous;
  }
  const next: Activity = {
    ...previous,
    frontAt: report.front ? now : null,
    frontTabId: report.front ? report.tabId : null,
    openChatRoomId: report.chatRoomId,
  };
  if (previous.openChatRoomId && previous.openChatRoomId !== report.chatRoomId) {
    next.leftChatRoomId = previous.openChatRoomId;
    next.leftChatAt = now;
  }
  return next;
}

export function isFront(activity: Activity | null, now: Date): boolean {
  return activity?.frontAt != null && now.getTime() - activity.frontAt.getTime() < FRONT_FRESH_MS;
}

/**
 * What a new direct message in `chatRoomId` does now: nothing while Universe is in front on any device (they see it
 * there), wait while the chat was left less than a minute ago, otherwise notify.
 */
export function messageDecision(activity: Activity | null, chatRoomId: string, now: Date): { skip: true } | { waitMs: number } | { send: true } {
  if (isFront(activity, now)) return { skip: true };
  if (activity?.leftChatRoomId === chatRoomId && activity.leftChatAt) {
    const waitMs = activity.leftChatAt.getTime() + JUST_LEFT_HOLD_MS - now.getTime();
    if (waitMs > 0) return { waitMs };
  }
  return { send: true };
}

const SELECT = { frontAt: true, frontTabId: true, openChatRoomId: true, leftChatRoomId: true, leftChatAt: true } as const;

export function getActivity(userId: string): Promise<Activity | null> {
  return prisma.pushActivity.findUnique({ where: { userId }, select: SELECT });
}

export async function recordActivity(userId: string, report: ActivityReport): Promise<void> {
  const next = nextActivity(await getActivity(userId), report, new Date());
  await prisma.pushActivity.upsert({ where: { userId }, create: { userId, ...next }, update: next });
}
