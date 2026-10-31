import { NextRequest } from 'next/server';
import { json, preflight, serviceRoute } from '@/lib/bot-action-api';
import { readRequest } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * GET /api/bots/:id/actions/:actionId
 * The request as it stands, with its arguments and attempts. A card that waited too long, or an approval nobody started,
 * is closed first. Auth: BOT_SERVICE_TOKEN.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  return serviceRoute(request, 'reading the action', async () => {
    const { id, actionId } = await params;
    return json(request, { action: await readRequest(id, actionId) });
  });
}
