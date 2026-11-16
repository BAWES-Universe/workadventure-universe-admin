import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { offerableForBrick } from '@/lib/app-offerable';

export const runtime = 'nodejs';

/**
 * GET /api/bots/:id/apps/offerable?userId=...   (game chat card "Let it use Gmail")
 *   { apps: [{ key, name, blurb, connectionId, connected, usable }] }
 * What the bot server tells a Brick it may offer its owner: every app on the list that is on, with the owner's own connection of
 * it (if any), whether that is signed in and works, and whether this Brick already uses it. Never a link or a sign-in.
 * Only for the owner of Brick :id (`userId` is their game uuid or email); for anyone else, and for a room bot, the answer is the
 * same as for a Brick that does not exist.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const apps = await offerableForBrick(id, userId);
    if (!apps) return NextResponse.json({ error: 'Brick not found' }, { status: 404 });
    return NextResponse.json({ apps });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'apps' } });
    console.error('[Apps] Listing offerable apps failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
