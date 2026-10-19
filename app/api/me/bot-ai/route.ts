import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { botAiOptions } from '@/lib/bot-ai-options';
import { resolveRoomIdFromPlayUri } from '@/lib/bot-config-helpers';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/me/bot-ai?botId=… or ?roomId=… (a room id or its play address, for a bot not made yet) - what the game's bot
 * page offers under "Runs on" for that bot, for the person asking (#374). Needs Manage bots in the bot's room.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const botId = request.nextUrl.searchParams.get('botId');
  const room = request.nextUrl.searchParams.get('roomId');
  if (!botId && !room) return respond(request, { error: 'botId or roomId is required' }, 400);

  try {
    let roomId: string | null = null;
    if (!botId && room) {
      try {
        roomId = UUID.test(room) ? room : await resolveRoomIdFromPlayUri(room);
      } catch {
        return respond(request, { error: 'Room not found' }, 404);
      }
    }
    const result = await botAiOptions({ viewer: { id: user.id, isSuperAdmin: user.isSuperAdmin }, botId, roomId });
    if (!result.ok) return respond(request, { error: result.error }, result.status);
    return respond(request, result.options);
  } catch (error) {
    console.error('[BotAi] Options failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
