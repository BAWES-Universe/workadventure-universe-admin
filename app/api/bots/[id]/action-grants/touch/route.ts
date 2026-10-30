import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { z } from 'zod';
import { touchGrants } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z.object({ requesterKey: z.string().trim().min(1).max(400), conversationKey: z.string().trim().min(1).max(400) }).strict();

/**
 * POST /api/bots/:id/action-grants/touch
 * The asker sent a message to the bot in this conversation: their remembered approvals there last another idle period,
 * never past their absolute end. Bot events and other people's messages do not call this. Body: { requesterKey,
 * conversationKey }. Auth: BOT_SERVICE_TOKEN. Response: { renewed }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'renewing remembered approvals', async () => {
    const { id } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    return json(request, await touchGrants(id, body.data));
  });
}
