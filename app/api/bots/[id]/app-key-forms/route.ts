import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { openKeyForm, KeyFormError } from '@/lib/app-direct/connect';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    /** Who is asking, as the bot server authenticated them. Only the Brick's owner can have a form opened for them. */
    requesterKey: z.string().trim().min(1).max(400),
    /** A service of the shipped list... */
    service: z.string().trim().min(1).max(60).optional(),
    /** ...or a setup the Brick drafted from the service's docs (data, validated), with the address of the docs it read. */
    draft: z.unknown().optional(),
    source: z.string().trim().url().max(255).optional(),
  })
  .strict()
  .refine((body) => (body.service ? body.draft === undefined : body.draft !== undefined && !!body.source), 'Say a service, or a draft with where it came from');

/**
 * POST /api/bots/:id/app-key-forms { requesterKey, service } or { requesterKey, draft, source } - a Brick asks for a key (game #2044): the
 * "Connect {app}?" card. Opens a safe form for the Brick's OWNER only; the key is typed into it in the game and goes straight to Orbit
 * (POST /api/me/apps/key-forms/:id/key), never through the bot server or the chat. A guest Brick, a room bot and someone else's Brick never
 * ask. Nobody reviews a draft: the form shows the owner where the key would go. Auth: BOT_SERVICE_TOKEN. Answers { id, replacing }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'opening a key form', async () => {
    const { id } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const bot = await prisma.bot.findUnique({ where: { id }, select: { roomId: true, ownerId: true, deletedAt: true } });
    const asker = await findUserByIdentifier(body.data.requesterKey);
    // The same answer for every reason: a bot that is not a Brick, a Brick that is not theirs, a guest
    if (!bot || !asker || asker.isGuest || !ownsBrick(bot, asker.id)) return json(request, { error: 'Not found' }, 404);
    try {
      const opened = await openKeyForm({ ownerId: asker.id, botId: id, service: body.data.service, draft: body.data.draft, source: body.data.source });
      return json(request, opened, 201);
    } catch (error) {
      if (error instanceof KeyFormError) return json(request, { error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
}
