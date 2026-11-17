import { NextRequest } from 'next/server';
import { z } from 'zod';
import { availableForBot, grantSharedToBot } from '@/lib/app-sharing';
import { AppsFull } from '@/lib/bot-limits';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, POST, OPTIONS';
type Params = { params: Promise<{ id: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/bots/:id/apps/available - "More apps it can use here" on a room bot's page (game #2001 step 7): the caller's own apps
 * lent to this bot's universe (they show only to the person who lent them) and the universe's own apps they manage, that this bot
 * does not use yet. 404 for anyone who cannot manage this bot.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'listing apps a bot could use', async (user, respond) => {
    const { id } = await params;
    const apps = await availableForBot(user.id, id);
    if (!apps) return respond({ error: NOT_FOUND }, 404);
    return respond({ apps });
  });
}

const bodySchema = z.object({ connectionId: z.string().trim().min(1).max(100) }).strict();

/**
 * POST /api/bots/:id/apps/available { connectionId } - "Let Guide use it". The caller must manage the bot, and the app must be one
 * they lent to its universe or one of the universe's own that they manage. Anything else answers 404. Lending moves no bot, so
 * this is the only way a bot starts using it.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'letting a bot use an app', async (user, respond) => {
    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const grant = await grantSharedToBot(user.id, parsed.data.connectionId, id).catch((error) => {
      if (error instanceof AppsFull) return error;
      throw error;
    });
    if (grant instanceof AppsFull) return respond({ error: grant.message }, 422);
    if (!grant) return respond({ error: NOT_FOUND }, 404);
    return respond({ serverId: grant.id, botId: grant.botId }, 201);
  });
}
