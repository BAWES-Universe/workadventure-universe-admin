import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { resumeCodeJobs } from '@/lib/workbench/state';

export const runtime = 'nodejs';

/** POST /api/admin/workbench/resume - code jobs paused themselves (or were paused); a super admin who has looked at why turns them back on. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ pause: await resumeCodeJobs(user.id) });
  } catch (error) {
    console.error('[CodeJob] Could not resume:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
