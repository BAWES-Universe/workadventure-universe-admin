import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { ownsBrick } from '@/lib/brick';
import { listBrickFiles, listBrickFilesPage, type FileSection } from '@/lib/brick-files';
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
 *
 * With nothing asked, the first look: the latest it made, the latest page of what they sent, and every file counted.
 * With `section=made|sent`, one page of that list, newest first: `cursor` (what the page before gave as `nextCursor`)
 * says where it starts, `q` keeps only files with those words in the name, and `limit` asks for fewer than a full page.
 * Every query is bounded however many files there are, and a file deleted meanwhile moves nothing else.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    if (!brick || !ownsBrick(brick, owner.userId)) return brickJson(request, { error: 'Brick not found' }, 404);
    const limits = (await getServerLimits()).files;
    const { searchParams } = new URL(request.url);
    const section = searchParams.get('section');
    if (section === null) return brickJson(request, await listBrickFiles(id, owner.userId, limits));
    if (section !== 'made' && section !== 'sent') return brickJson(request, { error: 'Unknown list' }, 400);
    const asked = searchParams.get('limit');
    const page = await listBrickFilesPage(id, owner.userId, limits, {
      section: section as FileSection,
      cursor: searchParams.get('cursor'),
      search: searchParams.get('q'),
      limit: asked === null ? null : Number(asked),
    });
    if (!page) return brickJson(request, { error: 'Unknown place in the list' }, 400);
    return brickJson(request, page);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error listing a Brick’s files:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
