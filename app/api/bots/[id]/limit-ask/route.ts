import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { json } from '@/lib/bot-access-api';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bots/:id/limit-ask
 * "Ask <bot>'s maker" on the limit card (game #1159 step 3): a signed-in person who has used their Universe AI replies on
 * this bot asks its maker to run it on their own key. Counted once per person and window; the maker sees how many asked,
 * never who, and never anything they said. Nothing to ask when the person has not reached a limit on this bot.
 *
 * Auth: the signed-in person themselves.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSessionUser(request);
    if (!session) return json(request, { error: 'Unauthorized' }, 401);
    const user = await prisma.user.findUnique({ where: { id: session.id }, select: { uuid: true, email: true } });
    const ids = [user?.uuid, user?.email].filter((value): value is string => !!value);
    const hit = ids.length
      ? await prisma.botReplyLimitHit.findFirst({
          where: { botId: id, kind: 'universe-ai', talkedUserId: { in: ids }, windowEndsAt: { gt: new Date() } },
          orderBy: { windowEndsAt: 'desc' },
          select: { id: true, askedAt: true },
        })
      : null;
    if (!hit) return json(request, { error: 'Nothing to ask for' }, 404);
    if (!hit.askedAt) await prisma.botReplyLimitHit.update({ where: { id: hit.id }, data: { askedAt: new Date() } });
    return json(request, { asked: true });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'reply-limits' } });
    console.error('Error asking a bot maker:', error);
    return json(request, { error: 'Failed to ask' }, 500);
  }
}
