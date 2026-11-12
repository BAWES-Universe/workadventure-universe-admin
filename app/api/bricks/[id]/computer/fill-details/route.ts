import { NextRequest } from 'next/server';
import { z } from 'zod';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { fillInDetails } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

const bodySchema = z.object({ what: z.string().trim().min(1).max(150), where: z.string().trim().min(1).max(150) }).strict();

/**
 * POST /api/bricks/:id/computer/fill-details { what, where }
 * "Fill in my details" (game #2000): the person, in control, asks Brick to put in exactly this, there. Only while they have taken
 * over, and only what they name. Paying and submitting are never in it: those are theirs.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const filling = await fillInDetails(id, ownerId, parsed.data);
    if (filling.ok) return brickJson(request, { job: filling.job });
    return filling.reason === 'not_found' ? notFound(request) : brickJson(request, { error: 'Take over first' }, 409);
  });
