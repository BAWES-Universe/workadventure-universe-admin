import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { verifyJobToken } from '@/lib/computer-token';

export const runtime = 'nodejs';

const bodySchema = z.object({ token: z.string().min(1).max(200) }).strict();

/**
 * POST /api/computer/llm/identify { token } - which job and Brick a computer's key belongs to, read from Orbit's records, so the bot
 * server knows whose AI route to look up before it asks for room for a call. Nothing is reserved or changed. Answers
 * { ok: true, jobId, botId } or { ok: false, reason: 'refused' } (a key that is not ours, ended, or from before a take-over: one
 * answer for all). Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const verified = await verifyJobToken(parsed.data.token, 'model');
    const body = verified.ok ? { ok: true as const, jobId: verified.jobId, botId: verified.botId } : { ok: false as const, reason: 'refused' as const };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not identify a job key:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
