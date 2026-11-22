import { NextRequest } from 'next/server';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { pauseJob } from '@/lib/computer-job-controls';
import { controlAnswer, jobIdOk } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/pause
 * Pause ONE job: it is kept, with its place, its conversation and its sign-ins, and costs nothing while it waits. The time it ran so far is charged. Refused while the person has the screen (`taken_over`) or when it is already ending (`ending`).
 * Owner only. Answers `{ computer }` (the computer as the page shows it), 404 for a Brick or job that is not theirs, 409 `{ error, reason }` otherwise.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!jobIdOk(jobId)) return notFound(request);
    return controlAnswer(request, await pauseJob(id, ownerId, jobId));
  });
