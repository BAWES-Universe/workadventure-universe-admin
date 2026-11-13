import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { computerView, giveComputer, turnOffComputer } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/bricks/:id/computer
 * What a Brick's page shows under Computer (game #2000): whether computers are open on this server, whether it is on, what it is
 * doing, how much of the person's month is left (a share, never a count or a price), where its files are. Only reads: it never
 * makes or wakes anything.
 */
export const GET = (request: NextRequest, { params }: Params) =>
  asOwner(request, params, async (id, ownerId) => {
    const view = await computerView(id, ownerId);
    return view ? brickJson(request, { computer: view }) : notFound(request);
  });

/**
 * POST /api/bricks/:id/computer
 * "Give Brick a computer". There is no switch per person: every member may, for their own Brick, and the allowance is the bound.
 * No machine is made: that waits for a job that needs one. Asked twice it is the same.
 */
export const POST = (request: NextRequest, { params }: Params) =>
  asOwner(request, params, async (id, ownerId) => {
    const given = await giveComputer(id, ownerId);
    if (given.ok) return brickJson(request, { computer: given.view });
    return given.reason === 'not_found' ? notFound(request) : brickJson(request, { error: 'Computers are not open yet' }, 503);
  });

/**
 * DELETE /api/bricks/:id/computer
 * "Turn off computer": its work stops at once, its files are saved and kept, and Brick goes back to answers and apps.
 */
export const DELETE = (request: NextRequest, { params }: Params) =>
  asOwner(request, params, async (id, ownerId) => {
    const view = await turnOffComputer(id, ownerId);
    return view ? brickJson(request, { computer: view }) : notFound(request);
  });
