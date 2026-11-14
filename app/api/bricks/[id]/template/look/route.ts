import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { lookAtTemplate, shareChoicesSchema } from '@/lib/brick-templates';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/:id/template/look  { leaveOutLook?, firstThing?, optionalNeeds?, routines?, audience? }
 * The look before sharing (game #2008): exactly what would go with the template (its name, its look, its instructions, its
 * first thing to try, what people will need and the routines the maker added), what never goes, and what the secret check
 * found. Writes nothing, and nothing is shared until PUT /api/bricks/:id/template carries the look's `token`. Only for the
 * Brick's owner.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = shareChoicesSchema.safeParse((await request.json().catch(() => null)) ?? {});
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const looked = await lookAtTemplate(id, owner.userId, parsed.data);
    if (!looked.ok) return brickJson(request, { error: looked.error, code: looked.code }, looked.status);
    return brickJson(request, { look: looked.look });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading the look of a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
