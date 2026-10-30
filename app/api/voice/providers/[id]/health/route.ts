import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { reportVoiceKeyCall } from '@/lib/voice-key-health';

export const runtime = 'nodejs';

const outcomeSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), status: z.number().int().min(100).max(599).optional(), rejected: z.boolean().optional() }).strict(),
]);

/**
 * POST /api/voice/providers/:id/health { ok: true } | { ok: false, status?, rejected? }
 * What the bot server saw when it used a person's voice key (#749): it worked, or it failed with the HTTP status the provider
 * answered (`status` left out for a dropped connection or a timeout; `rejected` when the provider refused the key itself).
 * A key out of credit, rejected or without its model is Down at once; two other failures in a row mark it Down; a call that
 * works marks it Working again. Answers with { status: "working" | "down", downSince, downReason }. A server provider, which
 * has no owner and no health, and a key that doesn't exist are "not found".
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const parsed = outcomeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Send { ok: true } or { ok: false, status?, rejected? }' }, { status: 400 });
    const health = await reportVoiceKeyCall((await params).id, parsed.data);
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
