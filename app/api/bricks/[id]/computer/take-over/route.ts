import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { takeOver } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/take-over
 * "Take over" (game #2000): the person has the mouse and keyboard, only while the job waits for them (before details, a sign-in,
 * an upload, paying or submitting). Asked twice it is the same.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const control = await takeOver(id, ownerId);
    if (control.ok) return brickJson(request, { job: control.job });
    return control.reason === 'not_found' ? notFound(request) : brickJson(request, { error: 'Nothing is waiting for you' }, 409);
  });
