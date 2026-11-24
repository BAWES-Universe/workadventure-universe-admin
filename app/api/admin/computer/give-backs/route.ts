import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { giveBackOverview } from '@/lib/computer-fault-ops';

export const runtime = 'nodejs';

/**
 * GET /api/admin/computer/give-backs (super admins only)
 * The operations view of computer give-backs: the settings problems that hold decisions, the decisions by state and basis with what each group cost, what is
 * charged provisionally while a decision waits (and the age of the oldest), and the routes failing for many people with whether new work on them is paused.
 * Reads only.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json(await giveBackOverview(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
