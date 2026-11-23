import { NextRequest } from 'next/server';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { cancelJob } from '@/lib/computer-job-controls';
import { controlAnswer, jobIdOk } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/cancel
 * Cancel ONE job: running or waiting, it ends as the person stopped it (charged only the time it used); waiting in line or paused, it leaves the line and nothing is charged. Every other job is left as it is.
 * Owner only. Answers `{ computer }` (the computer as the page shows it), 404 for a Brick or job that is not theirs, 409 `{ error, reason }` otherwise.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!jobIdOk(jobId)) return notFound(request);
    return controlAnswer(request, await cancelJob(id, ownerId, jobId));
  });
