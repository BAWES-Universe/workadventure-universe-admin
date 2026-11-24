import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { allowMet, listMet, revokeMet } from '@/lib/brick-met';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const personSchema = z.object({ personId: z.string().trim().min(1).max(64) }).strict();
const revokeSchema = z.object({ personId: z.string().trim().min(1).max(64).optional() }).strict();

/**
 * GET /api/bricks/:id/met
 * The people who met this Brick and may still message it (game #2005, "People who met"), for its owner: who, when they met it
 * and whether they have written to it. Names only, never what was said. Only its owner: for anyone else, a super admin
 * included, the answer is the same as for a Brick that does not exist.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const people = await listMet(id, owner.userId);
    if (!people) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { people });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error reading who met a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/bricks/:id/met  { personId? }
 * The owner takes a person off, or everyone who met the Brick when none is named: they can no longer message it, wherever it is,
 * until the owner lets them back. This is the explicit decision that ends a kept conversation; a visit ending never does.
 * Asked twice, the same. Answers how many were taken off.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    // No body at all takes everyone off (that is what the request says); a body that is not valid JSON, or is not an object, is refused, never read as "everyone"
    const text = await request.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return brickJson(request, { error: 'Invalid input data' }, 400);
      }
    }
    const parsed = revokeSchema.safeParse(raw);
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const count = await revokeMet(id, owner.userId, parsed.data.personId ?? null);
    if (count === null) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { takenOff: count });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error taking someone off a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/bricks/:id/met  { personId }
 * The owner lets a person they took off message the Brick again. They still have to have met it: this only undoes the decision.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = personSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const answer = await allowMet(id, owner.userId, parsed.data.personId);
    if (answer === null) return brickJson(request, { error: 'Brick not found' }, 404);
    return brickJson(request, { allowed: answer });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error letting someone back to a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
