import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { fillInDetails } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/fill-details
 * "Fill in my details" (game #2000): the person, in control, taps once and Brick puts in exactly what it named it was ready to put
 * in, and where (`job.ready`). The person approves what Brick showed, never something typed here: the body may carry the `what` and `where` the screen showed, and the tap is refused (409) when they are no longer what Brick named. Only
 * while they have taken over. Paying and submitting are never in it: those are theirs.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const body = (await request.json().catch(() => null)) as { what?: unknown; where?: unknown } | null;
    const shown = body && typeof body.what === 'string' && typeof body.where === 'string' ? { what: body.what, where: body.where } : null;
    const filling = await fillInDetails(id, ownerId, shown);
    if (filling.ok) return brickJson(request, { job: filling.job });
    if (filling.reason === 'not_found') return notFound(request);
    const error = filling.reason === 'nothing_ready' ? 'Nothing to fill in' : filling.reason === 'changed' ? 'What Brick is ready to fill in has changed' : 'Take over first';
    return brickJson(request, { error }, 409);
  });
