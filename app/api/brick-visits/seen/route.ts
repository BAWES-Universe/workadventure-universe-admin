import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { keepVisitAlive } from '@/lib/brick-visit';

export const runtime = 'nodejs';

const bodySchema = z
  .object({ botId: z.string().trim().min(1).max(64), ownerUuid: z.string().trim().min(1).max(255), roomUrl: z.string().trim().min(1).max(2000) })
  .strict();

/**
 * POST /api/brick-visits/seen  { botId, ownerUuid, roomUrl }
 * The bot server's own client for a visiting Brick sees its owner in this room (game #2005): the visit is seen now. Answers
 * `{ alive }`: false when the visit is over (ended, switched, expired, the Brick is off or deleted, the place no longer takes
 * visits, or the owner may no longer open the room), and the bot server then takes the Brick off the map. An expired visit
 * is never brought back by this.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const { botId, ownerUuid, roomUrl } = parsed.data;
    return NextResponse.json({ alive: await keepVisitAlive(botId, ownerUuid, roomUrl) });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('[Bricks] Keeping a visit alive failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
