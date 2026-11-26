import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { askKeysOf, buyerKeysOf, checkPurchase, INTENT_ID, isOpenByLink, orderForArtifact, pageTakesPayments, restorePurchase, startCheckout } from '@/lib/app-direct/pay';
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
  // Who is signed in now: an order made under an account is told only to that account (see `orderForArtifact`)
  const session = await getSessionUser(request).catch(() => null);
  const view = await orderForArtifact(order, artifactId, {}, { accountId: session?.id ?? null });
  return view ? respond(view) : respond({ error: 'Not found' }, 404);
}

/** Anything else in the body is ignored: the amount, the currency and the service are the owner's, never the page's or the visitor's. */
const bodySchema = z.object({
  /** The host's id for this tap: the same one again from the same buyer gives the same order. */
  intentId: z.string().regex(INTENT_ID).optional(),
  /** What this browser keeps for a guest buyer: only its hash is stored. A signed-in Orbit session needs none. */
  recoveryCode: z.string().max(200).optional(),
  /** The code of a receipt link this browser opened: used only to find the purchases made under it (Restore, Check payment), never to make a new one. */
  receiptCode: z.string().max(200).optional(),
  check: z.boolean().optional(),
  restore: z.boolean().optional(),
});

/**
 * POST /api/pay/:artifactId - start a checkout for the amount the owner set for this page, or get back to a purchase. The body carries no
 * amount on purpose: the amount, the currency and the service are the owner's, never the page's or the visitor's.
 *  - `{}` or `{ intentId, recoveryCode }`: start. The same `intentId` from the same buyer gives the SAME order (even from two tabs at once).
 *    200 { orderId, checkoutUrl, amount, currency, app, reused, buyer } · 404 · 409 unavailable (the owner stopped it or the app stopped working; with `unsure: true` an order may have been made, so ask with Check payment) · 409 not_published (the owner set these terms on a version newer than the one the link shows; nothing was made) · 429 too many.
 *  - `{ check: true, intentId, recoveryCode }`: Check payment, where the order that wish made stands { status, checkoutUrl, testPayment, orderId, pollAfterMs, buyer } · 404.
 *  - `{ restore: true, recoveryCode }`: Restore purchase, { status: paid | checking | none, testPayment, orderId, pollAfterMs, paidAt, checkoutUrl, via, buyer } for this buyer.
 *    `via` is `own` (found by their account or recovery code) or `receipt` (found only through a `receiptCode`, which finds and never starts).
 *    An open order whose start never finished is carried on first, for its own buyer only.
 * `buyer` is `account` or `guest`: only a guest has a receipt link to keep.
 * The buyer is the signed-in Orbit account when there is one, otherwise the guest's recovery code, kept only as a hash. A wish, a check or a
 * restore with neither is 400 `buyer_required`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  if (!meOriginAllowed(request) || !(await isOpenByLink(artifactId))) return respond({ error: 'Not found' }, 404);
  // No body at all is a plain start (as before); anything that is there must be a JSON object. A cut-off or non-object body is never turned into a
  // start: it could be a Check payment that was truncated on the way, and a start makes a checkout at the service
  const text = await request.text().catch(() => null);
  let raw: unknown = {};
  if (text === null) return respond({ error: 'Invalid request data', code: 'bad_request' }, 400);
  if (text !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return respond({ error: 'Invalid request data', code: 'bad_request' }, 400);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return respond({ error: 'Invalid request data', code: 'bad_request' }, 400);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return respond({ error: 'Invalid request data', code: 'bad_request' }, 400);
  const body = parsed.data;
  const session = body.restore || body.check || body.intentId ? await getSessionUser(request).catch(() => null) : null;
  // The account when signed in, and the recovery code when this browser holds one: a guest who paid and then signed in is looked for under both
  const buyerKeys = buyerKeysOf({ accountId: session?.id ?? null, recoveryCode: body.recoveryCode });
  const buyerKey = buyerKeys[0] ?? null;
  // Who the buyer is, for the host: a guest keeps a receipt link (which holds the recovery code); an account has nothing to keep
  const buyer = session ? 'account' : 'guest';
  if (body.restore) return buyerKey ? respond({ ...(await restorePurchase({ artifactId, buyerKeys: askKeysOf(buyerKeys, body.receiptCode), ownKeys: buyerKeys })), buyer }) : respond({ error: 'Say who is asking', code: 'buyer_required' }, 400);
  if (body.check) {
    if (!buyerKey || !body.intentId) return respond({ error: 'Say who is asking, and about which purchase', code: 'buyer_required' }, 400);
    const view = await checkPurchase({ artifactId, buyerKeys: askKeysOf(buyerKeys, body.receiptCode), ownKeys: buyerKeys, intentId: body.intentId });
    return view ? respond({ ...view, buyer }) : respond({ error: 'Not found' }, 404);
  }
  if (body.intentId && !buyerKey) return respond({ error: 'Say who is asking', code: 'buyer_required' }, 400);
  const outcome = await startCheckout({ artifactId, visitor: visitorOf(request), intentId: body.intentId, buyerKey: body.intentId ? buyerKey : null, alsoBuyerKeys: buyerKeys.slice(1) });
  if (outcome.status === 'ok') return respond({ orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app, reused: outcome.reused, buyer });
  if (outcome.status === 'limit') return respond({ error: 'Too many tries for now', code: 'limit' }, 429);
  // The link shows an older published version than the one the owner set these terms on: a definite answer, nothing was made. The words
  // never say a newer version exists (game #2115): only the owner is told why (their Brick, when they set the terms)
  if (outcome.status === 'not_published') return respond({ error: 'This page isn’t taking payments right now. Try again later', code: 'not_published' }, 409);
  return respond({ error: 'Payments are unavailable', code: 'unavailable', ...(outcome.unsure ? { unsure: true } : {}) }, 409);
}
