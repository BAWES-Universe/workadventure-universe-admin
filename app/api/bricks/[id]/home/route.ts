import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { homeOfBrick, placeBrick, takeOutBrick } from '@/lib/brick-home';
import { corsHeaders } from '@/lib/cors';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const placeSchema = z
  .object({
    roomUrl: z.string().trim().min(1).max(2000),
    behaviorType: z.enum(['idle', 'patrol', 'social']).optional(),
    behaviorConfig: z.record(z.string(), z.any()).optional(),
  })
  .strict();

/**
 * GET /api/bricks/:id/home
 * Where a Brick lives (game #2005), for its Brick page: the room, its universe and the link to show it on the map, or
 * `{ home: null }`. Only its owner; for anyone else, a room bot or a Brick that waits deleted: "not found".
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    if (!brick || brick.roomId !== null || brick.deletedAt !== null || brick.ownerId !== owner.userId) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { home: await homeOfBrick(id, owner.userId) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading where a Brick lives:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * PUT /api/bricks/:id/home  { roomUrl, behaviorType?, behaviorConfig? }
 * "Add one of your Bricks": the owner gives their Brick a home in a room they can manage bots in, with its spot picked
 * as for any room bot. Placing it again moves it: a Brick has one home at most. Answers with the home and, in `keyNote`,
 * "not_lent" when the Brick runs on its owner's own key and that key is not lent to the room's universe: others cannot
 * talk to it there until it is. 404 when it is not theirs or the room is not there; 403 when they cannot manage bots there.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = placeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const answer = await placeBrick({ brickId: id, ownerId: owner.userId, ...parsed.data });
    if (answer.ok) return brickJson(request, { home: answer.home, keyNote: answer.keyNote });
    if (answer.reason === 'not_found') return brickJson(request, { error: 'Brick not found' }, 404);
    if (answer.reason === 'no_room') return brickJson(request, { error: 'Room not found' }, 404);
    return brickJson(request, { error: 'You cannot manage bots in this room' }, 403);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error giving a Brick a home:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/bricks/:id/home
 * "Take it out of this room": the Brick goes back to its owner's Bricks. Only the home's row goes; nothing of the
 * owner's is deleted. Its owner, or a manager of that room (see DELETE /api/brick-homes/:id, the same). Asked twice,
 * the second answer is the same.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return (await takeOutBrick(id, owner.userId)) === 'taken_out' ? brickJson(request, { home: null }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error taking a Brick out of its room:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
