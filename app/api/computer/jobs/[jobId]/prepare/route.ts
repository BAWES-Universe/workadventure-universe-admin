import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { prepareJob } from '@/lib/computer-broker';

export const runtime = 'nodejs';

const bodySchema = z.object({ relay: z.string().min(1).max(300) }).strict();

/**
 * POST /api/computer/jobs/:jobId/prepare { relay } - the runner readies a running job's computer to ask for a model: Orbit makes a new
 * key (every earlier key of the job ends) and writes it, with the relay's address, onto the machine where its local model address reads
 * them on each call. The key never comes back to the caller. Answers { ok: true, expiresAt } or { ok: false, reason }. Auth: service token only.
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
    const done = await prepareJob(jobId, parsed.data.relay);
    if (done.ok) return NextResponse.json({ ok: true, expiresAt: done.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
    const status = done.reason === 'not_found' ? 404 : done.reason === 'bad_relay' ? 400 : done.reason === 'failed' ? 502 : 409;
    return NextResponse.json({ ok: false, reason: done.reason }, { status });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not prepare a job:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
