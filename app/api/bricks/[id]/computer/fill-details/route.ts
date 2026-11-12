import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { fillInDetails } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/fill-details
 * "Fill in my details" (game #2000): the person, in control, taps once and Brick puts in exactly what it named it was ready to put
 * in, and where (`job.ready`). The body is not read: the person approves what Brick showed, never something typed here. Only
 * while they have taken over. Paying and submitting are never in it: those are theirs.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const filling = await fillInDetails(id, ownerId);
    if (filling.ok) return brickJson(request, { job: filling.job });
    return filling.reason === 'not_found' ? notFound(request) : brickJson(request, { error: filling.reason === 'nothing_ready' ? 'Nothing to fill in' : 'Take over first' }, 409);
  });
