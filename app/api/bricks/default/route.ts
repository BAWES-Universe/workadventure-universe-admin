import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/default
 * The signed-in person's own Brick (game #1995), made now when their account never had one. The game asks when a person
 * opens their chats, from every device, as often as it likes: the answer is always the same one Brick.
 *
 *   { brick, made, deleted: false }  the Brick; `made` is true only in the one answer that made it
 *   { brick: null, made: false, deleted: true }  its owner deleted it on purpose, and it is not made again
 *
 * Making it sends nothing: no message, no notice and no unread count. No AI runs until its owner writes to it.
 */
export async function POST(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, await ensureDefaultBrick(owner.userId));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error making the default Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
