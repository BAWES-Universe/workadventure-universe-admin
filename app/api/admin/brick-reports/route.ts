import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { REPORT_STATES, reportInbox, type ReportState } from '@/lib/brick-reports';

export const runtime = 'nodejs';

/**
 * GET /api/admin/brick-reports?state=new - the Brick reports inbox: one tab's problems, highest priority first, with counts of Bricks,
 * people and times, and how many problems each tab holds. Counts only: no screen shows who sent a note. Super admins only.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const asked = request.nextUrl.searchParams.get('state') ?? 'new';
  if (!(REPORT_STATES as readonly string[]).includes(asked)) return NextResponse.json({ error: `state must be one of ${REPORT_STATES.join(', ')}` }, { status: 400 });
  try {
    return NextResponse.json(await reportInbox(asked as ReportState), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Brick reports] Could not read the inbox:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
