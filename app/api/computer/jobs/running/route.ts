import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { runnableJobsPage } from '@/lib/computer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/computer/jobs/running?cursor=... - the jobs Brick is working on now (running, in Brick's hands), with the words for the agent.
 * The runner on the bot server reads this to find work and to pick it up again after a restart. A job waiting for its person, or in the
 * person's hands, is not in it. The list comes a page at a time, oldest first: `nextCursor` is given back as `cursor` for the next page,
 * and is null on the last. Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const cursor = request.nextUrl.searchParams.get('cursor');
    const page = await runnableJobsPage(50, cursor && cursor.length <= 200 ? cursor : null);
    return NextResponse.json({ jobs: page.jobs, nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not list running jobs:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
