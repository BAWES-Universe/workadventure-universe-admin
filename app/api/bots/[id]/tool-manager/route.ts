import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { findUserByIdentifier } from '@/lib/user-identifier';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z.object({ identifier: z.string().trim().min(1).max(320) }).strict();

/**
 * POST /api/bots/:id/tool-manager
 * Whether this person can manage the bot's tools (the same Manage bots answer the Tools page uses, creator gets no extra
 * way in). The bot server asks it before it lets someone try a tool nobody has confirmed yet (#1656): only people who
 * manage the bot may, with a card every time. Body: { identifier } (their WorkAdventure uuid or email). Auth: BOT_SERVICE_TOKEN.
 * Response: { canManage: boolean }. A person Orbit has no account for can't. 404 when there is no such bot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'checking who manages the tools', async () => {
    const { id } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const bot = await prisma.bot.findUnique({ where: { id }, select: { id: true, createdById: true, roomId: true, ownerId: true } });
    if (!bot) return json(request, { error: 'Bot not found' }, 404);
    const user = await findUserByIdentifier(body.data.identifier);
    // A guest has no account here, so there is nothing to manage with
    if (!user || user.isGuest) return json(request, { canManage: false });
    return json(request, { canManage: await canManageBotMcpServers(user.id, user.email ?? null, bot) });
  });
}
