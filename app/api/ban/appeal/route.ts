import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { findPlayerBan, MAX_APPEAL } from '@/lib/moderation';

/**
 * A banned player's one message asking the world's admins to let them back in, sent by the game on their behalf.
 * It shows on the ban in the world's Safety tab, where an admin lifts or keeps the ban.
 */
export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    const body = await request.json();
    const { userIdentifier, playUri, text } = body ?? {};
    const appeal = typeof text === 'string' ? text.trim() : '';
    if (typeof userIdentifier !== 'string' || typeof playUri !== 'string' || !appeal) {
      return NextResponse.json({ error: 'userIdentifier, playUri and text are required' }, { status: 400 });
    }

    const found = await findPlayerBan(userIdentifier, playUri);
    // Only a ban from this world can be appealed to its admins
    if (!found?.ban || found.ban.worldId !== found.world.id) {
      return NextResponse.json({ error: 'not_banned' }, { status: 404 });
    }

    // One appeal per ban: only the first write lands
    const { count } = await prisma.ban.updateMany({
      where: { id: found.ban.id, appealedAt: null },
      data: { appealText: appeal.slice(0, MAX_APPEAL), appealedAt: new Date() },
    });
    if (count === 0) {
      return NextResponse.json({ error: 'already_appealed' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error in /api/ban/appeal:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
