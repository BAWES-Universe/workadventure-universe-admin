import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { heldToldSchema, markHeldTold } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/items/held/:itemId/told   { waitId }
 * The bot server told the person that their goal or task is waiting (an entry of `held` from the due call, game #2002). Call it only
 * once it went through, with the notice's `waitId`: a notice that is not confirmed is handed out again by a later due call, so it is
 * never lost, and one that is confirmed is never handed out again for that wait. Answers { told }.
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    requireServiceToken(request);
    const { itemId } = await params;
    const parsed = heldToldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await markHeldTold(itemId, parsed.data.waitId);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ told: answer.told });
  } catch (error) {
    return itemsFailed(error, 'Keeping that the person was told');
  }
}
