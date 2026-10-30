import { NextRequest } from 'next/server';
import { json, preflight, serviceRoute } from '@/lib/bot-action-api';
import { sweep } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/actions/sweep
 * Housekeeping for one bot: cards that waited too long close as expired, approvals nobody started close as stale, and a
 * run whose claim ran out becomes couldn't confirm (it may have happened, so it is never claimed again by itself). Safe
 * to call any time. Auth: BOT_SERVICE_TOKEN. Response: { expired, stale, unconfirmed }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'sweeping the actions', async () => {
    const { id } = await params;
    return json(request, await sweep(id));
  });
}
