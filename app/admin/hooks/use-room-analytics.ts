'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { formatHour as formatHourShared, localPeakHour } from '@/lib/analytics-peak';

export interface RoomVisit {
  accessedAt: string;
  userId?: string | null;
  userUuid?: string | null;
  /** Only when the viewer may see who visited (a manager of the room, or a super admin). */
  userName?: string | null;
}

/** A universe's, world's or room's activity, as every card shows it. */
export interface RoomAnalytics {
  totalAccesses: number | null;
  /** The busiest hour of the day on the viewer's own clock, from the API's all-time UTC hour buckets. */
  peakHour: number | null;
  /** Always the viewer's clock now; kept for callers that read it. */
  peakZone: 'local' | 'UTC';
  lastVisitedByUser: RoomVisit | null;
  lastVisitedOverall: RoomVisit | null;
  /** The server's answer to "was the latest visitor you?", decided by identity. */
  youWereLast: boolean;
}

export type EntitySummary = RoomAnalytics;
export type SummaryKind = 'rooms' | 'worlds' | 'universes';

interface AnalyticsResponse {
  totalAccesses?: number;
  peakTimes?: Array<{ hour: number; count: number }>;
  recentActivity?: Array<{ accessedAt: string }>;
  lastVisitedByUser?: RoomVisit | null;
  lastVisitedOverall?: RoomVisit | null;
  youWereLast?: boolean;
}

function validVisit(visit?: RoomVisit | null): RoomVisit | null {
  return visit && Number.isFinite(new Date(visit.accessedAt).getTime()) ? visit : null;
}

/** Identity, not timestamps: the same moment is not enough, the record has to name you. */
function sameVisitor(yours: RoomVisit | null, last: RoomVisit | null): boolean {
  if (!yours || !last) return false;
  return Boolean(
    (yours.userId && last.userId && yours.userId === last.userId) ||
      (yours.userUuid && last.userUuid && yours.userUuid === last.userUuid),
  );
}

export function fromAnalytics(data: AnalyticsResponse): RoomAnalytics {
  const lastVisitedByUser = validVisit(data.lastVisitedByUser);
  const lastVisitedOverall = validVisit(data.lastVisitedOverall);
  return {
    totalAccesses:
      typeof data.totalAccesses === 'number' && Number.isFinite(data.totalAccesses) && data.totalAccesses >= 0
        ? data.totalAccesses
        : null,
    peakHour: localPeakHour(data.peakTimes),
    peakZone: 'local',
    lastVisitedByUser,
    lastVisitedOverall,
    // The server decides; an older response without the flag falls back to comparing ids (never timestamps).
    youWereLast:
      typeof data.youWereLast === 'boolean'
        ? data.youWereLast && Boolean(lastVisitedOverall)
        : sameVisitor(lastVisitedByUser, lastVisitedOverall),
  };
}

/** Whether the latest visitor was you: the server's identity check, never equal timestamps. */
export function wasLastVisitorYou(analytics: RoomAnalytics): boolean {
  return analytics.youWereLast;
}

/** "4 PM", "12 AM". */
export const formatHour = formatHourShared;

// One answer per place per page view, shared by every card and list showing it. Places asked for together (a
// list's cards mounting) go out as one request per kind.
const cache = new Map<string, Promise<RoomAnalytics | null>>();
const cacheKey = (kind: SummaryKind, id: string) => `${kind}:${id}`;

/** The summaries endpoint takes at most this many ids. */
const BATCH_LIMIT = 100;
const waiting = new Map<SummaryKind, Map<string, (analytics: RoomAnalytics | null) => void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchBatch(kind: SummaryKind, ids: string[]): Promise<Record<string, RoomAnalytics | null>> {
  const answers: Record<string, RoomAnalytics | null> = {};
  try {
    const query = new URLSearchParams({ kind, ids: ids.join(',') });
    const response = await authenticatedFetch(`/api/admin/analytics/summaries?${query.toString()}`);
    const data: unknown = response.ok ? await response.json() : null;
    const summaries = isRecord(data) && isRecord(data.summaries) ? data.summaries : null;
    for (const id of ids) {
      const summary = summaries?.[id];
      answers[id] = isRecord(summary) ? fromAnalytics(summary as AnalyticsResponse) : null;
    }
  } catch {
    for (const id of ids) answers[id] = null;
  }
  return answers;
}

function flush() {
  flushTimer = null;
  const batches = Array.from(waiting);
  waiting.clear();
  for (const [kind, pending] of batches) {
    const ids = Array.from(pending.keys());
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
      const chunk = ids.slice(start, start + BATCH_LIMIT);
      void fetchBatch(kind, chunk).then((answers) => {
        for (const id of chunk) pending.get(id)?.(answers[id] ?? null);
      });
    }
  }
}

function requestSummary(kind: SummaryKind, id: string): Promise<RoomAnalytics | null> {
  return new Promise((resolve) => {
    let pending = waiting.get(kind);
    if (!pending) {
      pending = new Map();
      waiting.set(kind, pending);
    }
    pending.set(id, resolve);
    flushTimer ??= setTimeout(flush, 0);
  });
}

/** A place's activity, or null when it could not be read (any non-OK status, a network error, bad JSON). */
export function loadSummary(kind: SummaryKind, id: string): Promise<RoomAnalytics | null> {
  const key = cacheKey(kind, id);
  let pending = cache.get(key);
  if (!pending) {
    pending = requestSummary(kind, id);
    cache.set(key, pending);
    // Numbers change as people come and go: keep them for this visit only.
    const settled = pending;
    void settled.finally(() =>
      setTimeout(() => {
        if (cache.get(key) === settled) cache.delete(key);
      }, 30_000),
    );
  }
  return pending;
}

/** Forget a cached answer so the next load asks again (an explicit retry). */
export function forgetSummary(kind: SummaryKind, id: string): void {
  cache.delete(cacheKey(kind, id));
}

/** For tests: start from an empty cache. */
export function clearSummaryCache(): void {
  cache.clear();
  waiting.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** A room's visits, stars aside: how many, the busiest hour, when you and the latest visitor were last there. */
export function useRoomAnalytics(roomId: string | null | undefined): {
  analytics: RoomAnalytics | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
} {
  const [state, setState] = useState<{ roomId: string | null; analytics: RoomAnalytics | null }>({ roomId: null, analytics: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    if (attempt > 0) forgetSummary('rooms', roomId);
    void loadSummary('rooms', roomId).then((analytics) => {
      // Only the room asked for last paints; an older answer never lands on a newer room.
      if (!cancelled) setState({ roomId, analytics });
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, attempt]);

  const current = state.roomId === roomId;
  return {
    analytics: current ? state.analytics : null,
    loading: Boolean(roomId) && !current,
    failed: current && state.analytics === null,
    retry: () => setAttempt((value) => value + 1),
  };
}
