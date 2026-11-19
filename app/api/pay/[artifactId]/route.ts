import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buyerKeyOf, checkPurchase, INTENT_ID, isOpenByLink, orderForArtifact, pageTakesPayments, restorePurchase, startCheckout } from '@/lib/app-direct/pay';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed } from '@/lib/me-route';

export const runtime = 'nodejs';

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Who is asking, as far as counting tries goes: the address only (hashed again before it is kept). A browser name is something a visitor
 * can change on every try, so it is never part of the count. This count is a soft limit; the hard bound on a page and on an owner is the
 * per-page and per-owner limits in startCheckout, which no header can get around.
 */
function visitorOf(request: NextRequest): string {
  const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return `web:${address}`;
}

/**
 * GET /api/pay/:artifactId - does this page take payments right now? { enabled }. For a page anyone with the link may open.
 * GET /api/pay/:artifactId?order=ID - where that order stands: { status: checking | paid | not_paid | cant_confirm, checkoutUrl, testPayment, orderId,
 * pollAfterMs }; `pollAfterMs` is how long to wait before asking again (3 seconds at first, slowing to 15).
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

/** Anything else in the body is ignored: the amount, the currency and the service are the owner's, never the page's or the visitor's. */
const bodySchema = z.object({
  /** The host's id for this tap: the same one again from the same buyer gives the same order. */
  intentId: z.string().regex(INTENT_ID).optional(),
  /** What this browser keeps for a guest buyer: only its hash is stored. A signed-in Orbit session needs none. */
  recoveryCode: z.string().max(200).optional(),
  check: z.boolean().optional(),
  restore: z.boolean().optional(),
});

/**
 * POST /api/pay/:artifactId - start a checkout for the amount the owner set for this page, or get back to a purchase. The body carries no
 * amount on purpose: the amount, the currency and the service are the owner's, never the page's or the visitor's.
 *  - `{}` or `{ intentId, recoveryCode }`: start. The same `intentId` from the same buyer gives the SAME order (even from two tabs at once).
 *    200 { orderId, checkoutUrl, amount, currency, app, reused } · 404 · 409 unavailable (the owner stopped it or the app stopped working) · 429 too many.
 *  - `{ check: true, intentId, recoveryCode }`: Check payment, where the order that wish made stands { status, checkoutUrl, testPayment, orderId, pollAfterMs } · 404.
 *  - `{ restore: true, recoveryCode }`: Restore purchase, { status: paid | checking | none, testPayment, orderId, pollAfterMs } for this buyer.
 * The buyer is the signed-in Orbit account when there is one, otherwise the guest's recovery code, kept only as a hash. A wish, a check or a
 * restore with neither is 400 `buyer_required`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  if (!meOriginAllowed(request) || !(await isOpenByLink(artifactId))) return respond({ error: 'Not found' }, 404);
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw && typeof raw === 'object' ? raw : {});
  if (!parsed.success) return respond({ error: 'Invalid request data', code: 'bad_request' }, 400);
  const body = parsed.data;
  const session = body.restore || body.check || body.intentId ? await getSessionUser(request).catch(() => null) : null;
  const buyerKey = buyerKeyOf({ accountId: session?.id ?? null, recoveryCode: body.recoveryCode });
  if (body.restore) return buyerKey ? respond(await restorePurchase({ artifactId, buyerKey })) : respond({ error: 'Say who is asking', code: 'buyer_required' }, 400);
  if (body.check) {
    if (!buyerKey || !body.intentId) return respond({ error: 'Say who is asking, and about which purchase', code: 'buyer_required' }, 400);
    const view = await checkPurchase({ artifactId, buyerKey, intentId: body.intentId });
    return view ? respond(view) : respond({ error: 'Not found' }, 404);
  }
  if (body.intentId && !buyerKey) return respond({ error: 'Say who is asking', code: 'buyer_required' }, 400);
  const outcome = await startCheckout({ artifactId, visitor: visitorOf(request), intentId: body.intentId, buyerKey: body.intentId ? buyerKey : null });
  if (outcome.status === 'ok') return respond({ orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app, reused: outcome.reused });
  if (outcome.status === 'limit') return respond({ error: 'Too many tries for now', code: 'limit' }, 429);
  return respond({ error: 'Payments are unavailable', code: 'unavailable' }, 409);
}
