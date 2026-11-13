import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { markTold } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/items/runs/:runId/told
 * The bot server told the person about a row of failures (the run's report said `tellPerson`, game #2002). Call it only once the
 * tell went through: a tell that failed is not marked, so the next failure of the item asks for it again. Answers { told }.
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    requireServiceToken(request);
    const { runId } = await params;
    const answer = await markTold(runId);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ told: answer.told });
  } catch (error) {
    return itemsFailed(error, 'Keeping that the person was told');
  }
}
