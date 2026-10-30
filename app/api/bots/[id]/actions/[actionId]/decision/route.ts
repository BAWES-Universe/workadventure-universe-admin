import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { DECISIONS, decide } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    actorKey: z.string().trim().min(1).max(400),
    revision: z.number().int().min(1),
    decision: z.enum(DECISIONS),
    startWithinSeconds: z.number().int().min(1).max(3600).optional(),
    idleMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    absoluteMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/actions/:actionId/decision
 * A tap. Body: { actorKey, revision, decision: "approve" | "approveAndRemember" | "decline" }. The tap carries only the
 * card's id and the revision it saw, never new content. Auth: BOT_SERVICE_TOKEN; actorKey must be the person who asked
 * (403 not_requester otherwise).
 * 200 { outcome: "decided", action, grantId } when this tap won. 409 { outcome: "already_decided" | "expired", action }
 * when another tap, a replacement or the clock got there first: a double tap or a second device gets this, with what
 * happened. approveAndRemember on a card that does not offer it is a 400 remember_not_offered.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'saving the decision', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const result = await decide(id, actionId, body.data);
    return json(request, result, result.outcome === 'decided' ? 200 : 409);
  });
}
