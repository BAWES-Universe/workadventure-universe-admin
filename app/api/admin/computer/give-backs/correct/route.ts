import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { correctRouteTogether } from '@/lib/computer-fault-ops';

export const runtime = 'nodejs';

// A bound is an ISO timestamp STRING, checked before it becomes a date: a coercing date would read null as the start of 1970 and a bare number as some year, and
// an incident correction over a range nobody meant would give back jobs outside the incident
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const timestamp = z
  .string()
  .max(40)
  .regex(ISO_TIMESTAMP)
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
