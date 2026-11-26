import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { restartOffered, takeOver } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/take-over   { anyway?: true }
 * "Take over" (game #2000): the person has the mouse and keyboard, only while the job waits for them (before details, a sign-in,
 * an upload, paying or submitting). Asked twice it is the same: the second waits for the first's fence on the machine and answers when it is
 * done, or 409 `fencing` when that takes too long (try again).
 *
 * The honest check (post 0.5.0, 1B): when a program the agent left behind is still running and the fence could not stop it, nothing is stopped and the answer is
 * 409 `stillRunning` (with `restartOffered`: whether "Restart first" can still be offered for this ask). The person then restarts (`/restart`) or asks again with `anyway: true`,
 * which goes on with it running; the computer says so until the hand back. A check that passed says nothing. No program is named.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const body = (await request.json().catch(() => null)) as { anyway?: unknown } | null;
    const control = await takeOver(id, ownerId, new Date(), { anyway: body?.anyway === true });
    if (control.ok) return brickJson(request, { job: control.job });
    if (control.reason === 'not_found') return notFound(request);
    if (control.reason === 'in_progress') return brickJson(request, { error: 'The computer is still changing hands. Try again in a moment.', reason: 'in_progress', inProgress: true }, 409);
    if (control.reason === 'still_running') return brickJson(request, { error: 'A program is still running on this computer.', reason: 'still_running', stillRunning: true, restartOffered: await restartOffered(id) }, 409);
    if (control.reason === 'not_secured') return brickJson(request, { error: 'Couldn’t get the computer ready. Nothing was changed on it. Try again.', reason: 'not_secured', notSecured: true }, 409);
    return brickJson(request, { error: 'Nothing is waiting for you' }, 409);
  });
