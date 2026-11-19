import { z } from 'zod';
import { artifactRoute, viewerSchema } from '@/lib/artifact-http';
import { requireMayOpen } from '@/lib/artifact-service';
import { ArtifactError } from '@/lib/artifacts';
import { buyerKeyOf, checkPurchase, INTENT_ID, orderForArtifact, pageTakesPayments, restorePurchase, startCheckout } from '@/lib/app-direct/pay';
import { findUserByIdentifier } from '@/lib/user-identifier';

export const runtime = 'nodejs';

const intentId = z.string().regex(INTENT_ID);

const schema = z
  .object({
    viewer: viewerSchema,
    order: z.string().trim().min(1).max(100).optional(),
    start: z.boolean().optional(),
    /** The window's own id for this tap (never the page's): the same one again finds the order it made. */
    intentId: intentId.optional(),
    /** What a guest's window keeps for them: only its hash is stored. A signed-in person needs none (their account is the buyer). */
    recoveryCode: z.string().max(200).optional(),
    /** Check payment: where the order made for `intentId` stands. */
    check: z.boolean().optional(),
    /** Restore purchase: this buyer's verified paid order for the page's offer. */
    restore: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/artifacts/:id/pay { viewer, start? | order? | check? | restore?, intentId?, recoveryCode? } - the game's side of a page that
 * takes payments (game #2044). Who may open the artifact may pay on it. Auth: ADMIN_API_TOKEN (the game's server), for the person it names.
 *  - none of them: { enabled }.
 *  - `start: true` (+ `intentId`): a checkout for the owner's amount (the viewer sends no amount). The same `intentId` from the same buyer
 *    gives the SAME order, never another, even from two windows at once. 200 { orderId, checkoutUrl, amount, currency, app, reused }.
 *  - `order`: where an order stands { status, checkoutUrl, testPayment, orderId, pollAfterMs }; `pollAfterMs` is how long to wait before asking again.
 *  - `check: true` + `intentId`: the same, for the order that wish made (found with the buyer, so no one else's). 404 when there is none.
 *  - `restore: true`: { status: paid | checking | none, testPayment, orderId, pollAfterMs } for this buyer's order for the page's offer.
 * The buyer is the signed-in account when the viewer is one; otherwise the guest's `recoveryCode`, kept only as a hash. An `intentId`, a
 * `check` or a `restore` for a guest with no usable code is 400 `buyer_required`.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/pay', 'game', schema, async (body, params) => {
  // The same answer as for an artifact that is not there, for anyone who may not open it
  await requireMayOpen(params.id, body.viewer);
  if (body.order) {
    const view = await orderForArtifact(body.order, params.id);
    if (!view) throw new ArtifactError('not_found', 404, 'No such order.');
    return view;
  }
  const person = body.viewer.person;
  const account = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
  const buyerKey = buyerKeyOf({ accountId: account && !account.isGuest ? account.id : null, recoveryCode: body.recoveryCode });
  if (body.restore) {
    if (!buyerKey) throw new ArtifactError('buyer_required', 400, 'Say who is asking.');
    return restorePurchase({ artifactId: params.id, buyerKey });
  }
  if (body.check) {
    if (!buyerKey || !body.intentId) throw new ArtifactError('buyer_required', 400, 'Say who is asking, and about which purchase.');
    const view = await checkPurchase({ artifactId: params.id, buyerKey, intentId: body.intentId });
    if (!view) throw new ArtifactError('not_found', 404, 'No such order.');
    return view;
  }
  if (!body.start) return { enabled: await pageTakesPayments(params.id) };
  if (body.intentId && !buyerKey) throw new ArtifactError('buyer_required', 400, 'Say who is asking.');
  const visitor = person.signedIn ? `game:${person.identifier}` : `game-guest:${person.name ?? ''}:${body.viewer.chat?.ref ?? ''}`;
  const outcome = await startCheckout({ artifactId: params.id, visitor, intentId: body.intentId, buyerKey: body.intentId ? buyerKey : null });
  if (outcome.status === 'ok') return { orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app, reused: outcome.reused };
  if (outcome.status === 'limit') throw new ArtifactError('limit', 429, 'Too many tries for now.');
  throw new ArtifactError('unavailable', 409, 'Payments are unavailable.');
});
