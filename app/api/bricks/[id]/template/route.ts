import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { readMakerTemplate, shareRequestSchema, shareTemplate, stopSharing } from '@/lib/brick-templates';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bricks/:id/template
 * A Brick's "Template" group (game #2008): whether it is shared, who for, which version, how many Bricks were made from it,
 * whether it has changed since it was shared, and the routines it could take along on purpose. Only its owner: for anyone
 * else, a room bot or a Brick that waits deleted, "not found".
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const template = await readMakerTemplate(id, owner.userId);
    if (!template) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { template });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading a Brick’s template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * PUT /api/bricks/:id/template  { token, leaveOutLook?, firstThing?, optionalNeeds?, routines?, audience? }
 * "Share as a template" and "Share your latest changes": shares exactly what the maker read in the look. `token` is the
 * look's own; if the Brick changed since, nothing is shared and the answer is 409 with the look to read again. A secret in
 * it is 422. Sharing what is already shared makes no new version. Answers with the template group.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = shareRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const shared = await shareTemplate(id, owner.userId, parsed.data);
    if (!shared.ok) return brickJson(request, { error: shared.error, code: shared.code, look: shared.look }, shared.status);
    return brickJson(request, { template: shared.template });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error sharing a Brick as a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/bricks/:id/template
 * "Stop sharing": nobody new can use it. Bricks already made from it, and this Brick, are not touched. Asked twice, the
 * second answer is the same.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const template = await stopSharing(id, owner.userId);
    if (!template) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { template });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error stopping sharing a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
