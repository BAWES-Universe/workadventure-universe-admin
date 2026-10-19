import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import { loadBotPlace, type BotPlace } from '@/lib/bot-access-settings';
import { trustedCorsHeaders } from '@/lib/cors';

export const json = (request: NextRequest, body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: trustedCorsHeaders(request) });

/**
 * Who may read and change one bot's rules (#427): whoever manages the bot (see canManageThisBot: its creator, the
 * universe's owner, Admin, anyone with Manage bots or a Yes of their own for this bot), and super admins. The bot
 * server's admin token may read. A stranger gets the same answer as for a bot that does not exist.
 */
export type BotManagerAccess =
  | { response: NextResponse; place?: undefined }
  | { response?: undefined; place: BotPlace & { roomId: string } };

export async function authorizeBotManager(request: NextRequest, botId: string, options: { adminTokenReads: boolean }): Promise<BotManagerAccess> {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const expected = process.env.ADMIN_API_TOKEN;
    if (options.adminTokenReads && token && expected && token === expected) {
      const place = await loadBotPlace(botId);
      return place ? { place } : { response: json(request, { error: 'Bot not found' }, 404) };
    }
    return { response: json(request, { error: 'Unauthorized' }, 401) };
  }

  const place = await loadBotPlace(botId);
  if (
    !place ||
    !(await canManageThisBot(
      sessionUser.id,
      sessionUser.email,
      { id: place.id, createdById: place.createdById, roomId: place.roomId },
      { creatorPasses: false },
    ))
  ) {
    return { response: json(request, { error: 'Bot not found' }, 404) };
  }
  return { place };
}
