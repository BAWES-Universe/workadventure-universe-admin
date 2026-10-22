import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { recordReply } from '@/lib/ai-key-health';

/**
 * POST /api/bots/:id/ai-health { ok: boolean, rejected?: boolean }
 * The bot server tells Orbit how a reply went when it was sent through a bot's own AI key (`source: "own-key"` in
 * /api/bots/:id/ai-credentials). Two failed replies in a row, or a rejected key, mark the key Down (#374). Which key it is
 * comes from the bot, never from the request, so a report can only ever count against the key the bot runs on.
 *
 * Auth: service token only. Answers 204 whatever happens to the key, so a report never slows or breaks a reply.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || typeof (body as { ok?: unknown }).ok !== 'boolean') {
      return NextResponse.json({ error: 'Expected { ok: boolean }' }, { status: 400 });
    }
    const { ok, rejected } = body as { ok: boolean; rejected?: unknown };
    const bot = await prisma.bot.findUnique({ where: { id }, select: { aiProviderRef: true } });
    if (!bot?.aiProviderRef) return new NextResponse(null, { status: 204 });
    await recordReply(bot.aiProviderRef, ok ? { ok: true } : { ok: false, rejected: rejected === true });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[BotAi] Health report failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
