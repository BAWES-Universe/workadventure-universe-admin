import { NextResponse } from 'next/server';
import { verifyOrder } from '@/lib/app-direct/pay';

export const runtime = 'nodejs';

/**
 * The payment service tells us an order moved (game #2044). Nothing in the notice is believed: it only makes Orbit ask the service itself
 * about this one order, which is rate-limited per order, so this can be called by anyone, any number of times, and learns them nothing.
 * Always 200, so the service does not keep retrying an order we have already settled.
 */
async function notice(params: Promise<{ orderId: string }>) {
  const { orderId } = await params;
  try {
    if (/^[0-9a-f-]{36}$/i.test(orderId)) await verifyOrder(orderId);
  } catch (error) {
    console.error('[PagePayments] A notice could not be checked:', error instanceof Error ? error.message : 'unknown');
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  return notice(params);
}

export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  return notice(params);
}
