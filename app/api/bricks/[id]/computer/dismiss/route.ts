import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { dismissComputerNotice } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/dismiss - the person dismisses the notice of how the last job ended (game #2000). The body names the
 * job it was shown for, so only that ending goes away: `{ jobId }`.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const body = (await request.json().catch(() => null)) as { jobId?: unknown } | null;
    if (!body || typeof body.jobId !== 'string' || !body.jobId || body.jobId.length > 40) return brickJson(request, { error: 'Say which ending to dismiss' }, 400);
    const result = await dismissComputerNotice(id, ownerId, body.jobId);
    return result.ok ? brickJson(request, { computer: result.view }) : notFound(request);
  });
