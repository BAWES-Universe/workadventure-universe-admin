import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { claim } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z.object({ leaseSeconds: z.number().int().min(1).max(3600).optional() }).strict();

/**
 * POST /api/bots/:id/actions/:actionId/claim
 * A dispatcher takes the one go at running an approved action. Body: { leaseSeconds? }. Auth: BOT_SERVICE_TOKEN.
 * 200 { claimed: true, action, attemptId, attemptNo, idempotencyKey } for the one dispatcher that wins; 409
 * { claimed: false, reason, action } for anyone else, for an approval older than its start window (reason "stale",
 * closed) and for an action marked couldn't confirm, which can never be claimed again.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'claiming the action', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, bodySchema, true);
    if (body.response) return body.response;
    const result = await claim(id, actionId, body.data);
    return json(request, result, result.claimed ? 200 : 409);
  });
}
