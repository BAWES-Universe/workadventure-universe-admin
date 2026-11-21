import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { pagePaymentLoad, sweepPageOrders } from '@/lib/app-direct/pay';

export const runtime = 'nodejs';

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const unauthorized = (error: unknown) => error instanceof Error && error.message === 'Unauthorized: Invalid service token';

/**
 * POST /api/app-pay/sweep
 * Asked by the bot server now and then (and by the Instant sweep, which runs it too): orders of pages that nobody is watching any more are
 * asked about at the payment service, and orders whose start never finished are ended when their open time is up. Safe to run twice at
 * once. 200 { sweep: { looked, ended, moved }, load }. Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const sweep = await sweepPageOrders();
    const load = await pagePaymentLoad();
    // The alert is on a STALLED look (a scheduled look overdue, an order the schedule never reached, looks that are made and not read), never on an order's age: an order waiting its month is only a count
    if (load.unconfirmed.stalled.length > 0) {
      Sentry.captureMessage(`Page payment looks are stalled: ${load.unconfirmed.stalled.join(', ')}`, { level: 'warning', tags: { area: 'page-payments' }, extra: { unconfirmed: load.unconfirmed } });
    }
    return respond({ sweep, load });
  } catch (error) {
    if (unauthorized(error)) return respond({ error: 'Unauthorized' }, 401);
    Sentry.captureException(error, { tags: { area: 'page-payments' } });
    console.error('[PagePayments] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return respond({ error: 'Internal server error' }, 500);
  }
}

/**
 * GET /api/app-pay/sweep - how loaded page payments are, for measuring on dev: open orders and the oldest, orders still being started and the
 * oldest, looks at the service this hour and how many were left for later, and how long orders took to be found paid. Reads only.
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    return respond({ load: await pagePaymentLoad() });
  } catch (error) {
    if (unauthorized(error)) return respond({ error: 'Unauthorized' }, 401);
    Sentry.captureException(error, { tags: { area: 'page-payments' } });
    console.error('[PagePayments] Load check failed:', error instanceof Error ? error.message : 'unknown');
    return respond({ error: 'Internal server error' }, 500);
  }
}
