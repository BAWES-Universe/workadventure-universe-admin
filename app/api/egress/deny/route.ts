import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { deniedProviderNames } from '@/lib/egress/deny-list';

export const runtime = 'nodejs';

/**
 * GET /api/egress/deny - the names of the Universe AI providers, for the egress gateway to refuse (it asks every few minutes, and keeps the
 * last answer when this cannot be reached). Auth: the gateway's own secret as a bearer token; no other caller has it. Answers
 * { names: string[] }, never a key or an address of ours.
 */
export async function GET(request: NextRequest) {
  const secret = (process.env.EGRESS_GATEWAY_SECRET ?? '').trim();
  const given = Buffer.from((request.headers.get('authorization') ?? '').replace(/^Bearer /i, ''));
  const wanted = Buffer.from(secret);
  if (!secret || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ names: await deniedProviderNames() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'egress' } });
    console.error('[Egress] Could not list the provider names:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
