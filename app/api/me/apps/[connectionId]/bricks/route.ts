import { NextRequest } from 'next/server';
import { z } from 'zod';
import { grantToBrick, NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

const bodySchema = z.object({ botId: z.string().trim().min(1).max(100) }).strict();

/**
 * POST /api/me/apps/:id/bricks { botId } - "Let it use Gmail": one of the caller's own Bricks may use one of their own apps.
 * Anything else (a room bot, someone else's Brick, an app that is not theirs) answers 404. Asked twice, the same answer.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  return appsRoute(request, METHODS, 'letting a Brick use an app', async (user, respond) => {
    const { connectionId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const grant = await grantToBrick(user.id, connectionId, parsed.data.botId);
    if (!grant) return respond({ error: NOT_FOUND }, 404);
    return respond({ serverId: grant.id, botId: grant.botId }, 201);
  });
}
