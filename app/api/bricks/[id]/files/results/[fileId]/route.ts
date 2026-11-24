import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { ownsBrick } from '@/lib/brick';
import { corsHeaders } from '@/lib/cors';
import { deleteResult, readResult } from '@/lib/computer-file-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

async function ownerOf(request: NextRequest, id: string): Promise<{ response: NextResponse } | { userId: string }> {
  const owner = await brickOwner(request);
  if (owner.response) return { response: owner.response };
  const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, owner.userId)) return { response: brickJson(request, { error: 'Brick not found' }, 404) };
  return { userId: owner.userId };
}

/**
 * GET /api/bricks/:id/files/results/:fileId
 * Opens one result a Brick's computer made for its owner (their Files). Only the person whose job made it: anyone else, a super admin included, gets the
 * answer for a file that is not there. It is always a download of plain bytes, never something the browser opens as a page.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try {
    const { id, fileId } = await params;
    const who = await ownerOf(request, id);
    if ('response' in who) return who.response;
    const result = await readResult(id, who.userId, fileId);
    if (!result) return brickJson(request, { error: 'File not found' }, 404);
    return new NextResponse(new Uint8Array(result.data), {
      headers: {
        ...corsHeaders(request),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.data.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-File-Type': result.mime,
      },
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error opening a computer result:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/** DELETE /api/bricks/:id/files/results/:fileId - the owner deletes one of their results: the kept copy goes. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try {
    const { id, fileId } = await params;
    const who = await ownerOf(request, id);
    if ('response' in who) return who.response;
    if (!(await deleteResult(id, who.userId, fileId))) return brickJson(request, { error: 'File not found' }, 404);
    return brickJson(request, { deleted: true });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error deleting a computer result:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
