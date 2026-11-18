import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { homedBricksForRoom } from '@/lib/brick-home';
import { transformHomedBrickToServerFormat } from '@/lib/bot-config-helpers';

export const runtime = 'nodejs';

const bodySchema = z.object({ roomUrl: z.string().trim().min(1).max(2000) }).strict();

/**
 * POST /api/brick-homes/room  { roomUrl }
 * The Bricks that live in this room (game #2005), for the bot server, in the Brick shape it already knows with the
 * room's URLs, how each behaves there and `brick.home` naming whose it is. Only Bricks that are on and not deleted, and
 * whose owner can still manage bots here. Today's `GET /api/bots/configuration` is unchanged and never lists one.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const { roomUrl } = parsed.data;
    const homes = await homedBricksForRoom(roomUrl);
    const defaults = homes.length > 0 ? await prisma.defaultBrick.findMany({ where: { botId: { in: homes.map((home) => home.bot.id) } }, select: { botId: true } }) : [];
    const defaultIds = new Set(defaults.map((row) => row.botId));
    return NextResponse.json(
      homes.map((home) => transformHomedBrickToServerFormat(home.bot, defaultIds.has(home.bot.id), { roomUrl, behaviorType: home.behaviorType, behaviorConfig: home.behaviorConfig }, home.placedBy)),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('[Bricks] Bricks living in a room failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
