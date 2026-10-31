import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { reportVoiceKeyCall } from '@/lib/voice-key-health';

export const runtime = 'nodejs';

const part = z.enum(['recognition', 'speech']);
const outcomeSchema = z.union([
  z.object({ part, ok: z.literal(true) }).strict(),
  z.object({ part, ok: z.literal(false), status: z.number().int().min(100).max(599).optional(), rejected: z.boolean().optional() }).strict(),
]);

/**
 * POST /api/voice/providers/:id/health { part, ok: true } | { part, ok: false, status?, rejected? }
 * What the bot server saw when it used a person's voice key for one job, `part` "recognition" or "speech" (#749): it worked, or it failed with the HTTP status the provider
 * answered (`status` left out for a dropped connection or a timeout; `rejected` when the provider refused the key itself).
 * A key out of credit, rejected or (on listening) without its model is Down at once; a 404 on speaking is a voice that bot named, never the key; two other failures in a row of the same job mark it Down
 * (a call that works for the other job does not clear them); a call that works marks it Working again (for the job that failed,
 * when only that job did). Answers with { status: "working" | "down", downSince, downReason }. A server provider, which
 * has no owner and no health, and a key that doesn't exist are "not found".
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const parsed = outcomeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Send { part, ok: true } or { part, ok: false, status?, rejected? }' }, { status: 400 });
    const health = await reportVoiceKeyCall((await params).id, parsed.data.part, parsed.data);
    if (!health) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    return NextResponse.json(health, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'voice-providers' } });
    console.error('[VoiceProviders] Could not record the call:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
