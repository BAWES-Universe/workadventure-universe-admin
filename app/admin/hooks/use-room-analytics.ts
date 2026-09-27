'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';

export interface RoomVisit {
  accessedAt: string;
  userId?: string | null;
  userUuid?: string | null;
  /** Only when the viewer may see who visited (a manager of the room, or a super admin). */
  userName?: string | null;
}

export interface RoomAnalytics {
  totalAccesses: number | null;
  /** The busiest hour of the day, and whose clock it is on: the viewer's own from recent visits, else the API's UTC buckets. */
  peakHour: number | null;
  peakZone: 'local' | 'UTC';
  lastVisitedByUser: RoomVisit | null;
  lastVisitedOverall: RoomVisit | null;
}

interface AnalyticsResponse {
  totalAccesses?: number;
  peakTimes?: Array<{ hour: number; count: number }>;
  recentActivity?: Array<{ accessedAt: string }>;
  lastVisitedByUser?: RoomVisit | null;
  lastVisitedOverall?: RoomVisit | null;
}

function validVisit(visit?: RoomVisit | null): RoomVisit | null {
  return visit && Number.isFinite(new Date(visit.accessedAt).getTime()) ? visit : null;
}

/** Busiest local hour from recent visits; the server's UTC peak only when there are none. */
export function peakHourOf(data: AnalyticsResponse): { hour: number | null; zone: 'local' | 'UTC' } {
  const counts = new Map<number, number>();
  for (const access of data.recentActivity ?? []) {
    if (!validVisit(access)) continue;
    const hour = new Date(access.accessedAt).getHours();
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [hour, count] of counts) {
    if (count > bestCount) {
      best = hour;
      bestCount = count;
    }
  }
  if (best !== null) return { hour: best, zone: 'local' };
  const utc = data.peakTimes?.find((peak) => Number.isInteger(peak.hour) && peak.hour >= 0 && peak.hour <= 23)?.hour;
  return { hour: utc ?? null, zone: 'UTC' };
}

export function fromAnalytics(data: AnalyticsResponse): RoomAnalytics {
  const peak = peakHourOf(data);
  return {
    totalAccesses:
      typeof data.totalAccesses === 'number' && Number.isFinite(data.totalAccesses) && data.totalAccesses >= 0
        ? data.totalAccesses
        : null,
    peakHour: peak.hour,
    peakZone: peak.zone,
    lastVisitedByUser: validVisit(data.lastVisitedByUser),
    lastVisitedOverall: validVisit(data.lastVisitedOverall),
  };
}

/** Whether the latest visitor was you: the same moment is not enough, the record has to name you. */
export function wasLastVisitorYou(analytics: RoomAnalytics): boolean {
  const yours = analytics.lastVisitedByUser;
  const last = analytics.lastVisitedOverall;
  if (!yours || !last) return false;
  if (Math.abs(new Date(yours.accessedAt).getTime() - new Date(last.accessedAt).getTime()) >= 1000) return false;
  return Boolean(
    (yours.userId && last.userId && yours.userId === last.userId) ||
      (yours.userUuid && last.userUuid && yours.userUuid === last.userUuid),
  );
}

export function formatHour(hour: number): string {
  return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

// One request per room per page view, shared by every card showing that room.
const cache = new Map<string, Promise<RoomAnalytics | null>>();

function load(roomId: string): Promise<RoomAnalytics | null> {
  let pending = cache.get(roomId);
  if (!pending) {
    pending = authenticatedFetch(`/api/admin/analytics/rooms/${encodeURIComponent(roomId)}`)
      .then(async (response) => (response.ok ? fromAnalytics((await response.json()) as AnalyticsResponse) : null))
      .catch(() => null);
    cache.set(roomId, pending);
    // Numbers change as people come and go: keep them for this visit to Home only.
    void pending.finally(() => setTimeout(() => cache.delete(roomId), 30_000));
  }
  return pending;
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
    if (attempt > 0) cache.delete(roomId);
    void load(roomId).then((analytics) => {
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
