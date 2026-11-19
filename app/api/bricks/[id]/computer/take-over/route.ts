import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { takeOver } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/take-over
 * "Take over" (game #2000): the person has the mouse and keyboard, only while the job waits for them (before details, a sign-in,
 * an upload, paying or submitting). Asked twice it is the same: the second waits for the first's fence on the machine and answers when it is
 * done, or 409 `fencing` when that takes too long (try again).
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const control = await takeOver(id, ownerId);
    if (control.ok) return brickJson(request, { job: control.job });
    if (control.reason === 'not_found') return notFound(request);
    if (control.reason === 'fencing') return brickJson(request, { error: 'Your computer is still being made safe for you to take over: try again in a moment', fencing: true }, 409);
    return brickJson(request, { error: 'Nothing is waiting for you' }, 409);
  });
