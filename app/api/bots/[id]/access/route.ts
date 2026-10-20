import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { BOT_ACTIONS, checkBotAccess } from '@/lib/bot-access';
import { corsHeaders } from '@/lib/cors';
import { requireServiceToken } from '@/lib/service-tokens';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    action: z.enum(BOT_ACTIONS as [string, ...string[]]),
    person: z.object({
      signedIn: z.boolean(),
      identifier: z.string().trim().min(1).max(320).nullish(),
      chatId: z.string().trim().min(1).max(320).nullish(),
    }),
  })
  .refine((body) => !body.person.signedIn || !!body.person.identifier || !!body.person.chatId, { message: 'A signed-in person needs an identifier', path: ['person', 'identifier'] })
  .refine((body) => !body.person.chatId || (body.action === 'dm' && !body.person.identifier), { message: 'A chat ID names the person only for a direct message, and never with an identifier', path: ['person', 'chatId'] });

/**
 * OPTIONS /api/bots/:botId/access
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/:botId/access
 * Can this person do this with this bot? (#426)
 *
 * Auth: BOT_SERVICE_TOKEN
 * Body: { action: "chat" | "dm" | "summon", person: { signedIn: boolean, identifier?: string, chatId?: string } }
 * Response: { allowed: boolean, code: "allowed" | "sign_in_required" | "not_allowed" | "no_room_access" | "unknown_person"
 *   | "shared_chat_id" | "banned", reason: string | null, person?: { uuid: string, name: string | null } }
 *
 * A direct message that reached the bot over chat names the person by their chat ID instead (action "dm" only): Orbit
 * finds the one account with it, refuses an ID no account or two accounts have, and answers with whose it is.
 *
 * A no is a 200 with `allowed: false` and a line to show. Anything that stops Orbit answering is an error status, so
 * the caller can tell "no" from "could not check".
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);

    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues }, { status: 400, headers: corsHeaders() });
    }

    const answer = await checkBotAccess({
      botId: id,
      action: parsed.data.action as (typeof BOT_ACTIONS)[number],
      person: parsed.data.person,
    });
    if (!answer) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders() });
    }
    return NextResponse.json(answer, { headers: corsHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
    }
    Sentry.captureException(error, { tags: { area: 'bot-access' } });
    console.error('Error checking bot access:', error);
    return NextResponse.json({ error: 'Failed to check bot access' }, { status: 500, headers: corsHeaders() });
  }
}
