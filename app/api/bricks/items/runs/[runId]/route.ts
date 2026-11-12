import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { checkRun, finishRun, runReportSchema } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * GET /api/bricks/items/runs/:runId
 * May this run take its next step? Asked before every step that reaches outside Universe, not once per run. The answer is no
 * from the moment the item is paused, finished, deleted or changed, or its Brick is switched off or deleted.
 * Takes ?attempt=N (the try it holds), and the answer is no (stale) for an older try after the run was handed out again, and no (expired) once its lease has passed.
 * Answers { ok: true } or { ok: false, reason }.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    requireServiceToken(request);
    const { runId } = await params;
    const attempt = Number(new URL(request.url).searchParams.get('attempt'));
    if (!Number.isInteger(attempt) || attempt < 1) return NextResponse.json({ error: 'attempt is the try the bot server holds' }, { status: 400 });
    const answer = await checkRun(runId, attempt);
    return NextResponse.json(answer, { status: !answer.ok && answer.reason === 'not_found' ? 404 : 200 });
  } catch (error) {
    return itemsFailed(error, 'Checking a run');
  }
}

/**
 * POST /api/bricks/items/runs/:runId
 *   { attempt, state: done | failed, outcome?: quiet | spoke | waiting, result?, error?, progress?: { statusLine?, steps?, waitingFor? }, reached? }
 * How the run went. It is recorded as reported, failed ones too; what it means for the item is applied only while the item
 * is still as it was when the run was claimed. Answers { item, applied, failuresInRow }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    requireServiceToken(request);
    const { runId } = await params;
    const parsed = runReportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await finishRun(runId, parsed.data);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ item: answer.item, applied: answer.applied, failuresInRow: answer.failuresInRow });
  } catch (error) {
    return itemsFailed(error, 'Reporting a run');
  }
}
