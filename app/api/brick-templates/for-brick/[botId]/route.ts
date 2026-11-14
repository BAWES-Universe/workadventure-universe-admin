import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { templateOfBrick } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/brick-templates/for-brick/:botId
 * The card of a Brick someone meets (game #2008): its template, so "Use template" can sit beside "Message", or
 * { template: null }. Only a template shared with everyone is ever on a card; one shared by link only is not.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  try {
    const { botId } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, { template: await templateOfBrick(botId, owner.userId) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading the template of a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
