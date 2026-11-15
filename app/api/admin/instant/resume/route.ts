import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { resumeInstant } from '@/lib/instant/state';

export const runtime = 'nodejs';

/** POST /api/admin/instant/resume - Instant paused itself (or was paused); a super admin who has looked at why turns it back on. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ pause: await resumeInstant(user.id) });
  } catch (error) {
    console.error('[Instant] Could not resume:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
