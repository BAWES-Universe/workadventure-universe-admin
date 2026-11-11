import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { removeGoneBricks } from '@/lib/brick-delete';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/sweep
 * Removes for good every deleted Brick whose days are over (game #1996), with its saved chats and what it remembers.
 * Asked by the bot server now and then; a person's own are also cleared when they open their Bricks page. Answers
 * { removed: [bot ids] }, so the bot server can close those chats. Nothing depends on when this runs: a Brick whose days
 * are over is in no list and cannot be brought back, swept or not.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json({ removed: await removeGoneBricks() });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('[Bricks] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
