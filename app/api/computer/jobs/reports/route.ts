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
  kind: z.enum(['done', 'failed', 'needs', 'unanswered', 'month', 'rule', 'late', 'paused', 'carried_on', 'can_carry_on', 'back_in_line']),
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
 * and then confirms it below. Auth: service token only. `?accepts=late,paused,carried_on,can_carry_on,back_in_line` (comma list; `back_in_line`: GPT round 6, finding 5) opts in to the kinds an older reader does not know (the follow-up, and what is said about a job the person's month or a limit paused).
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
    // A follow-up is confirmed by its number: one that names none could mark a batch offered after the one the reader was given
    if (parsed.data.kind === 'late' && typeof parsed.data.seq !== 'number') return NextResponse.json({ error: 'A confirmation of a follow-up names its number (seq)' }, { status: 400 });
    // So is what is said about a job the month or a limit paused (paused, carried_on, can_carry_on): each is its own numbered message
    if (['paused', 'carried_on', 'can_carry_on', 'back_in_line'].includes(parsed.data.kind) && typeof parsed.data.seq !== 'number') return NextResponse.json({ error: 'A confirmation about a paused job names its number (seq)' }, { status: 400 });
    const outcome = parsed.data.outcome === 'undeliverable' && parsed.data.why ? ({ delivered: false, why: parsed.data.why } as const) : ({ delivered: true } as const);
    const kept = await keepReportTold(parsed.data.jobId, parsed.data.kind, parsed.data.seq, outcome);
    return kept ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Job not found' }, { status: 404 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not keep what was told:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
