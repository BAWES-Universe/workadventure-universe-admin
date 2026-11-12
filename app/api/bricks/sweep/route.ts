import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { removeGoneBricks } from '@/lib/brick-delete';
import { endStaleVisits } from '@/lib/brick-visit';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/sweep
 * Removes for good every deleted Brick whose days are over (game #1996), with its saved chats and what it remembers.
 * Asked by the bot server now and then; a person's own are also cleared when they open their Bricks page. Answers
 * { removed: [bot ids] }, so the bot server can close those chats. Nothing depends on when this runs: a Brick whose days
 * are over is in no list and cannot be brought back, swept or not. It also clears visiting Bricks nobody has seen for
 * the time a super admin gave (game #2005), which are ended whether or not this has run.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const removed = await removeGoneBricks();
    // Visits nobody has seen for too long have ended (game #2005); a visit that ran out is ignored whether or not this has run
    await endStaleVisits();
    return NextResponse.json({ removed });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('[Bricks] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
