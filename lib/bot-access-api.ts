import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import { loadBotPlace, loadBrickHome, type BotPlace } from '@/lib/bot-access-settings';
import { ownsBrick } from '@/lib/brick';
import { corsHeaders } from '@/lib/cors';

export const json = (request: NextRequest, body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: corsHeaders(request) });

/**
 * Who may read and change one bot's rules (#427): whoever manages the bot (see canManageThisBot: its creator, the
 * universe's owner, Admin, anyone with Manage bots or a Yes of their own for this bot), and super admins. The bot
 * server's admin token may read. A stranger gets the same answer as for a bot that does not exist.
 */
export type BotManagerAccess =
  | { response: NextResponse; place?: undefined }
  | { response?: undefined; place: BotPlace & { roomId: string }; viewerId?: string };

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
      // loadBotPlace answers only for a room bot: a Brick has no place, and gets the "not found" above
      { id: place.id, createdById: place.createdById, roomId: place.roomId, ownerId: null, deletedAt: null },
      { creatorPasses: false },
    ))
  ) {
    return { response: json(request, { error: 'Bot not found' }, 404) };
  }
  return { place, viewerId: sessionUser.id };
}

/**
 * The same question for a Brick: only its owner reads and changes its settings (a super admin is "not found", like anyone
 * else). Null when the bot is not a Brick, so the caller goes on as for a room bot. A Brick has no rules or roles, so the
 * rules routes keep answering "not found" for it.
 */
export async function authorizeBrickOwner(request: NextRequest, botId: string): Promise<{ response?: NextResponse } | null> {
  const home = await loadBrickHome(botId);
  if (!home) return null;
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const expected = process.env.ADMIN_API_TOKEN;
    // The bot server is not a person: it is told what it was always told for a Brick, that there is nothing here for it
    return { response: json(request, token && expected && token === expected ? { error: 'Bot not found' } : { error: 'Unauthorized' }, token && expected && token === expected ? 404 : 401) };
  }
  if (!ownsBrick(home, sessionUser.id)) return { response: json(request, { error: 'Bot not found' }, 404) };
  return {};
}
