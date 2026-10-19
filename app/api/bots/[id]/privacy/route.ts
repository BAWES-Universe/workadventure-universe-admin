import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { authorizeBotManager, json } from '@/lib/bot-access-api';
import { BOT_PRIVACY_CHOICES, loadBotPrivacy, memoryTally, storedFor, type BotPrivacyChoice } from '@/lib/bot-privacy';
import { validateServiceToken } from '@/lib/service-tokens';
import { trustedCorsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/** People listed for Forget; more than any bot page can show. */
const MAX_PEOPLE = 200;

/** The bot server falls back to the admin token when it has no service token; either way it only gets the answer. */
function hasAdminToken(request: NextRequest): boolean {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const expected = process.env.ADMIN_API_TOKEN;
  return !!token && !!expected && token === expected;
}

const bodySchema = z.object({ choice: z.enum(BOT_PRIVACY_CHOICES as [BotPrivacyChoice, ...BotPrivacyChoice[]]) }).strict();

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: trustedCorsHeaders(request) });
}

/**
 * GET /api/bots/:id/privacy
 * Hide bot conversations (#435) for one bot: whether its universe hides them, what its managers picked, and the answer
 * (`hidden`). A hidden bot also tells a manager how many people it remembers and lists who, by name and nothing more,
 * so one of them can be forgotten; a guest is a guest, and nobody's email or player id is sent.
 *
 * Auth: the bot server (service token, or the admin token it falls back to) gets the answer alone; whoever manages the bot gets it all.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fromBotServer = validateServiceToken(request) || hasAdminToken(request);
    if (!fromBotServer) {
      const auth = await authorizeBotManager(request, id, { adminTokenReads: true });
      if (auth.response) return auth.response;
    }
    const privacy = await loadBotPrivacy(id);
    if (!privacy) return json(request, { error: 'Bot not found' }, 404);
    if (fromBotServer) return json(request, { botId: id, ...privacy });

    const [tally, replies, people] = await Promise.all([
      memoryTally(id),
      prisma.botsAiUsage.count({ where: { botId: id } }),
      privacy.hidden
        ? prisma.botsMemory.findMany({
            where: { botId: id },
            select: { id: true, userName: true, isGuest: true, updatedAt: true, user: { select: { name: true } } },
            orderBy: { updatedAt: 'desc' },
            take: MAX_PEOPLE,
          })
        : Promise.resolve([]),
    ]);
    return json(request, {
      botId: id,
      ...privacy,
      ...tally,
      replies,
      ...(privacy.hidden
        ? {
            remembered: people.map((person) => ({
              id: person.id,
              name: person.user?.name || person.userName || null,
              isGuest: person.isGuest,
              updatedAt: person.updatedAt.getTime(),
            })),
          }
        : {}),
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-privacy' } });
    console.error('Error reading bot privacy:', error);
    return json(request, { error: 'Failed to read the privacy setting' }, 500);
  }
}

/**
 * PUT /api/bots/:id/privacy
 * Body: { choice: 'follow' | 'private' | 'normal' }. A bot in a universe that hides bot conversations cannot be set
 * to Normal: the universe wins.
 *
 * Auth: whoever manages the bot.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);

    const current = await loadBotPrivacy(id);
    if (!current) return json(request, { error: 'Bot not found' }, 404);
    if (current.universeHides && parsed.data.choice === 'normal') {
      return json(request, { error: 'This universe hides bot conversations, so a bot in it cannot be set to Normal. The universe owner can change that.' }, 409);
    }

    await prisma.bot.update({ where: { id }, data: { hideConversations: storedFor(parsed.data.choice) } });
    const privacy = await loadBotPrivacy(id);
    return json(request, { botId: id, ...privacy });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-privacy' } });
    console.error('Error saving bot privacy:', error);
    return json(request, { error: 'Failed to save the privacy setting' }, 500);
  }
}
