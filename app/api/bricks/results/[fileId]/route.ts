import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { deleteOwnResult, readOwnResult } from '@/lib/computer-file-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/results/:fileId
 * Opens one of the person's own results from a computer, whichever Brick made it (it may be gone). Only the person it belongs to: anyone else, a super admin
 * included, gets the answer for a file that is not there. Always a download of plain bytes, never something the browser opens as a page.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const { fileId } = await params;
    const result = await readOwnResult(owner.userId, fileId);
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

/** DELETE /api/bricks/results/:fileId - the person deletes one of their own results: the kept copy goes. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const { fileId } = await params;
    if (!(await deleteOwnResult(owner.userId, fileId))) return brickJson(request, { error: 'File not found' }, 404);
    return brickJson(request, { deleted: true });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error deleting a computer result:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
