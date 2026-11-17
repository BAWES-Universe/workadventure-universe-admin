import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { GuestBrickError } from '@/lib/guest-brick';

/**
 * The routes of the Brick for guests (game #1997) that only the bot server calls: service token only, so a guest, a
 * host and a super admin have no way to ask. Answers what `run` returns, or the status of the `GuestBrickError` it threw.
 */
export async function asBotServer(request: NextRequest, run: () => Promise<unknown>): Promise<NextResponse> {
  try {
    requireServiceToken(request);
    return NextResponse.json(await run());
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof GuestBrickError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'guest-brick' } });
    console.error('[GuestBrick] Failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** The JSON body of a request, or a 400 when it is not an object. */
export async function bodyOf(request: NextRequest): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GuestBrickError('Invalid request data', 400);
  return body as Record<string, unknown>;
}
