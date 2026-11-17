import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { listBricks, listDeletedBricks } from '@/lib/brick-default';
import { removeGoneBricks } from '@/lib/brick-delete';
import { makeBrick, newBrickSchema } from '@/lib/brick-make';
import { getBrickLimits } from '@/lib/bot-limits';
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
 *
 * With them (game #1996): `deleted`, the Bricks this person deleted that Undo can still give back, each with the day it
 * is gone for good, and `undoDays`, how long a Brick deleted now would wait, for the line on the delete question.
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const now = new Date();
    // Their own Bricks whose days are over are cleared away on the way. The lists below never show one either way,
    // so a failure here costs nothing but the tidying.
    await removeGoneBricks(now, owner.userId).catch((error) => {
      Sentry.captureException(error, { tags: { area: 'bricks' } });
      console.error('Error removing Bricks whose time has passed:', error);
    });
    const [bricks, deleted, limits] = await Promise.all([listBricks(owner.userId), listDeletedBricks(owner.userId, now), getBrickLimits()]);
    return brickJson(request, { bricks, deleted, undoDays: limits.undoDays });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error listing Bricks:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/bricks
 * New Brick (game #1996): the signed-in person makes another Brick of their own. Body: { name, characterTextureId?,
 * description?, chatInstructions?, hello? }. It is theirs, has no room and runs on Universe AI, on the same replies as
 * every other bot they talk to. Answers 201 with its card.
 */
export async function POST(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = newBrickSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    return brickJson(request, { brick: await makeBrick(owner.userId, parsed.data) }, 201);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error making a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
