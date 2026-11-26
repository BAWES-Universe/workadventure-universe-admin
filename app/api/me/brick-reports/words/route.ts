import { NextRequest } from 'next/server';
import { z } from 'zod';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { addReportWords } from '@/lib/brick-reports';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const bodySchema = z.object({ id: z.string().trim().min(1).max(100), key: z.string().trim().min(16).max(100), words: z.string().max(1200) }).strict();

/**
 * POST /api/me/brick-reports/words { id, key, words } - adds the person's own words to a note a Brick sent, when they press Send on the
 * exact cleaned words the chat showed them. Cleaned again here, the same way, so what is kept is what they saw. Within 24 hours;
 * sending again replaces them. Answers `{ added: true, words }` or `{ added: false, reason }` (not_found, too_late, taken_back, empty).
 * No sign-in, like take-back: the key is the proof.
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
    return respond(request, await addReportWords(body.data.id, body.data.key, body.data.words));
  } catch (error) {
    console.error('[Brick reports] Could not add words to a note:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
