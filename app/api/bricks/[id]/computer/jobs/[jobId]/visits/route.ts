import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { brickOf } from '@/lib/computer';
import { visitsFor } from '@/lib/computer-visits';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * GET /api/bricks/:id/computer/jobs/:jobId/visits
 * Where the computer's browser went during one job (R06), oldest first: each page it opened and each post it sent, with host and path only
 * (never a query string, a fragment or what was sent) and the person's own take-overs marked, so a page they opened is not shown as Brick's.
 * `state` says how well it was recorded: complete, partial, unread or none (null until the job ends). Only the owner's own Brick and job:
 * anything else is the same answer as a job that does not exist. Reads only; it never wakes the computer.
 */
export const GET = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!(await brickOf(id, ownerId))) return notFound(request);
    const visits = await visitsFor(id, jobId);
    return visits ? brickJson(request, { visits }) : notFound(request);
  });
