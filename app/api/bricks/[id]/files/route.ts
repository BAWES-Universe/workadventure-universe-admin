import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { ownsBrick } from '@/lib/brick';
import { listBrickFiles } from '@/lib/brick-files';
import { getServerLimits } from '@/lib/bot-limits';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/:id/files
 * A Brick's files in one place for its owner (game #2003): what it made for them, what they sent it, and what is on its
 * computer once it has one. Only the owner's own files of this Brick: for anyone else, a super admin included, and for a
 * bot that lives in a room, the answer is the same as for a Brick that does not exist. Reading it never reaches a
 * computer, so it never starts one.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    if (!brick || !ownsBrick(brick, owner.userId)) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, await listBrickFiles(id, owner.userId, (await getServerLimits()).files));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error listing a Brick’s files:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
