import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { takeUpdate, takeUpdateSchema } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/:id/made-from/update  { version, take }
 * "Template updated", the owner's choice (game #2008): they take some parts, all or none of what the maker changed. Only
 * what they name is applied. Routines it adds come switched off. 409 when the version is not the latest any more.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = takeUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const taken = await takeUpdate(id, owner.userId, parsed.data);
    if (!taken.ok) return brickJson(request, { error: taken.error, code: taken.code }, taken.status);
    return brickJson(request, { madeFrom: taken.view.madeFrom, setup: taken.view.setup, update: taken.view.update, routines: taken.routines });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error taking a template update:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
