import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { supersedeWaiting } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    requesterKey: z.string().trim().min(1).max(400),
    conversationKey: z.string().trim().min(1).max(400),
    reason: z.enum(['superseded', 'cancelled']).optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/actions/supersede
 * The asker sent a replacement instruction in this conversation: their action still waiting for a tap, or approved and
 * not yet claimed, is closed. Body: { requesterKey, conversationKey, reason?: "superseded" | "cancelled" }. Another
 * person's message or another conversation never calls this. Auth: BOT_SERVICE_TOKEN. Response: { closed: [ids] }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'closing the waiting action', async () => {
    const { id } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    return json(request, await supersedeWaiting(id, body.data));
  });
}
