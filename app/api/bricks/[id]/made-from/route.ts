import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { madeFromView } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/:id/made-from
 * A Brick started from a template, on its page (game #2008): whose template it came from, what it still needs ("Setup
 * required" until it is set up), how many routines are still switched off, and "Template updated" when the maker shared a
 * newer version, as a change to review. 404 for a Brick not made from a template, and for anyone but its owner.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const view = await madeFromView(id, owner.userId);
    if (!view) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, view);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading what a Brick was made from:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
