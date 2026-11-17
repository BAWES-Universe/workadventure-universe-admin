import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { undoBrickDelete } from '@/lib/brick-delete';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/:id/undo
 * Undo (game #1996): the owner takes back a Brick they deleted, while its days last. It comes back as it is now, with
 * its chat, what it remembers and its switch as it was. Nothing that ended at the delete comes back with it: the next
 * change asks again. Only its owner, and only before the day it is gone for good: otherwise the answer is the same as
 * for a Brick that does not exist. Answers with the Brick's card. Asked twice, the second answer is the same.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await undoBrickDelete(id, owner.userId);
    return brick ? brickJson(request, { brick }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error bringing a Brick back:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
