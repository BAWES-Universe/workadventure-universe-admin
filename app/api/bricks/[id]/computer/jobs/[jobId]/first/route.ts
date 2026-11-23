import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { moveJobFirst } from '@/lib/computer-job-controls';
import { controlAnswer, jobIdOk } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/first
 * "Do this next": the job waiting in line goes first. Body (optional) `{ pauseRunning: true }`: in one step, what has the computer now is paused and put back in line
 * right behind it, so it carries on by itself after this one however this one ends. On a paused job it is its resume.
 * Owner only. Answers `{ computer }`, 404 for a Brick or job that is not theirs, 409 `{ error, reason }` otherwise.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!jobIdOk(jobId)) return notFound(request);
    const text = await request.text().catch(() => '');
    let body: { pauseRunning?: unknown } | null = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { pauseRunning?: unknown };
      } catch {
        return brickJson(request, { error: 'The body is not JSON' }, 400);
      }
    }
    if (body && body.pauseRunning !== undefined && typeof body.pauseRunning !== 'boolean') return brickJson(request, { error: 'pauseRunning is true or false' }, 400);
    return controlAnswer(request, await moveJobFirst(id, ownerId, jobId, { pauseRunning: body?.pauseRunning === true }));
  });
