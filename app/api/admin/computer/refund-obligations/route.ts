import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { refundOverview } from '@/lib/computer-refunds';

export const runtime = 'nodejs';

/**
 * GET /api/admin/computer/refund-obligations (super admins only)
 * What support sees about refunds of credit a failed computer job drew that the funding books have not acknowledged yet: for each, the original job, the person,
 * the hold, the amount owed, the tries made, the last try and why it failed, and whether it is overdue (over an hour). The oldest first. Reads only.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json(await refundOverview(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
