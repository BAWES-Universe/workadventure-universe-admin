import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { refused, superAdmin } from '@/lib/budget/auth';
import { requestTopUpLink } from '@/lib/budget/agent37-funds';

export const runtime = 'nodejs';

/**
 * POST /api/admin/budget/funds { company: 'agent37', amountUsd } (super admins only): asks the company for a payment link and gives it back. The page opens it
 * and then checks the balance again until it changes. Only Agent37 offers this; for the others the page links to the company's own billing page.
 */
export async function POST(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const body = (await request.json().catch(() => null)) as { company?: unknown; amountUsd?: unknown } | null;
  if (body?.company !== 'agent37') return NextResponse.json({ error: 'Orbit can only ask Agent37 for a payment link. For the others, use the company’s billing page.' }, { status: 400 });
  const key = process.env.AGENT37_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: 'Agent37 is not set up here, so there is no way to ask it for a payment link.' }, { status: 409 });
  const amount = typeof body.amountUsd === 'number' ? body.amountUsd : typeof body.amountUsd === 'string' ? Number(body.amountUsd.replace(/[,\s$]/g, '')) : NaN;
  try {
    const result = await requestTopUpLink(key, amount);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ url: result.url, amountUsd: result.amountUsd }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not ask for a payment link:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
