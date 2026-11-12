import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { handBack } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/** POST /api/bricks/:id/computer/hand-back - "Hand back to Brick" (game #2000): Brick carries on from where the person left it. */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const control = await handBack(id, ownerId);
    if (control.ok) return brickJson(request, { job: control.job });
    return control.reason === 'not_found' ? notFound(request) : brickJson(request, { error: 'Nothing is waiting for you' }, 409);
  });
