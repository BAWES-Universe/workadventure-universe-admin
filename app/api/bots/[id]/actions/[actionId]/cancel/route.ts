import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { cancelRequest } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    actorKey: z.string().trim().min(1).max(400),
    revision: z.number().int().min(1),
  })
  .strict();

/**
 * POST /api/bots/:id/actions/:actionId/cancel
 * The asker closed one card with X: nothing is done. Body: { actorKey, revision }. Only a request still waiting, at the
 * revision the card showed; actorKey must be the person who asked (403 not_requester otherwise). Auth: BOT_SERVICE_TOKEN.
 * 200 { outcome: "changed", action } when this closed it. 409 { outcome: "already_decided" | "expired", action } when another
 * tap, a replacement or the clock got there first.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'closing the card', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const result = await cancelRequest(id, actionId, body.data);
    return json(request, result, result.outcome === 'changed' ? 200 : 409);
  });
}
