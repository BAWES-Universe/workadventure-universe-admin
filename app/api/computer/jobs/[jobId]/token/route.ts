import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { z } from 'zod';
import { mintJobToken } from '@/lib/computer-token';
import { refusalBody } from '@/lib/computer-owner';

export const runtime = 'nodejs';

const bodySchema = z.object({ epoch: z.number().int().min(0).max(2_000_000_000).nullable().optional() }).strict();

/**
 * POST /api/computer/jobs/:jobId/token - the bot server's runner asks for the key a job's computer will hold (build handoff v2, 5).
 * Answers { token, expiresAt } once: Orbit keeps only the digest. Only a job that holds the machine has one; a job that is over,
 * queued or not there is `not_running`/`not_found`. The key is for model calls and nothing more, ends with the job, ends when the
 * person takes over, and lasts 15 minutes unless the job's lease renews it. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { jobId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const minted = await mintJobToken(jobId, 'model', new Date(), undefined, { epoch: parsed.data.epoch ?? null });
    if (!minted.ok) return minted.reason === 'superseded' ? NextResponse.json(refusalBody('superseded'), { status: 409 }) : NextResponse.json({ error: minted.reason }, { status: minted.reason === 'not_found' ? 404 : 409 });
    return NextResponse.json({ token: minted.token, expiresAt: minted.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not make a job key:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
