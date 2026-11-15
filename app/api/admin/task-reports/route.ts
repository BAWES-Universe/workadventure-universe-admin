import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { problemReports } from '@/lib/task-receipts';

export const runtime = 'nodejs';

/**
 * GET /api/admin/task-reports (super admins only)
 * What people reported as "Didn't work?" on Activity, newest first: { reports: [{ id, title, state, botId, botName, personId, payer, payerName,
 * reportedAt, at }] }. The person's own words are never kept, so there are none. Reads only. A new report also reaches the team as a Sentry warning.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json({ reports: await problemReports() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'task-receipts' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
