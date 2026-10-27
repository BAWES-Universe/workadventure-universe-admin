import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError, checkReplyAllowance } from '@/lib/reply-limits';

/**
 * POST /api/bots/:id/reply-allowance
 * May this person get one more reply from this bot now (game #1159)? Asked by the bot server before each reply.
 * Body: { userId: their WorkAdventure uuid or email, isGuest: boolean, source: "universe-ai" | "provider" | "own-key" }.
 * Response: { allowed: true }, or { allowed: false, limit, resetsAt, who } for the fixed card. See lib/reply-limits.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await checkReplyAllowance(id, body));
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'reply-limits' } });
    console.error('[ReplyLimits] Check failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
