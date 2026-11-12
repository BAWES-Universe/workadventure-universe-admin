import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { costsReport, readDay } from '@/lib/meter-costs';
import { COSTS_MAX_DAYS } from '@/lib/costs-words';

export const runtime = 'nodejs';

const DAY = 24 * 60 * 60 * 1000;

/**
 * GET /api/admin/meter-costs?from=2026-11-04&to=2026-11-10 - what Universe AI costs us from the meter's books (game #1999): our
 * count beside what the provider has settled, by person, Brick, what a Brick did, guests by universe and day, who asked for more
 * and what was given. Both days are included. Without them: the last 7 days. Super admins only.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const params = request.nextUrl.searchParams;
  const to = params.get('to') ? readDay(params.get('to')) : today;
  const from = params.get('from') ? readDay(params.get('from')) : to ? new Date(to.getTime() - 6 * DAY) : null;
  if (!from || !to) return NextResponse.json({ error: 'from and to must be dates like 2026-11-04' }, { status: 400 });
  if (to < from) return NextResponse.json({ error: 'The end date is before the start date' }, { status: 400 });
  if ((to.getTime() - from.getTime()) / DAY >= COSTS_MAX_DAYS) return NextResponse.json({ error: `Pick at most ${COSTS_MAX_DAYS} days` }, { status: 400 });
  try {
    return NextResponse.json(await costsReport(from, to, now));
  } catch (error) {
    console.error('[Costs] Could not build the report:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
