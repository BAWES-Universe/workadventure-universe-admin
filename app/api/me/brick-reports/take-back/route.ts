import { NextRequest } from 'next/server';
import { z } from 'zod';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { takeBackReportNote } from '@/lib/brick-reports';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const bodySchema = z.object({ id: z.string().trim().min(1).max(100), key: z.string().trim().min(16).max(100) }).strict();

/**
 * POST /api/me/brick-reports/take-back { id, key } - takes back a note a Brick sent to the Universe team, within 24 hours. The key is in the
 * chat's own message, so anyone in that chat can, and nobody else. Answers `{ takenBack: true }`, or `{ takenBack: false, reason }`
 * (not_found, too_late). No sign-in: guests' chats send notes too, and the key (24 random bytes, compared in constant time) is the proof.
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
    return respond(request, await takeBackReportNote(body.data.id, body.data.key));
  } catch (error) {
    console.error('[Brick reports] Could not take a note back:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
