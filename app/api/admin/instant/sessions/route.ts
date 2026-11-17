import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { denyInstantOnSessions, sessionCheckStatus } from '@/lib/instant/sessions';

export const runtime = 'nodejs';

/** POST /api/admin/instant/sessions - reads existing app link sessions back and switches Instant OFF on any that allows it (a bounded batch; run again until `remaining` is 0). It can only turn Instant off. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    const sweep = await denyInstantOnSessions(200);
    return NextResponse.json({ sweep, status: await sessionCheckStatus() });
  } catch (error) {
    console.error('[Instant] Could not check sessions:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
