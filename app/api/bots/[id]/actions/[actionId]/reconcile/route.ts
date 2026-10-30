import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { reconcile } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z.object({ outcome: z.enum(['succeeded', 'failed']) }).strict();

/**
 * POST /api/bots/:id/actions/:actionId/reconcile
 * What was found about an action marked couldn't confirm (from the destination's own record). Body: { outcome:
 * "succeeded" | "failed" }. It becomes done or failed and is never run again. 409 when it was not waiting to be confirmed.
 * Auth: BOT_SERVICE_TOKEN. Response: { action }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'reconciling the action', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    return json(request, { action: await reconcile(id, actionId, body.data) });
  });
}
