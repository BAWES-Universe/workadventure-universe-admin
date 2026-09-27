/**
 * Peak: ONE definition everywhere. The analytics APIs bucket every access a place has ever had by its UTC hour
 * (`peakTimes`, busiest first); the viewer sees the busiest bucket as an hour on their own clock ("4 PM"). Nothing
 * recomputes a peak from one page of recent activity, and no label ever says UTC.
 */

export interface HourBucket {
  hour: number;
  count: number;
}

function validHour(hour: unknown): hour is number {
  return typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

/** Server side: every access bucketed by UTC hour, busiest first (ties: earlier hour first). */
export function utcHourBuckets(dates: Iterable<Date>): HourBucket[] {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const time = date.getTime();
    if (!Number.isFinite(time)) continue;
    const hour = date.getUTCHours();
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return Array.from(counts, ([hour, count]) => ({ hour, count })).sort((a, b) => b.count - a.count || a.hour - b.hour);
}

/** The busiest UTC hour in the API's buckets, or null when there are none. */
export function busiestUtcHour(peakTimes: unknown): number | null {
  if (!Array.isArray(peakTimes)) return null;
  let best: HourBucket | null = null;
  for (const bucket of peakTimes as Partial<HourBucket>[]) {
    if (!bucket || !validHour(bucket.hour) || typeof bucket.count !== 'number' || !(bucket.count > 0)) continue;
    if (!best || bucket.count > best.count || (bucket.count === best.count && bucket.hour < best.hour)) {
      best = { hour: bucket.hour, count: bucket.count };
    }
  }
  return best ? best.hour : null;
}

/** A UTC hour of the day on the viewer's own clock (today's offset, so daylight saving is respected). */
export function localHourFromUtc(utcHour: number, now: Date = new Date()): number {
  const at = new Date(now.getTime());
  at.setUTCHours(utcHour, 0, 0, 0);
  return at.getHours();
}

/** "4 PM", "12 AM". */
export function formatHour(hour: number): string {
  return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The busiest hour, local: the only peak the UI shows. */
export function localPeakHour(peakTimes: unknown, now?: Date): number | null {
  const utc = busiestUtcHour(peakTimes);
  return utc === null ? null : localHourFromUtc(utc, now);
}

/** "4 PM" (the viewer's local time), or null when nobody has visited. */
export function formatPeak(peakTimes: unknown, now?: Date): string | null {
  const hour = localPeakHour(peakTimes, now);
  return hour === null ? null : formatHour(hour);
}

/** The StatLine items for a place's activity: "1,284 accesses", "Peak 4 PM". */
export function activityStats(summary: { totalAccesses: number | null; peakHour: number | null } | null | undefined): (string | null)[] {
  if (!summary) return [];
  const total = summary.totalAccesses;
  return [
    typeof total === 'number' ? `${total.toLocaleString()} ${total === 1 ? 'access' : 'accesses'}` : null,
    summary.peakHour !== null ? `Peak ${formatHour(summary.peakHour)}` : null,
  ];
}
