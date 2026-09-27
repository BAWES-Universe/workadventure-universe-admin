export interface SignalRoom {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: { id: string; name: string; slug: string };
  };
  _count?: { favorites?: number };
  accessedAt?: string;
}

export interface RoomVisit {
  accessedAt: string;
  userId?: string | null;
  userUuid?: string | null;
}

interface AnalyticsPayload {
  totalAccesses?: number;
  recentActivity?: RoomVisit[];
  peakTimes?: { hour: number; count: number }[];
  lastVisitedByUser?: RoomVisit | null;
  lastVisitedOverall?: RoomVisit | null;
}

export interface RoomSignal {
  totalAccesses: number | null;
  peakHour: number | null;
  peakZone: 'local' | 'UTC';
  lastVisitedByUser: RoomVisit | null;
  lastVisitedOverall: RoomVisit | null;
}

function validVisit(visit?: RoomVisit | null): RoomVisit | null {
  return visit && Number.isFinite(new Date(visit.accessedAt).getTime()) ? visit : null;
}

/** Recent activity uses the viewer's clock; historical API buckets are explicitly UTC. */
export function roomSignalFromAnalytics(data: AnalyticsPayload): RoomSignal {
  const hours = new Map<number, number>();
  for (const visit of data.recentActivity ?? []) {
    if (!validVisit(visit)) continue;
    const hour = new Date(visit.accessedAt).getHours();
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }
  const localPeak = [...hours.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const utcPeak = data.peakTimes?.find((peak) => Number.isInteger(peak.hour) && peak.hour >= 0 && peak.hour <= 23)?.hour;
  return {
    totalAccesses: typeof data.totalAccesses === 'number' && Number.isFinite(data.totalAccesses) && data.totalAccesses >= 0
      ? data.totalAccesses : null,
    peakHour: localPeak ?? utcPeak ?? null,
    peakZone: localPeak === undefined ? 'UTC' : 'local',
    lastVisitedByUser: validVisit(data.lastVisitedByUser),
    lastVisitedOverall: validVisit(data.lastVisitedOverall),
  };
}

/** Equal timestamps alone cannot establish identity, particularly when visitor details are redacted. */
export function wasLastVisitorYou(signal: RoomSignal): boolean {
  const yours = signal.lastVisitedByUser;
  const last = signal.lastVisitedOverall;
  if (!yours || !last || Math.abs(new Date(yours.accessedAt).getTime() - new Date(last.accessedAt).getTime()) >= 1000) return false;
  return Boolean(
    (yours.userId && last.userId && yours.userId === last.userId) ||
    (yours.userUuid && last.userUuid && yours.userUuid === last.userUuid),
  );
}

export function formatPeakHour(hour: number): string {
  return `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}
