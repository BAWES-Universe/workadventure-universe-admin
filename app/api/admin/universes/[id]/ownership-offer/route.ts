import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, failed, universeContext } from '@/lib/universe-route';
import { OfferError, startOffer, takeBackOffer } from '@/lib/ownership-offer';

type Params = { params: Promise<{ id: string }> };

const offerSchema = z.object({
  /** The member the whole universe is offered to. */
  toUserId: z.string().min(1).max(100),
  /** The universe's name, typed to confirm. */
  universeName: z.string().max(200),
});

function refused(error: unknown, what: string) {
  if (error instanceof OfferError) return NextResponse.json({ error: error.message }, { status: error.status });
  return failed(error, what);
}

// POST /api/admin/universes/[id]/ownership-offer - Offer the whole universe to a member (the owner, or a super admin).
// Nothing changes until they accept.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const parsed = offerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest('Say who gets the universe, and type its name');

    const offer = await startOffer({
      universe: context.universe,
      by: context.user,
      toUserId: parsed.data.toUserId,
      typedName: parsed.data.universeName,
    });
    return NextResponse.json({ offer: { id: offer.id, toUserId: offer.toUserId, createdAt: offer.createdAt } }, { status: 201 });
  } catch (error) {
    return refused(error, 'offer the universe');
  }
}

// DELETE /api/admin/universes/[id]/ownership-offer - Take the waiting offer back
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    await takeBackOffer({ universe: context.universe, by: context.user });
    return NextResponse.json({ success: true });
  } catch (error) {
    return refused(error, 'take back the offer');
  }
}
