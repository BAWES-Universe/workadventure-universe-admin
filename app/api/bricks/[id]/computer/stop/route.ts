import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { stopJobFor } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/stop
 * "Stop" (game #2000): the job that has the computer ends and the work so far is kept. Asked with nothing running it changes
 * nothing. Answers with the computer as the page shows it.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const view = await stopJobFor(id, ownerId);
    return view ? brickJson(request, { computer: view }) : notFound(request);
  });
