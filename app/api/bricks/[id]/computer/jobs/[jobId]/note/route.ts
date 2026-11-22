import { NextRequest } from 'next/server';
import { z } from 'zod';
import { brickJson } from '@/lib/brick-api';
import { asOwner, optionsFor } from '@/lib/computer-api';
import { addJobNote, NOTE_MAX } from '@/lib/computer-job-notes';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

const bodySchema = z.object({ text: z.string().trim().min(1).max(NOTE_MAX) }).strict();

/**
 * POST /api/bricks/:id/computer/jobs/:jobId/note { text }
 * Tell a job something new without stopping it ("use 12 March instead"), or answer the question Brick asked. Running: it reaches the agent within seconds
 * and the job carries on with it. Waiting for the person (not taken over): it is their answer, and the job carries on. Taken over, in line or
 * paused: it is kept and given when Brick has the job again. Answers `{ computer, note: { seq, delivery } }` (delivery: now, answer, after_hand_back,
 * when_it_starts). Refused with 409 `{ error, reason }`: `over` (the job is over), `ending` (it is being ended). 404 for a job that is not this
 * Brick's. Only the owner.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const { jobId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', reason: 'empty' }, 400);
    const noted = await addJobNote(id, ownerId, jobId, parsed.data.text);
    if (noted.ok) return brickJson(request, { computer: noted.view, note: noted.note });
    if (noted.reason === 'not_found') return brickJson(request, { error: 'Job not found', reason: 'not_found' }, 404);
    if (noted.reason === 'empty') return brickJson(request, { error: 'Invalid input data', reason: 'empty' }, 400);
    return brickJson(request, { error: noted.reason === 'over' ? 'This job is over' : 'This job is already ending', reason: noted.reason }, 409);
  });
