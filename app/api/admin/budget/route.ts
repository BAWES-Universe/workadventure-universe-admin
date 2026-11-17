import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { refused, superAdmin } from '@/lib/budget/auth';
import { buildReport } from '@/lib/budget/report';

export const runtime = 'nodejs';

/**
 * GET /api/admin/budget (super admins only)
 * The Budget page: the monthly budget for new funded work with its five areas, the warnings, the company accounts, every number with its range and
 * who last changed it, the change history, who asked for more, and gross cost beside what members fund themselves. Reading it tells every super
 * admin once about each warning that needs a notice. Nothing here is shown to a visitor or a member.
 */
export async function GET(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  try {
    return NextResponse.json(await buildReport({ userId: user.id, notify: true }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not build the page:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
