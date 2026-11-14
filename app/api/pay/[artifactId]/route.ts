import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isOpenByLink, orderForArtifact, pageTakesPayments, startCheckout } from '@/lib/app-direct/pay';
import { meOriginAllowed } from '@/lib/me-route';

export const runtime = 'nodejs';

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Who is asking, as far as counting tries goes: an address and a browser, hashed again before they are kept. */
function visitorOf(request: NextRequest): string {
  const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return `web:${address}:${createHash('sha256').update(request.headers.get('user-agent') ?? '').digest('hex').slice(0, 16)}`;
}

/**
 * GET /api/pay/:artifactId - does this page take payments right now? { enabled }. For a page anyone with the link may open.
 * GET /api/pay/:artifactId?order=ID - where that order stands: { status: checking | paid | not_paid | cant_confirm, checkoutUrl, testPayment }.
 * Asking never trusts the page: Orbit asks the service itself (game #2044).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  if (!meOriginAllowed(request) || !(await isOpenByLink(artifactId))) return respond({ error: 'Not found' }, 404);
  const order = request.nextUrl.searchParams.get('order');
  if (!order) return respond({ enabled: await pageTakesPayments(artifactId) });
  const view = await orderForArtifact(order, artifactId);
  return view ? respond(view) : respond({ error: 'Not found' }, 404);
}

/**
 * POST /api/pay/:artifactId - start a checkout for the amount the owner set for this page. The body is empty on purpose: the amount, the
 * currency and the service are the owner's, never the page's or the visitor's. 200 { orderId, checkoutUrl, amount, currency, app } · 404 · 409
 * unavailable (the owner stopped it or the app stopped working) · 429 too many.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  if (!meOriginAllowed(request) || !(await isOpenByLink(artifactId))) return respond({ error: 'Not found' }, 404);
  const outcome = await startCheckout({ artifactId, visitor: visitorOf(request) });
  if (outcome.status === 'ok') return respond({ orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app });
  if (outcome.status === 'limit') return respond({ error: 'Too many tries for now', code: 'limit' }, 429);
  return respond({ error: 'Payments are unavailable', code: 'unavailable' }, 409);
}
