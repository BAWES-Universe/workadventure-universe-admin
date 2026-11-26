import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { confirmReportReceipts } from '@/lib/brick-reports';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z.object({ botId: z.string().trim().min(1).max(100), ids: z.array(z.string().uuid()).min(1).max(4) }).strict();

/**
 * POST /api/bricks/reports/delivered { botId, ids } - the bot server's word that the chat message carrying these notes' receipts (and Take
 * it back) went out. A note never confirmed within 15 minutes is withdrawn, like Take it back, so none stays that its chat cannot see.
 * Answers `{ confirmed }`, how many were waiting. Only the Brick's own notes. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'confirming Brick report receipts', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    return json(request, { confirmed: await confirmReportReceipts(body.data.botId, body.data.ids) });
  });
}
