import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { correctRouteTogether } from '@/lib/computer-fault-ops';

export const runtime = 'nodejs';

// A bound is an ISO timestamp STRING, checked before it becomes a date: a coercing date would read null as the start of 1970 and a bare number as some year, and
// an incident correction over a range nobody meant would give back jobs outside the incident. At most milliseconds: a Date keeps no more, so a finer bound would be
// cut silently and a range inside one millisecond could reverse
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** The date and time as written exist on the calendar (a month's own length, hours under 24): `new Date('2026-02-30T00:00:00Z')` would silently read as the 2nd of March. */
function isOnTheCalendar(value: string): boolean {
  const parts = ISO_TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] ?? '0'].map(Number);
  // `Date.UTC` reads the years 0 to 99 as 1900 to 1999, so the year is set apart (0096-02-29 is a real leap day)
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  return wall.getUTCFullYear() === year && wall.getUTCMonth() === month - 1 && wall.getUTCDate() === day && wall.getUTCHours() === hour && wall.getUTCMinutes() === minute && wall.getUTCSeconds() === second;
}

const timestamp = z
  .string()
  .max(40)
  .regex(ISO_TIMESTAMP)
  .refine(isOnTheCalendar)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value));
const bodySchema = z.object({ route: z.string().min(1).max(120), from: timestamp, to: timestamp }).strict();

/**
 * POST /api/admin/computer/give-backs/correct { route, from, to } (super admins only)
 * One incident, corrected together: every job with a provider failure on that route between the two times that is not a give-back yet (held for a decision,
 * or past the person's bound) is given back, and none of them counts towards anyone's bound. Jobs the person caused, or that delivered something outside their
 * computer, are left alone. Answers { corrected, costMicros }. Safe to say twice.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || parsed.data.to.getTime() < parsed.data.from.getTime()) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    return NextResponse.json(await correctRouteTogether(parsed.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
