import { NextResponse } from 'next/server';
import { isWaiting, verifyOrder } from '@/lib/app-direct/pay';
import { getBrickLimits } from '@/lib/bot-limits';

export const runtime = 'nodejs';

/**
 * The payment service tells us an order moved (game #2044). Nothing in the notice is believed: it only makes Orbit ask the service itself
 * about this one order, which is rate-limited per order, so this can be called by anyone, any number of times, and learns them nothing.
 * 200 once the service has been asked, so it does not keep retrying an order we have already looked at. When the look had to wait (the order
 * was asked about a moment ago, or the hour's budget is spent) the answer is 429 with when to come back, so the service's own retry makes the
 * look that nobody else may: a buyer who has closed the page cannot be what finishes the order. The same goes for an order whose start is not
 * finished, a service answer that names no state, and a failure of our own (503): none of them says "handled".
 */
async function notice(params: Promise<{ orderId: string }>) {
  const { orderId } = await params;
  try {
    if (/^[0-9a-f-]{36}$/i.test(orderId)) {
      const view = await verifyOrder(orderId);
      if (view && isWaiting(view)) {
        const { paymentCheckSeconds } = await getBrickLimits();
        return NextResponse.json({ ok: false, retry: true }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, paymentCheckSeconds)) } });
      }
    }
  } catch (error) {
    console.error('[PagePayments] A notice could not be checked:', error instanceof Error ? error.message : 'unknown');
    // Our own failure (a database error, say): the service is asked to come back, never told it was handled
    return NextResponse.json({ ok: false, retry: true }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  return notice(params);
}

export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  return notice(params);
}
