import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { sweepInstant } from '@/lib/instant/sweep';

export const runtime = 'nodejs';

/**
 * POST /api/instant/sweep
 * Asked by the bot server now and then: unfinished Instant runs are looked up by their own id and settled, existing app link sessions
 * are read back so none allows Instant, trusted prices are checked against Composio's listing, and the failure-rate pause is checked.
 * Safe to run twice at once. Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await sweepInstant());
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    Sentry.captureException(error, { tags: { area: 'instant' } });
    console.error('[Instant] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
