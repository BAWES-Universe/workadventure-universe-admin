import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { templateLists } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/brick-templates
 * "Start from a template" (game #2008): three short lists, { starred, picks, met }. The ones the person starred, a few picked
 * by Universe, and Bricks they have met (talked with) that share one. Only what they may open, each as long as Limits says.
 * Popular and Trending are not here: they arrive with the Community shelf, under its own rules.
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, await templateLists(owner.userId));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error listing templates:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
