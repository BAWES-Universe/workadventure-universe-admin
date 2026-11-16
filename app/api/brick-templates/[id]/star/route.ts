import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { starTemplate, unstarTemplate } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/** PUT /api/brick-templates/:id/star: Star keeps a template for later (game #2008). Starring twice is the same star. 404 when it is not there to open. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    if (!(await starTemplate(id, owner.userId))) return brickJson(request, { error: 'Template not found' }, 404);
    return brickJson(request, { starred: true });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error starring a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/** DELETE /api/brick-templates/:id/star: takes the star off, even from a template that is no longer shared. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    await unstarTemplate(id, owner.userId);
    return brickJson(request, { starred: false });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error unstarring a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
