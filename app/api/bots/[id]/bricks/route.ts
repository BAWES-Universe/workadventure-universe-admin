import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { bricksForChat, chatBrickSchema, makeBrickFromChat } from '@/lib/brick-make';

export const runtime = 'nodejs';

function failed(error: unknown, what: string) {
  if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  Sentry.captureException(error, { tags: { area: 'bricks' } });
  console.error(`[Bricks] ${what} failed:`, error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * GET /api/bots/:id/bricks?userId=...
 * The Bricks of the person this Brick belongs to (game #1996), for the Brick itself: before it makes another one it can
 * see the ones there are and open one instead. Only when `userId` (their game uuid or email) is the owner of Brick :id;
 * for anyone else, and for a room bot, the answer is the same as for a Brick that does not exist.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const bricks = await bricksForChat(id, userId);
    return bricks ? NextResponse.json({ bricks }) : NextResponse.json({ error: 'Brick not found' }, { status: 404 });
  } catch (error) {
    return failed(error, 'Listing for a chat');
  }
}

/**
 * POST /api/bots/:id/bricks
 * A person asks their Brick, in their own chat with it, to make another Brick (game #1996): "make me a bot that keeps my
 * mum's recipes". Body: { userId, name, description?, chatInstructions?, characterTextureId?, hello?, evenIfThere? }.
 * The new Brick belongs to that person, and only the owner of Brick :id gets one.
 *
 *   201 { made: true, brick, bricks }   made now
 *   200 { made: false, brick, bricks }  they already have a Brick of that name: here it is, and nothing was made
 *                                       (`evenIfThere: true` makes a second one, when they asked for one on purpose)
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const parsed = chatBrickSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await makeBrickFromChat(id, parsed.data);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ made: answer.made, brick: answer.brick, bricks: answer.bricks }, { status: answer.made ? 201 : 200 });
  } catch (error) {
    return failed(error, 'Making from a chat');
  }
}
