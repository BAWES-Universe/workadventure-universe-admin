import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { itemsForScreen } from '@/lib/brick-item-screens';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/items
 * The "Goals and tasks" row on the Bricks page (game #2002): everything the signed-in person has given any of their Bricks that is still
 * wanted, each with its Brick's name and its group (progress, scheduled, done); a goal's own checks are nested under it. Only their own.
 */
export async function GET(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, { items: await itemsForScreen(owner.userId) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-items' } });
    console.error('Error listing goals and tasks:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
