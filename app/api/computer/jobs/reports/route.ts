import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { OPT_IN_KINDS, keepReportTold, reportsToTell } from '@/lib/computer-report';
import { UNDELIVERABLE_WHY } from '@/lib/computer-values';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toldSchema = z.object({
  jobId: z.string().min(1).max(64),
  kind: z.enum(['done', 'failed', 'needs', 'unanswered', 'month', 'rule', 'late']),
  seq: z.number().int().min(0).nullable().optional(),
  // Whether it reached the person (the default, as it always was) or can never be delivered (and why): only the first is "told"
  outcome: z.enum(['delivered', 'undeliverable']).optional(),
  why: z.enum(UNDELIVERABLE_WHY).optional(),
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
 * and then confirms it below. Auth: service token only. `?accepts=late` (comma list) opts in to the follow-up kinds an older reader does not know.
 */
export async function GET(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    // A reader that understands the follow-up says so (`?accepts=late`); one that does not (an older game) is never sent the kind
    const accepts = (request.nextUrl.searchParams.get('accepts') ?? '').split(',').map((word) => word.trim()).filter((word) => (OPT_IN_KINDS as readonly string[]).includes(word));
    return NextResponse.json({ reports: await reportsToTell(50, new Date(), { accepts }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not list what to tell:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/computer/jobs/reports { jobId, kind, seq?, outcome?, why? } - what became of a report. `delivered` (the default): it reached the person, so it is told.
 * `undeliverable` with a reason: it can never reach them (no chat, not allowed, the conversation it began in is gone, the chat refused it): it is not offered again
 * and is NOT recorded as told; the result stays with the person in Files. A report not confirmed is still to be tried. Safe to say twice.
 */
export async function POST(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const parsed = toldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    if (parsed.data.outcome === 'undeliverable' && !parsed.data.why) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const outcome = parsed.data.outcome === 'undeliverable' && parsed.data.why ? ({ delivered: false, why: parsed.data.why } as const) : ({ delivered: true } as const);
    const kept = await keepReportTold(parsed.data.jobId, parsed.data.kind, parsed.data.seq, outcome);
    return kept ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Job not found' }, { status: 404 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not keep what was told:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
