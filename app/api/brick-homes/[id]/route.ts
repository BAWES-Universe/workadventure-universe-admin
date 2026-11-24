import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { moveBrick, takeOutBrick } from '@/lib/brick-home';
import { corsHeaders } from '@/lib/cors';
import { homeBehaviorConfigSchema } from '@/lib/brick-home-schema';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const moveSchema = z
  .object({ behaviorType: z.enum(['idle', 'patrol', 'social']).optional(), behaviorConfig: homeBehaviorConfigSchema.optional() })
  .strict();

/**
 * PATCH /api/brick-homes/:id  { behaviorType?, behaviorConfig? }
 * A manager of the room moves a Brick that lives there: its spot, radius, roaming and routes, in today's editor. They
 * cannot place one (only its owner does), and this changes nothing else of the Brick. "Not found" when the Brick has no
 * home in a room this person manages.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const who = await brickOwner(request);
    if (who.response) return who.response;
    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    return (await moveBrick(id, who.userId, parsed.data)) ? brickJson(request, { moved: true }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error moving a Brick in its room:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/brick-homes/:id
 * "Take out": a manager of the room takes a Brick placed by someone else out of it, or its owner takes it out. It goes
 * back to its owner's Bricks and nothing of theirs is deleted. "Not found" for anyone else.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const who = await brickOwner(request);
    if (who.response) return who.response;
    return (await takeOutBrick(id, who.userId)) === 'taken_out' ? brickJson(request, { taken_out: true }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error taking a Brick out of a room:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
