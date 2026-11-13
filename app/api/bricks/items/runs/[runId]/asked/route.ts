import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { markAsked } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/items/runs/:runId/asked
 * The bot server asked the person the goal's one question (the run's report said `askPerson`, game #2002): close it, keep going, or change it.
 * Call it only once the question went out: one that failed is not marked, so the next run that asks the same question is told to ask it again.
 * Answers { asked }. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    requireServiceToken(request);
    const { runId } = await params;
    const answer = await markAsked(runId);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ asked: answer.asked });
  } catch (error) {
    return itemsFailed(error, 'Keeping that the person was asked');
  }
}
