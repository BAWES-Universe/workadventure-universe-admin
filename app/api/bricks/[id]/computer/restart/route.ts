import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { restartComputer } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;
// The computer is stopped and woken before this answers
export const maxDuration = 300;

/**
 * POST /api/bricks/:id/computer/restart
 * "Restart first" (post 0.5.0, 1B): offered only after a take over found a program still running (see take-over), and once per ask. The computer is restarted,
 * the job keeps its progress and sign-ins, and Brick gets the page ready again and asks the person again with the same ask. Answers `{ job }` as a hand back does.
 * 409 `notOffered` when there is nothing to restart for (no check is standing, or a restart was done for this ask already); 409 `inProgress` while a restart is on its way.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const restarted = await restartComputer(id, ownerId);
    if (restarted.ok) return brickJson(request, { job: restarted.job });
    if (restarted.reason === 'not_found') return notFound(request);
    if (restarted.reason === 'in_progress') return brickJson(request, { error: 'The computer is restarting. Try again in a moment.', reason: 'in_progress', inProgress: true }, 409);
    if (restarted.reason === 'not_offered') return brickJson(request, { error: 'There is nothing to restart for', reason: 'not_offered', notOffered: true }, 409);
    return brickJson(request, { error: 'Nothing is waiting for you' }, 409);
  });
