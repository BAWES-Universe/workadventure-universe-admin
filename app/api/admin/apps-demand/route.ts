import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { DEMAND_DEFAULT_DAYS, DEMAND_MAX_DAYS, demandReport } from '@/lib/app-demand';

export const runtime = 'nodejs';

/**
 * GET /api/admin/apps-demand?days=30 - "Apps: use and demand" (spec section 22): which Apps are used, by how many people, what
 * each costs us, how often it fails, what it runs on, and the App names people asked for that are not there yet (names only).
 * From the meter's books. Super admins only; nothing here is per person beyond counts.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const asked = request.nextUrl.searchParams.get('days');
  const days = asked === null ? DEMAND_DEFAULT_DAYS : Number(asked);
  if (!Number.isInteger(days) || days < 1 || days > DEMAND_MAX_DAYS) return NextResponse.json({ error: `days must be a whole number from 1 to ${DEMAND_MAX_DAYS}` }, { status: 400 });
  try {
    return NextResponse.json(await demandReport(days));
  } catch (error) {
    console.error('[Apps demand] Could not build the report:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
