import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';

/** Answer for the owner's calls: the game calls from its own origin. */
export const optionsFor = (request: NextRequest) => NextResponse.json({}, { headers: corsHeaders(request) });

/**
 * Every owner call on a Brick's computer is the same shape: a signed-in person, the Brick's id, and an answer or a 404. Only the
 * owner may ask: for anyone else, a super admin included, and for a bot that lives in a room, the answer is the same as for a
 * Brick that does not exist.
 */
export async function asOwner(
  request: NextRequest,
  params: Promise<{ id: string }>,
  run: (botId: string, ownerId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return await run(id, owner.userId);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] A call failed:', error instanceof Error ? error.message : 'unknown');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

export const notFound = (request: NextRequest) => brickJson(request, { error: 'Brick not found' }, 404);
