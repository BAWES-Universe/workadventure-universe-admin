import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { finishAttempt, finishSchema } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/actions/:actionId/finish
 * How the attempt ended. Body: { attemptId, outcome: "succeeded" | "failed" | "notSent" | "uncertain", providerRequestId?,
 * outcomeClass? }. succeeded → done, failed → failed, uncertain → couldn't confirm (never claimed again by itself),
 * notSent → approved again while still inside its start window. 409 when that attempt is no longer the one running.
 * Auth: BOT_SERVICE_TOKEN. Response: { action }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'finishing the action', async () => {
    const { id, actionId } = await params;
    const body = await readBody(request, finishSchema);
    if (body.response) return body.response;
    return json(request, { action: await finishAttempt(id, actionId, body.data) });
  });
}
