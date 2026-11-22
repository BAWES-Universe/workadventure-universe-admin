import { NextRequest } from 'next/server';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { resumeJob } from '@/lib/computer-job-controls';
import { controlAnswer, jobIdOk } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/resume
 * Resume a paused job: it goes first in line and starts again with a new reservation, or stays first in line until the computer is free. Refused with `allowance` or `rule` when the month or a limit does not let it start (it stays paused).
 * Owner only. Answers `{ computer }` (the computer as the page shows it), 404 for a Brick or job that is not theirs, 409 `{ error, reason }` otherwise.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!jobIdOk(jobId)) return notFound(request);
    return controlAnswer(request, await resumeJob(id, ownerId, jobId));
  });
