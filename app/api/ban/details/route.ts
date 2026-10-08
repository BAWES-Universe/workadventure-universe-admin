import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { findPlayerBan } from '@/lib/moderation';

type Appeal = { sentAt: string; decision: 'pending' | 'kept' | 'lifted' };

function appealOf(ban: { appealedAt: Date | null; appealDecision: string | null }): Appeal | null {
  if (!ban.appealedAt) return null;
  const decision = ban.appealDecision === 'kept' || ban.appealDecision === 'lifted' ? ban.appealDecision : 'pending';
  return { sentAt: ban.appealedAt.toISOString(), decision };
}

/**
 * What the game's ban screen shows a banned player: which world, until when, why, and where their one appeal
 * stands. Asked by the game on the player's behalf (`userIdentifier` is who the game says they are).
 */
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    const { searchParams } = new URL(request.url);
    const userIdentifier = searchParams.get('userIdentifier');
    const playUri = searchParams.get('playUri');
    if (!userIdentifier || !playUri) {
      return NextResponse.json({ error: 'userIdentifier and playUri are required' }, { status: 400 });
    }

    const found = await findPlayerBan(userIdentifier, playUri);
    if (!found) return NextResponse.json({ banned: false });
    const { world, user, ban } = found;

    if (!ban) {
      // Let back in after an appeal: say so on the screen they're still looking at
      const lifted = user
        ? await prisma.ban.findFirst({
            where: { userId: user.id, worldId: world.id, appealDecision: 'lifted' },
            orderBy: { appealDecidedAt: 'desc' },
          })
        : null;
      return NextResponse.json({ banned: false, worldName: world.name, appeal: lifted ? appealOf(lifted) : null });
    }

    return NextResponse.json({
      banned: true,
      worldName: world.name,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
      reason: ban.reason ?? null,
      appeal: appealOf(ban),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error in /api/ban/details:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
