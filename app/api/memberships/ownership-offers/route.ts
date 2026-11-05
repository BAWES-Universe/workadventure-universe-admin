import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

export const dynamic = 'force-dynamic';

// GET /api/memberships/ownership-offers - Universes offered to you, for "Offered to you" on Memberships (#820).
// The owner is named, never their email.
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const offers = await prisma.ownershipOffer.findMany({
      // Only while you are still a member: an offer to someone who left has already ended
      where: { toUserId: sessionUser.id, universe: { members: { some: { userId: sessionUser.id } } } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        universe: {
          select: {
            id: true,
            name: true,
            owner: { select: { id: true, name: true } },
            worlds: { select: { id: true } },
          },
        },
      },
    });
    return NextResponse.json({
      offers: offers.map((offer) => ({
        id: offer.id,
        createdAt: offer.createdAt,
        universe: { id: offer.universe.id, name: offer.universe.name, worldCount: offer.universe.worlds.length },
        owner: { id: offer.universe.owner.id, name: offer.universe.owner.name },
      })),
    });
  } catch (error) {
    console.error('Error fetching ownership offers:', error);
    return NextResponse.json({ error: 'Failed to fetch ownership offers' }, { status: 500 });
  }
}
