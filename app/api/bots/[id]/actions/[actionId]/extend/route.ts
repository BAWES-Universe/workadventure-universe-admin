import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { extendReview } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    actorKey: z.string().trim().min(1).max(400),
    revision: z.number().int().min(1),
    reviewMinutes: z.number().int().min(1).max(24 * 60).optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/actions/:actionId/extend
 * "More time" on a card still waiting. Body: { actorKey, revision, reviewMinutes? } where reviewMinutes is the bot's own
 * "A card waits" setting. The card gets another full wait from now, never shorter than what it has left; the revision goes
 * up so the card is redrawn with its new end. It never approves anything. At most 10 times per card (409 no_more_time).
 * Auth: BOT_SERVICE_TOKEN; actorKey must be the person who asked. 200 { outcome: "changed", action }; 409
 * { outcome: "already_decided" | "expired", action } when it is no longer waiting or ran out first.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'giving the card more time', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const result = await extendReview(id, actionId, body.data);
    return json(request, result, result.outcome === 'changed' ? 200 : 409);
  });
}
