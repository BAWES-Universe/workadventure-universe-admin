import type { Prisma } from '@prisma/client';
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

/** One tab where Universe is in front: when it last said so, and the chat open there. */
export interface FrontTab {
  at: number;
  chatRoomId: string | null;
}

export interface Activity {
  /** By tab id, so one device going to the back leaves the others in front */
  fronts: Record<string, FrontTab>;
  leftChatRoomId: string | null;
  leftChatAt: Date | null;
}

/** More tabs than anyone keeps in front at once; past this the oldest reports go. */
export const MAX_FRONT_TABS = 10;

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function readActivityReport(body: unknown): ActivityReport | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { tabId, front, chatRoomId } = body as Record<string, unknown>;
  if (typeof tabId !== 'string' || !TAB_ID.test(tabId) || typeof front !== 'boolean') return null;
  if (chatRoomId !== null && chatRoomId !== undefined && (typeof chatRoomId !== 'string' || chatRoomId.length > 255)) return null;
  return { tabId, front, chatRoomId: front ? (chatRoomId ?? null) : null };
}

const isFresh = (tab: FrontTab, now: Date) => now.getTime() - tab.at < FRONT_FRESH_MS;

/** The tabs still in front, newest first, at most MAX_FRONT_TABS. */
function freshFronts(fronts: Record<string, FrontTab>, now: Date): [string, FrontTab][] {
  return Object.entries(fronts)
    .filter(([, tab]) => isFresh(tab, now))
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_FRONT_TABS);
}

/** The row after a report: a chat that stops being open in front in that tab becomes the one just left. */
export function nextActivity(current: Activity | null, report: ActivityReport, now: Date): Activity {
  const previous: Activity = current ?? { fronts: {}, leftChatRoomId: null, leftChatAt: null };
  const before = previous.fronts[report.tabId]?.chatRoomId ?? null;
  const others = freshFronts(previous.fronts, now).filter(([tabId]) => tabId !== report.tabId);
  const tabs = report.front ? [[report.tabId, { at: now.getTime(), chatRoomId: report.chatRoomId }] as const, ...others] : others;
  const next: Activity = { ...previous, fronts: Object.fromEntries(tabs.slice(0, MAX_FRONT_TABS)) };
  if (before && before !== report.chatRoomId) {
    next.leftChatRoomId = before;
    next.leftChatAt = now;
  }
  return next;
}

export function isFront(activity: Activity | null, now: Date): boolean {
  return Object.values(activity?.fronts ?? {}).some((tab) => isFresh(tab, now));
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

/** The stored tabs, keeping only well-formed ones. */
function readFronts(value: unknown): Record<string, FrontTab> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const fronts: Record<string, FrontTab> = {};
  for (const [tabId, tab] of Object.entries(value as Record<string, unknown>)) {
    const { at, chatRoomId } = (tab ?? {}) as Record<string, unknown>;
    if (typeof at === 'number' && (typeof chatRoomId === 'string' || chatRoomId === null)) fronts[tabId] = { at, chatRoomId };
  }
  return fronts;
}

export async function getActivity(userId: string): Promise<Activity | null> {
  const row = await prisma.pushActivity.findUnique({ where: { userId }, select: { fronts: true, leftChatRoomId: true, leftChatAt: true } });
  return row && { fronts: readFronts(row.fronts), leftChatRoomId: row.leftChatRoomId, leftChatAt: row.leftChatAt };
}

/**
 * Two tabs reporting at the same moment can each write over the other's report; the one lost comes back with that
 * tab's next report, 30 seconds later at most.
 */
export async function recordActivity(userId: string, report: ActivityReport): Promise<void> {
  const next = nextActivity(await getActivity(userId), report, new Date());
  const data = { fronts: next.fronts as unknown as Prisma.InputJsonObject, leftChatRoomId: next.leftChatRoomId, leftChatAt: next.leftChatAt };
  await prisma.pushActivity.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}
