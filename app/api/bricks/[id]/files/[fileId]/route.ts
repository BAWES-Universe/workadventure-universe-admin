import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { ownsBrick } from '@/lib/brick';
import { deleteSentFile } from '@/lib/brick-files';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * DELETE /api/bricks/:id/files/:fileId
 * The owner deletes a file they sent their Brick (game #2003), the one change the files list allows. A file the Brick
 * made is not deleted here (it is theirs to keep: Your artifacts has its delete), and the answer for it is the same as for a
 * file that is not there. The Brick can no longer find, read or send the file, and the uploader's copy is taken out
 * by the bot server.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try {
    const { id, fileId } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    if (!brick || !ownsBrick(brick, owner.userId)) return brickJson(request, { error: 'Brick not found' }, 404);
    if (!(await deleteSentFile(id, owner.userId, fileId))) return brickJson(request, { error: 'File not found' }, 404);
    return brickJson(request, { deleted: true });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error deleting a file sent to a Brick:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
