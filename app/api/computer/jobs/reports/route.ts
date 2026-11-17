import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toldSchema = z.object({
  jobId: z.string().min(1).max(64),
  kind: z.enum(['done', 'failed', 'needs', 'unanswered', 'month', 'rule']),
  seq: z.number().int().min(0).nullable().optional(),
});

function guard(request: NextRequest): NextResponse | null {
  try {
    requireServiceToken(request);
    return null;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

/**
 * GET /api/computer/jobs/reports - what Brick is to tell people about their computer jobs now (the report back): endings and waits for the person
 * that were not told yet, oldest first, each with the facts the job's own record proves. The bot server says each in the person's chat with the Brick
 * and then confirms it below. Auth: service token only.
 */
export async function GET(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ reports: await reportsToTell(50) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not list what to tell:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST /api/computer/jobs/reports { jobId, kind, seq? } - that report was said (or can never be said): it is not offered again. Safe to say twice. */
export async function POST(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const parsed = toldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const kept = await keepReportTold(parsed.data.jobId, parsed.data.kind, parsed.data.seq);
    return kept ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Job not found' }, { status: 404 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not keep what was told:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
