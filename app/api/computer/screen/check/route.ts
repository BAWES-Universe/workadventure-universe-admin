import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { checkScreen } from '@/lib/computer-screen';

export const runtime = 'nodejs';

/**
 * POST /api/computer/screen/check   { ticket }
 * Asked by the bot server only (service token). A socket is open: may it go on? A no closes it. Never wakes a machine.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const body = (await request.json().catch(() => null)) as { ticket?: unknown } | null;
    return NextResponse.json(await checkScreen(body?.ticket), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] The screen call failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
