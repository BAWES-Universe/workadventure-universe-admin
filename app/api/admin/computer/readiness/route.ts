import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { computerReadiness } from '@/lib/computer-readiness';

export const runtime = 'nodejs';

/**
 * GET /api/admin/computer/readiness (super admins only)
 * Whether a computer job could run on this server now: { ready, checks: [{ name, ok, detail }] }. Reads only; makes and wakes nothing.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json(await computerReadiness(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
