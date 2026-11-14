import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { fromTemplateSchema, makeBrickFromTemplate } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/brick-templates/:id/use  { name? }
 * "Create Brick" (game #2008): the signed-in person's own new Brick from a template. It is a new individual with its own
 * name and identity, no memory, grants or history, and the maker's name stays on it. Routines the maker added arrive switched
 * off. Answers 201 with its card, where it came from, what it still needs ("Setup required") and how many routines came.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    // No body at all means "its own name, nothing else"; a body that is not JSON is refused before anything is made
    const text = await request.text();
    let body: unknown = {};
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        return brickJson(request, { error: 'Invalid input data' }, 400);
      }
    }
    const parsed = fromTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const used = await makeBrickFromTemplate(owner.userId, id, parsed.data);
    if (!used.ok) return brickJson(request, { error: used.error }, used.status);
    return brickJson(request, { brick: used.brick, madeFrom: used.madeFrom, setup: used.setup, routines: used.routines }, 201);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error making a Brick from a template:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
