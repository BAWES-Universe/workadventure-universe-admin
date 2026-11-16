import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { paidBy, payerOf } from '@/lib/paid-by';

export const runtime = 'nodejs';

/**
 * GET /api/bots/:id/paid-by?userId=&isGuest= - who pays for this Brick's paid work, in words, for the person it is talking to: the
 * small label on a costly task's status line ("Paid by you", "Paid by Universe"). Read only. Answers
 * { payer: 'you' | 'universe' | 'sponsor', payerName, label }. Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(userId, request.nextUrl.searchParams.get('isGuest') === 'true');
    return NextResponse.json(paidBy(await payerOf(id), person.personId));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'paid-by' } });
    console.error('[PaidBy] Could not read the payer:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
