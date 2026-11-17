import { NextRequest } from 'next/server';
import { asBotServer, bodyOf } from '@/lib/guest-brick-api';
import { finishGuestBrickReply } from '@/lib/guest-brick';

/**
 * PATCH /api/guest-brick/replies/:turnId
 * Closes one counted turn (game #1997). Body: { failed?: boolean, tokensUsed?: number, costMicros?: number }.
 * A reply that failed is given back and stops counting. What it took is kept as totals, never what was said.
 *
 * Auth: service token only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ turnId: string }> }) {
  return asBotServer(request, async () => finishGuestBrickReply((await params).turnId, await bodyOf(request)));
}
