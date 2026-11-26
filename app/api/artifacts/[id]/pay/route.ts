import { z } from 'zod';
import { artifactRoute, viewerSchema } from '@/lib/artifact-http';
import { requireMayOpen } from '@/lib/artifact-service';
import { ArtifactError } from '@/lib/artifacts';
import { askKeysOf, buyerKeysOf, checkPurchase, INTENT_ID, orderForArtifact, pageTakesPayments, restorePurchase, startCheckout } from '@/lib/app-direct/pay';
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
    receiptCode: z.string().max(200).optional(),
    /** Check payment: where the order made for `intentId` stands. */
    check: z.boolean().optional(),
    /** Restore purchase: this buyer's verified paid order for the page's offer. */
    restore: z.boolean().optional(),
    /** The version the window has open: terms set on a newer one are never charged on it (the owner may have published since it opened). */
    shownVersion: z.number().int().positive().optional(),
  })
  .strict();

/**
 * POST /api/artifacts/:id/pay { viewer, start? | order? | check? | restore?, intentId?, recoveryCode? } - the game's side of a page that
 * takes payments (game #2044). Who may open the artifact may pay on it. Auth: ADMIN_API_TOKEN (the game's server), for the person it names.
 *  - none of them: { enabled }.
 *  - `start: true` (+ `intentId`): a checkout for the owner's amount (the viewer sends no amount). The same `intentId` from the same buyer
 *    gives the SAME order, never another, even from two windows at once. 200 { orderId, checkoutUrl, amount, currency, app, reused, buyer }.
 *    409 `not_published` when the viewer is shown an older published version than the one the owner set the terms on: nothing was made.
 *    409 `page_changed` when `shownVersion` (the version the window has open) is older than the one the terms were set on: nothing was made.
 *  - `order`: where an order stands { status, checkoutUrl, testPayment, orderId, pollAfterMs, buyer }; `pollAfterMs` is how long to wait before asking again.
 *  - `check: true` + `intentId`: the same, for the order that wish made (found with the buyer, so no one else's). 404 when there is none.
 *  - `restore: true`: { status: paid | checking | none, testPayment, orderId, pollAfterMs, paidAt, checkoutUrl, via, buyer } for this buyer's order for the page's offer.
 *    `via` is `own` (their account or recovery code) or `receipt` (only a `receiptCode` found it; it finds and never starts a payment). An open order
 *    whose start never finished is carried on first, for its own buyer only.
 * The buyer is the signed-in account when the viewer is one; otherwise the guest's `recoveryCode`, kept only as a hash. An `intentId`, a
 * `check` or a `restore` for a guest with no usable code is 400 `buyer_required`.
 *
 * `buyer` is `'account' | 'guest'` and says who Orbit ACTUALLY used, so the window never has to guess from its own sign-in: `'account'` only
 * when the viewer's identifier resolves to a real (not guest) Orbit account, which is what the purchase is bound to and comes back under on
 * any device; `'guest'` for everyone else, including a signed-in person whose Orbit account is a guest account, who has only the recovery code.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/pay', 'game', schema, async (body, params) => {
  // The same answer as for an artifact that is not there, for anyone who may not open it; and which version this viewer is shown
  const { seesLatest } = await requireMayOpen(params.id, body.viewer);
  const person = body.viewer.person;
  const account = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
  // Who Orbit uses as the buyer, told with every answer that concerns one: only a real account (never a guest account) is the account
  const accountId = account && !account.isGuest ? account.id : null;
  const buyer: 'account' | 'guest' = accountId ? 'account' : 'guest';
  if (body.order) {
    const view = await orderForArtifact(body.order, params.id, {}, { accountId });
    if (!view) throw new ArtifactError('not_found', 404, 'No such order.');
    return { ...view, buyer };
  }
  // The account when there is one, and the guest's recovery code when the window holds one: a guest who paid and then signed in still has
  // the code, which proves their earlier orders are theirs, so everything is looked for under both
  const [buyerKey, ...alsoBuyerKeys] = buyerKeysOf({ accountId, recoveryCode: body.recoveryCode });
  const buyerKeys = buyerKey ? [buyerKey, ...alsoBuyerKeys] : [];
  if (body.restore) {
    if (!buyerKey) throw new ArtifactError('buyer_required', 400, 'Say who is asking.');
    return { ...(await restorePurchase({ artifactId: params.id, buyerKeys: askKeysOf(buyerKeys, body.receiptCode), ownKeys: buyerKeys })), buyer };
  }
  if (body.check) {
    if (!buyerKey || !body.intentId) throw new ArtifactError('buyer_required', 400, 'Say who is asking, and about which purchase.');
    const view = await checkPurchase({ artifactId: params.id, buyerKeys: askKeysOf(buyerKeys, body.receiptCode), ownKeys: buyerKeys, intentId: body.intentId });
    if (!view) throw new ArtifactError('not_found', 404, 'No such order.');
    return { ...view, buyer };
  }
  if (!body.start) return { enabled: await pageTakesPayments(params.id) };
  if (body.intentId && !buyerKey) throw new ArtifactError('buyer_required', 400, 'Say who is asking.');
  const visitor = person.signedIn ? `game:${person.identifier}` : `game-guest:${person.name ?? ''}:${body.viewer.chat?.ref ?? ''}`;
  const outcome = await startCheckout({ artifactId: params.id, visitor, intentId: body.intentId, buyerKey: body.intentId ? buyerKey : null, alsoBuyerKeys, seesLatest, shownVersion: body.shownVersion });
  if (outcome.status === 'ok') return { orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app, reused: outcome.reused, buyer };
  if (outcome.status === 'limit') throw new ArtifactError('limit', 429, 'Too many tries for now.');
  // This viewer is shown an older published version than the one the owner set these terms on: a definite answer, nothing was made
  if (outcome.status === 'not_published') throw new ArtifactError('not_published', 409, 'This page isn’t taking payments right now. Try again later.');
  // The window has an older version open than the one these terms were set on: nothing was made, and opening it again shows the terms
  if (outcome.status === 'page_changed') throw new ArtifactError('page_changed', 409, 'This page was updated. Open it again to see the latest version before you pay.');
  throw new ArtifactError('unavailable', 409, 'Payments are unavailable.', outcome.unsure ? { unsure: true } : undefined);
});
