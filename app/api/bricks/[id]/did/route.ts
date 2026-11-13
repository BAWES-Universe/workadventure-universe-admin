import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { didByBrick, ownsBrickNow } from '@/lib/brick-item-screens';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/:id/did?before=<cursor>
 * "Everything Brick did" (game #2002): every run this Brick made by itself for its owner, newest first, failed runs and quiet checks
 * included, each with its result in a line. Nothing it did on its own is hidden. `next` is the cursor for the next page, or null.
 * Only its owner; anyone else gets the same answer as for a Brick that does not exist.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    if (!(await ownsBrickNow(id, owner.userId))) return brickJson(request, { error: 'Brick not found' }, 404);
    const cursor = request.nextUrl.searchParams.get('before');
    const before = cursor ? new Date(cursor) : undefined;
    if (before && Number.isNaN(before.getTime())) return brickJson(request, { error: 'before is not a time' }, 400);
    return brickJson(request, await didByBrick(owner.userId, id, before));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-items' } });
    console.error('Error listing what a Brick did:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
