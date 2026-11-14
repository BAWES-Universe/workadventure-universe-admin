import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { previewTemplate } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/brick-templates/:id
 * The look before creating (game #2008): what a new Brick starts with (its look, line, instructions, first thing to try and
 * the routines that come switched off), what stays with the original, what it still needs for this person and whether its
 * main job lacks something ("Setup required"). Anyone signed in may open a shared template; one that stopped being shared,
 * or whose Brick waits deleted, is "not found".
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const template = await previewTemplate(id, owner.userId);
    if (!template) return brickJson(request, { error: 'Template not found' }, 404);
    return brickJson(request, { template });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
