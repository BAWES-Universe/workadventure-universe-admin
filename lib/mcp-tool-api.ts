import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { corsHeaders } from '@/lib/cors';

export const json = (request: NextRequest, body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: corsHeaders(request) });

export type ToolsAccess =
  | { response: NextResponse; person?: undefined }
  | { response?: undefined; /** Who is asking; null for the bot server. */ person: { id: string } | null };

/**
 * Who may read and change a bot's tool settings (#738): people with Manage bots for it (see canManageBotMcpServers; its
 * creator gets no extra way in once they lose Manage bots), and super admins. The bot server's `ADMIN_API_TOKEN` is the
 * only one that may write the tool list it read, and may read too. Someone who signed in but may not manage the bot gets
 * a 403.
 */
export async function authorizeToolsRequest(
  request: NextRequest,
  botId: string,
  options: { adminToken: 'read' | 'write' | 'none' },
  action: 'read' | 'write' = 'write',
): Promise<ToolsAccess> {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const expected = process.env.ADMIN_API_TOKEN;
    const tokenMay = options.adminToken === 'write' || (options.adminToken === 'read' && action === 'read');
    if (tokenMay && token && expected && token === expected) {
      const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
      return bot ? { person: null } : { response: json(request, { error: 'Bot not found' }, 404) };
    }
    return { response: json(request, { error: 'Unauthorized' }, 401) };
  }

  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, createdById: true, roomId: true } });
  if (!bot) return { response: json(request, { error: 'Bot not found' }, 404) };
  if (!(await canManageBotMcpServers(sessionUser.id, sessionUser.email ?? null, bot))) {
    return { response: json(request, { error: 'Forbidden' }, 403) };
  }
  return { person: { id: sessionUser.id } };
}

/** The answer for a failure: the one a person can be told about, or a 500 that is reported. */
export function toolsFailure(request: NextRequest, error: unknown, what: string): NextResponse {
  if (error instanceof BotSettingsError) return json(request, { error: error.message }, error.status);
  Sentry.captureException(error, { tags: { area: 'bot-tools' } });
  console.error(`Error ${what}:`, error);
  return json(request, { error: `Failed ${what}` }, 500);
}
