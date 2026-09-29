import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/access-scope';
import { canManageBots } from '@/lib/bot-permissions';
import { readRoomAreas } from '@/lib/quests/room-areas';
import { welcomeQuestsForRoom, type BotQuestList } from '@/lib/quests/bot-quests';

export const runtime = 'nodejs';

/**
 * GET /api/bots/[id]/quests
 *
 * The quests a bot gives, for the bots service to tell the bot about them (workadventure-universe#565). Read with
 * the service token, or by a person who can manage the room's bots. Display text in the game's own words only: no
 * player text, no private data. A disabled or unknown bot does not exist for the caller.
 *
 * Until the quest engine (Orbit #202) records published quests and host bindings, the list is the proof slice's
 * Welcome chapter as this room offers it; see `lib/quests/bot-quests.ts`.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const bot = await prisma.bot.findUnique({
      where: { id },
      select: {
        id: true,
        enabled: true,
        roomId: true,
        room: { select: { slug: true, world: { select: { slug: true, universe: { select: { slug: true } } } } } },
      },
    });
    if (!bot || !bot.enabled) return NextResponse.json({ error: 'Bot not found' }, { status: 404 });

    if (viewer.kind === 'user' && !(await canManageBots(viewer.user.id, bot.roomId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { areas } = await readRoomAreas(bot.room);
    const list: BotQuestList = { botId: bot.id, roomId: bot.roomId, quests: welcomeQuestsForRoom(areas), source: 'welcome-chapter' };
    return NextResponse.json(list);
  } catch (error) {
    console.error('Error loading bot quests:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
