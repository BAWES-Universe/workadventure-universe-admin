import { NextRequest } from 'next/server';
import { json, preflight, serviceRoute } from '@/lib/bot-action-api';
import { offeredInstantTools } from '@/lib/instant/tools';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * GET /api/instant/tools?botId= - the Instant tools this Brick may be offered right now (only for Apps its owner switched on for it; none otherwise), with their input schemas. Empty while Instant cannot
 * really run (limits not set, paused, no credit source, provider off): a tool is never offered that would be refused. Auth: BOT_SERVICE_TOKEN.
 */
export async function GET(request: NextRequest) {
  return serviceRoute(request, 'listing Instant tools', async () => json(request, await offeredInstantTools(request.nextUrl.searchParams.get('botId'))));
}
