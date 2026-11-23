import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { stopAll } from '@/lib/computer';
import { commandOf } from '@/lib/computer-commands';
import { COMMAND_MISSING } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/stop
 * "Stop" (game #2000): the job that has the computer ends and the work so far is kept. Asked with nothing running it changes
 * nothing. Answers with the computer as the page shows it.
 * The 0.5 panel sends the tap's command id (header X-Computer-Command, finding 4): it ends only the jobs that were on the computer at the first request, and the same id again ends nothing more. The 0.4.3 game's Stop
 * has none and is answered as before. 400 `command_missing` for an id that is not a uuid, `command_reused` for one used for another control.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const command = commandOf(request);
    if (command === 'invalid') return brickJson(request, { error: COMMAND_MISSING, reason: 'command_missing' }, 400);
    const stopped = await stopAll(id, ownerId, new Date(), command ?? undefined);
    if (stopped.ok) return brickJson(request, { computer: stopped.view });
    if (stopped.reason === 'command_reused') return brickJson(request, { error: 'That control was already used for something else. Try again.', reason: 'command_reused' }, 400);
    return notFound(request);
  });
