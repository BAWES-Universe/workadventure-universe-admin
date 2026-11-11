import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { listBricks } from '@/lib/brick-default';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks
 * The signed-in person's own Bricks, for their Bricks page (game #1995): the one everyone gets first, then the ones they
 * made. Only a card for each: its name, line, look and whether it is on. Reading the list makes nothing; the Brick
 * everyone gets is made by POST /api/bricks/default.
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, { bricks: await listBricks(owner.userId) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error listing Bricks:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
