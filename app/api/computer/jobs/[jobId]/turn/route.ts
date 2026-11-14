import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { startTurn } from '@/lib/computer-broker';
import { turnResponse } from '@/lib/computer-sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ input: z.string().min(1).max(200_000) }).strict();

/**
 * POST /api/computer/jobs/:jobId/turn { input } - the runner sends the agent on a running job's computer a message, and gets its events
 * as Server-Sent Events: created, text, tool (name and short label only, never what the tool was given), completed or failed. The job
 * decides the machine and the conversation. 409 when the job is not running under Brick's hands (`not_running`, `person_has_it`,
 * `no_machine`) or the agent is already working on a turn (`busy`, with its id: reconnect to it with GET .../stream instead).
 * The runner going away does not cancel the turn. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const { jobId } = await params;
    const started = await startTurn(jobId, parsed.data.input, request.signal);
    if (started.ok) return turnResponse(started.events, request.signal);
    const status = started.reason === 'not_found' ? 404 : started.reason === 'failed' ? 502 : 409;
    return NextResponse.json({ ok: false, reason: started.reason, ...(started.reason === 'busy' && started.responseId ? { responseId: started.responseId } : {}) }, { status });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not start a turn:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
