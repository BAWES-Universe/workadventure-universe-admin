import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { authorizeBotManager, json } from '@/lib/bot-access-api';
import { isBotHidden } from '@/lib/bot-privacy';
import { trustedCorsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

const bodySchema = z.union([
  /** One person, by the id the privacy list gave. */
  z.object({ memoryId: z.number().int().positive() }).strict(),
  z.object({ everyone: z.literal(true) }).strict(),
]);

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: trustedCorsHeaders(request) });
}

/**
 * POST /api/bots/:id/forget
 * Hide bot conversations (#435): make a hidden bot forget one person or everyone. Body: { memoryId } or { everyone: true }.
 *
 * The saved rows go now. The bot server also holds what it remembers in memory and saves a person again whenever they
 * talk to the bot, so a forget row is left too: the bot server hears it within 30 seconds (its privacy check, see
 * app/api/bots/[id]/privacy/route.ts) and drops these people, and a save that still carries one is skipped (see the
 * memory save in app/api/bots/memory/[id]/route.ts). The bot has truly forgotten within about 30 seconds.
 *
 * Only for a bot that hides its conversations: a manager who can read them uses the usual cleanup.
 *
 * Auth: whoever manages the bot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);

    if (!(await isBotHidden(id))) {
      return json(request, { error: 'Forget is for bots whose chat telemetry is off.' }, 409);
    }

    if ('everyone' in parsed.data) {
      const [, deleted] = await prisma.$transaction([
        prisma.botMemoryForget.create({ data: { botId: id, userUuid: null } }),
        prisma.botsMemory.deleteMany({ where: { botId: id } }),
      ]);
      return json(request, { forgotten: deleted.count, everyone: true });
    }

    const person = await prisma.botsMemory.findFirst({ where: { id: parsed.data.memoryId, botId: id }, select: { id: true, userUuid: true } });
    if (!person) return json(request, { error: 'The bot does not remember that person.' }, 404);
    // deleteMany, not delete: two managers pressing Forget on the same person at once must both succeed.
    const [, deleted] = await prisma.$transaction([
      prisma.botMemoryForget.create({ data: { botId: id, userUuid: person.userUuid } }),
      prisma.botsMemory.deleteMany({ where: { id: person.id } }),
    ]);
    return json(request, { forgotten: deleted.count, everyone: false });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-privacy' } });
    console.error('Error forgetting bot memory:', error);
    return json(request, { error: 'Failed to forget' }, 500);
  }
}
