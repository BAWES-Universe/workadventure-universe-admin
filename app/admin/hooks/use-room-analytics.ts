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
  totalAccesses: number;
  /** The busiest hour of the day, in the viewer's own time zone. */
  peakHour: number | null;
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

/** Busiest local hour from recent visits; the server's UTC peak only when there are none. */
export function peakHourOf(data: AnalyticsResponse): number | null {
  const counts = new Map<number, number>();
  for (const access of data.recentActivity ?? []) {
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
  if (best !== null) return best;
  return data.peakTimes?.[0]?.hour ?? null;
}

export function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

// One request per room per page view, shared by every card showing that room.
const cache = new Map<string, Promise<RoomAnalytics | null>>();

function load(roomId: string): Promise<RoomAnalytics | null> {
  let pending = cache.get(roomId);
  if (!pending) {
    pending = authenticatedFetch(`/api/admin/analytics/rooms/${encodeURIComponent(roomId)}`)
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as AnalyticsResponse;
        return {
          totalAccesses: data.totalAccesses ?? 0,
          peakHour: peakHourOf(data),
          lastVisitedByUser: data.lastVisitedByUser ?? null,
          lastVisitedOverall: data.lastVisitedOverall ?? null,
        };
      })
      .catch(() => null);
    cache.set(roomId, pending);
    // Numbers change as people come and go: keep them for this visit to Home only.
    void pending.finally(() => setTimeout(() => cache.delete(roomId), 30_000));
  }
  return pending;
}

/** A room's visits, stars aside: how many, the busiest hour, when you and the latest visitor were last there. */
export function useRoomAnalytics(roomId: string | null | undefined): { analytics: RoomAnalytics | null; loading: boolean } {
  const [state, setState] = useState<{ roomId: string | null; analytics: RoomAnalytics | null }>({ roomId: null, analytics: null });

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    void load(roomId).then((analytics) => {
      if (!cancelled) setState({ roomId, analytics });
    });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const current = state.roomId === roomId;
  return { analytics: current ? state.analytics : null, loading: Boolean(roomId) && !current };
}
