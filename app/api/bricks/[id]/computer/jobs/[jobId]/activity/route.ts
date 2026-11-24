import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, optionsFor } from '@/lib/computer-api';
import { jobActivity } from '@/lib/computer-job-steps';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * GET /api/bricks/:id/computer/jobs/:jobId/activity
 * Activity, beside Watch and Files: the steps the job has done so far, oldest first, as `{ job: { id, title, status }, steps: [{ seq, label, at }] }`.
 * Labels are cleaned the same way as the bar's step (never a secret). Only the owner's own Brick and a job of it: anything else is 404, the same as a job
 * that does not exist. Reads only; it never wakes the computer.
 */
export const GET = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    const activity = await jobActivity(id, ownerId, jobId);
    return activity.ok ? brickJson(request, { job: activity.job, steps: activity.steps }) : brickJson(request, { error: 'Job not found' }, 404);
  });
