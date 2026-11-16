import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { itemsForScreen, ownsBrickNow } from '@/lib/brick-item-screens';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/:id/items
 * The "Goals and tasks" group on a Brick's own page (game #2002): this Brick's goals and tasks that are still wanted, each in its group
 * (progress, scheduled, done). Only its owner: anyone else, a super admin included, and a room bot get the same answer as for a Brick
 * that does not exist.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    if (!(await ownsBrickNow(id, owner.userId))) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { items: await itemsForScreen(owner.userId, id) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-items' } });
    console.error('Error listing a Brick’s goals and tasks:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
