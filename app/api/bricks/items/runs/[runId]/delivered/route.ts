import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { deliveredSchema, markDelivered } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/items/runs/:runId/delivered   { eventId }
 * The run's message was sent into the Brick's own chat (game #2002): keep the chat event it got back, right after the send
 * and before the run is reported. If the run is handed out again it carries this id and must not send again; if the id is
 * unknown (a crash between the send and this call) the bot server looks in the chat for the run's `marker` first. The first
 * id stands. Answers { eventId, first }, or 409 for a different id. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    requireServiceToken(request);
    const { runId } = await params;
    const parsed = deliveredSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await markDelivered(runId, parsed.data.eventId);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ eventId: answer.eventId, first: answer.first });
  } catch (error) {
    return itemsFailed(error, 'Keeping where a run sent');
  }
}
