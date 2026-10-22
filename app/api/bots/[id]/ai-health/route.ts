import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { recordReply } from '@/lib/ai-key-health';

/**
 * POST /api/bots/:id/ai-health { ok: boolean, rejected?: boolean, status?: number }
 * The bot server tells Orbit how a reply went when it was sent through a bot's own AI key (`source: "own-key"` in
 * /api/bots/:id/ai-credentials). `status` is what the provider answered with, if it did; lib/ai-key-health.ts decides what
 * counts against the key (a rejection, no credit or a missing model at once, other availability errors two in a row,
 * and a 400 never) (#374). Which key it is
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
    const { ok, rejected, status } = body as { ok: boolean; rejected?: unknown; status?: unknown };
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const bot = await prisma.bot.findUnique({ where: { id }, select: { aiProviderRef: true } });
    if (!bot?.aiProviderRef) return new NextResponse(null, { status: 204 });
    await recordReply(bot.aiProviderRef, ok ? { ok: true } : { ok: false, rejected: rejected === true, status: httpStatus });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[BotAi] Health report failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
