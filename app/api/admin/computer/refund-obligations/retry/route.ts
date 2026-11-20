import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { retryRefundObligation } from '@/lib/computer-refunds';

export const runtime = 'nodejs';

const bodySchema = z.object({ holdKey: z.string().min(1).max(255) }).strict();

/**
 * POST /api/admin/computer/refund-obligations/retry { holdKey } (super admins only)
 * Asks the books again now for one owed refund (not waiting for the next try). It is the same refund: the same amount under the same key, so asking twice, or
 * after the books already made it, answers with what they gave and never gives a second one. Answers { found, result: 'acknowledged' | 'owed' | 'none' }.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const answer = await retryRefundObligation(parsed.data.holdKey);
    return NextResponse.json(answer, { status: answer.found ? 200 : 404, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
