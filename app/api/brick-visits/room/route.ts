import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { bricksForRoom } from '@/lib/brick-visit';
import { transformVisitingBrickToServerFormat } from '@/lib/bot-config-helpers';

export const runtime = 'nodejs';

const bodySchema = z.object({ roomUrl: z.string().trim().min(1).max(2000), people: z.array(z.string().max(255)).max(500), enteredAt: z.number().int().positive().optional() }).strict();

/**
 * POST /api/brick-visits/room  { roomUrl, people: [WorkAdventure ids], enteredAt?: ms when their game saw them come in }
 * The Bricks visiting this room (game #2005), for the people the bot server found in it. Asked each time the bot server
 * syncs a room: it is how a Brick follows its person from room to room and how a visit stays alive. Every person found
 * has their visit seen here now. Only a signed-in person's Brick that is on, not deleted and visiting comes back, and
 * nothing at all where the universe does not take visiting Bricks. Each is in the Brick shape the bot server already
 * knows, with `brick.visiting` naming the person it walks beside. An address that is no room answers an empty list.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const { roomUrl, people, enteredAt } = parsed.data;
    const { visiting } = await bricksForRoom(roomUrl, people, new Date(), enteredAt === undefined ? undefined : new Date(enteredAt));
    const defaults = visiting.length > 0 ? await prisma.defaultBrick.findMany({ where: { botId: { in: visiting.map((row) => row.bot.id) } }, select: { botId: true } }) : [];
    const defaultIds = new Set(defaults.map((row) => row.botId));
    return NextResponse.json(
      visiting.map((row) => transformVisitingBrickToServerFormat(row.bot, defaultIds.has(row.bot.id), { roomUrl }, { uuid: row.ownerUuid, name: row.ownerName })),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('[Bricks] Visiting Bricks for a room failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
