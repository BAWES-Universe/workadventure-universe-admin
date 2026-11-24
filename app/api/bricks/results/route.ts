import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { orphanResultsPage } from '@/lib/computer-file-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/results
 * What a person's Bricks' computers made for them that no Brick of theirs is left to show: its Brick was deleted (waiting out its Undo days, or removed for good). The
 * files are theirs and stay until they delete them; only the Brick's name on them is "A deleted Brick". Results of a Brick that is still
 * there are on that Brick's own Files. Only the signed-in person's own. A hundred at a time, newest first: `next` is the `cursor` for the next page (null: the last).
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const asked = request.nextUrl.searchParams.get('cursor');
    const page = await orphanResultsPage(owner.userId, { cursor: asked });
    if (!page) return brickJson(request, { error: 'Not a page of these results' }, 400);
    return brickJson(request, {
      next: page.next,
      results: page.results.map((result) => ({ id: result.id, name: result.name, sizeBytes: result.bytes, job: result.jobTitle, brick: result.brick, at: result.at.toISOString(), delivery: result.delivery })),
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-files' } });
    console.error('Error listing results of deleted Bricks:', error instanceof Error ? error.message : 'unknown error');
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
