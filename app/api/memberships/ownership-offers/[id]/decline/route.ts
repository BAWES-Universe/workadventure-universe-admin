import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { OfferError, declineOffer } from '@/lib/ownership-offer';

// POST /api/memberships/ownership-offers/[id]/decline - Decline the universe offered to you
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    await declineOffer({ offerId: id, userId: sessionUser.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof OfferError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Error: decline the offer', error);
    return NextResponse.json({ error: 'Failed to decline the offer' }, { status: 500 });
  }
}
