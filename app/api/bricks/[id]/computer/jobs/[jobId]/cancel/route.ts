import { NextRequest } from 'next/server';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { cancelJob } from '@/lib/computer-job-controls';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { brickJson } from '@/lib/brick-api';
import { controlAnswer, jobIdOk, needCommand } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

// `expected`: the state the person was asked about (a job that had not started needs no question); a Cancel without a body is the one it always was
const bodySchema = z.object({ expected: z.literal('not_started').optional() }).strict();

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/cancel
 * Cancel ONE job: running or waiting, it ends as the person stopped it (charged only the time it used); waiting in line or paused, it leaves the line and nothing is charged. Every other job is left as it is.
 * With `{ expected: 'not_started' }` (the person was told the job had not started, so nothing was asked) it cancels only while that is still true: a job that started since is refused as 409 `{ error, reason: 'started' }` and nothing is cancelled.
 * Any other body is 400. Owner only. Answers `{ computer }` (the computer as the page shows it), 404 for a Brick or job that is not theirs, 409 `{ error, reason }` otherwise.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    if (!jobIdOk(jobId)) return notFound(request);
    const command = needCommand(request);
    if (command instanceof NextResponse) return command;
    // No body is a plain Cancel; a body that is not understood is never read as one
    const text = await request.text();
    let expected: 'not_started' | undefined;
    if (text.trim() !== '') {
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // falls to the 400 below
      }
      const parsed = bodySchema.safeParse(json);
      if (!parsed.success) return brickJson(request, { error: 'Invalid input data' }, 400);
      expected = parsed.data.expected;
    }
    // Without an expectation the call is exactly the one it always was
    return controlAnswer(request, expected ? await cancelJob(id, ownerId, jobId, new Date(), command, expected) : await cancelJob(id, ownerId, jobId, new Date(), command));
  });
