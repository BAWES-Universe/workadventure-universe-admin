import { NextRequest } from 'next/server';
import { json, preflight, serviceRoute } from '@/lib/bot-action-api';
import { keyAppsOf } from '@/lib/app-direct/use';
import { listCatalog } from '@/lib/app-direct/catalog';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * GET /api/bots/:id/key-apps - the apps with a key this Brick has (game #2044), for the bot server: each with its grant id, its
 * definition version, whether the service still accepts its key, what the Brick does under each heading for it, and its operations
 * as tools, and the services Universe ships a tested setup for (`services`, the key a Brick asks for one by). Never a key, its end, an address or the rest of a definition. Auth: BOT_SERVICE_TOKEN. An empty list for a bot that has none.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'listing key apps', async () => {
    const { id } = await params;
    return json(request, { apps: await keyAppsOf(id), services: listCatalog().map(({ service, name, short }) => ({ service, name, short })) });
  });
}
