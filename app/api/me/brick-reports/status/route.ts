import { NextRequest } from 'next/server';
import { z } from 'zod';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { reportNoteStatus } from '@/lib/brick-reports';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const bodySchema = z.object({ id: z.string().trim().min(1).max(100), key: z.string().trim().min(16).max(100) }).strict();

/**
 * POST /api/me/brick-reports/status { id, key } - what became of a note a Brick sent: `{ state: 'live', words, canTakeBack }`,
 * `{ state: 'taken_back', words: '', canTakeBack: false }` or `{ state: 'not_found' }`. The chat reads it when the note is opened, so
 * "Taken back" shows on every device. POST so the key never sits in a link or a log. No sign-in, like take-back: the key is the proof.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respond(request, { error: 'Invalid body' }, 400);
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return respond(request, { error: 'Invalid body' }, 400);
  try {
    return respond(request, await reportNoteStatus(body.data.id, body.data.key));
  } catch (error) {
    console.error('[Brick reports] Could not read a note:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
