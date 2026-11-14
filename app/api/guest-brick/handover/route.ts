import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { guestChatHandedTo } from '@/lib/guest-brick';

export const runtime = 'nodejs';

/**
 * POST /api/guest-brick/handover { guestId, userUuid }
 * Whether the chat of this guest was handed to the person with this uuid when they signed in (plan v3 section 7): { handed }.
 * The bot server asks before it copies a guest's pictures, files and notes into that person's own chat.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const body = (await request.json().catch(() => null)) as { guestId?: unknown; userUuid?: unknown } | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'guestId and userUuid are required' }, { status: 400 });
    return NextResponse.json(await guestChatHandedTo(body.guestId, body.userUuid), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'guest-brick' } });
    console.error('[GuestBrick] Could not check a hand-over:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
