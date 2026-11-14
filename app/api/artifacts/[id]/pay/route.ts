import { z } from 'zod';
import { artifactRoute, viewerSchema } from '@/lib/artifact-http';
import { requireMayOpen } from '@/lib/artifact-service';
import { ArtifactError } from '@/lib/artifacts';
import { orderForArtifact, pageTakesPayments, startCheckout } from '@/lib/app-direct/pay';

export const runtime = 'nodejs';

const schema = z.object({ viewer: viewerSchema, order: z.string().trim().min(1).max(100).optional(), start: z.boolean().optional() }).strict();

/**
 * POST /api/artifacts/:id/pay { viewer, start? | order? } - the game's side of a page that takes payments (game #2044). Who may open the
 * artifact may pay on it. With neither: { enabled }. `start: true` starts a checkout for the owner's amount (the viewer sends no amount);
 * `order` asks where an order stands. Auth: ADMIN_API_TOKEN (the game's server), for the person it names.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/pay', 'game', schema, async (body, params) => {
  // The same answer as for an artifact that is not there, for anyone who may not open it
  await requireMayOpen(params.id, body.viewer);
  if (body.order) {
    const view = await orderForArtifact(body.order, params.id);
    if (!view) throw new ArtifactError('not_found', 404, 'No such order.');
    return view;
  }
  if (!body.start) return { enabled: await pageTakesPayments(params.id) };
  const person = body.viewer.person;
  const visitor = person.signedIn ? `game:${person.identifier}` : `game-guest:${person.name ?? ''}:${body.viewer.chat?.ref ?? ''}`;
  const outcome = await startCheckout({ artifactId: params.id, visitor });
  if (outcome.status === 'ok') return { orderId: outcome.orderId, checkoutUrl: outcome.checkoutUrl, amount: outcome.amount, currency: outcome.currency, app: outcome.app };
  if (outcome.status === 'limit') throw new ArtifactError('limit', 429, 'Too many tries for now.');
  throw new ArtifactError('unavailable', 409, 'Payments are unavailable.');
});
