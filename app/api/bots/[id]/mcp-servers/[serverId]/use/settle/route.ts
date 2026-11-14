import { NextRequest } from 'next/server';
import { z } from 'zod';
import { SETTLE_OUTCOMES, settleSharedUse } from '@/lib/app-share';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const settleSchema = z.object({ callId: z.string().trim().min(1).max(200), outcome: z.enum(SETTLE_OUTCOMES) }).strict();

/**
 * POST /api/bots/:id/mcp-servers/:serverId/use/settle { callId, outcome: done | failed | unknown } - what a try at a shared job came
 * to (game #2006). `failed` gives the use back, and only when the bot server has confirmed the failure and settled anything
 * uncertain (it looked up what happened, and nothing was done). A timeout or a lost answer is `unknown`: the try stays counted and is
 * never run again. What the try cost stays in the books either way. 404 when there is no such try; 409 when it already ended the other
 * way (a try that finished is never given back; one given back never finishes). Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'settling a shared try', async () => {
    const { id, serverId } = await params;
    const body = await readBody(request, settleSchema);
    if (body.response) return body.response;
    const result = await settleSharedUse(id, serverId, body.data.callId, body.data.outcome);
    if (result.status === 'not_found') return json(request, { error: 'Not found' }, 404);
    if (result.status === 'conflict') return json(request, { error: 'This try already ended another way', now: result.now }, 409);
    return json(request, { status: result.now });
  });
}
