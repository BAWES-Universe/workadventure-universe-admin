import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { endVisit, startVisit, visitState } from '@/lib/brick-visit';
import { corsHeaders } from '@/lib/cors';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const bodySchema = z.object({ roomUrl: z.string().trim().min(1).max(2000) }).strict();

/**
 * GET /api/bricks/:id/visit?roomUrl=
 * What a Brick's page says about visiting (game #2005), for its owner and the room they are in: `none` (offer "Bring
 * along"), `visiting` (say "Visiting {place} with you" and offer "End visit") or `blocked` (the place does not take
 * visiting Bricks: one line, and direct messages still work). Only its owner: for anyone else, a super admin
 * included, and for a bot that lives in a room, the answer is the same as for a Brick that does not exist.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const roomUrl = new URL(request.url).searchParams.get('roomUrl')?.trim() || null;
    const brick = await ownBrick(id, owner.userId);
    if (!brick) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, await visitState(id, owner.userId, roomUrl));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading a Brick visit:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/bricks/:id/visit  { roomUrl }
 * "Bring along": the owner's Brick walks beside them from the room they are in, in every place that takes visiting
 * Bricks. Whichever Brick walked with them before goes home. Refused with 409 when the place does not take visiting
 * Bricks (`reason: "not_taken"`, with its name) or the Brick is switched off (`reason: "off"`).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const answer = await startVisit(id, owner.userId, parsed.data.roomUrl);
    if (answer.ok) return brickJson(request, answer.state);
    if (answer.reason === 'not_found') return brickJson(request, { error: 'Brick not found' }, 404);
    if (answer.reason === 'no_place') return brickJson(request, { error: 'Room not found' }, 404);
    return brickJson(request, { error: answer.reason === 'off' ? 'Brick is switched off' : 'This place does not take visiting Bricks', reason: answer.reason, place: answer.place ?? null }, 409);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error bringing a Brick along:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/bricks/:id/visit
 * "End visit": the Brick goes home. Only the visit's own row goes; nothing of the Brick changes, and no second bot or
 * computer ever existed to remove. Asked twice, the second answer is the same.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    if (!(await endVisit(id, owner.userId))) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { state: 'none', place: null });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error ending a Brick visit:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

async function ownBrick(id: string, userId: string) {
  const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  return brick && ownsBrick(brick, userId) ? brick : null;
}
