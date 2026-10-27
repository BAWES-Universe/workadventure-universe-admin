import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { authorizeBotManager, json } from '@/lib/bot-access-api';
import { BotSettingsError, readBotSettings, saveBotSettings, settingsSchema } from '@/lib/bot-access-settings';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/permissions
 * Who may use this bot (#427): Private bot, the line refused people hear, the daily reply limit for each person (none until the owner sets one), every rule
 * for a role or a person, and the roles a rule can name with what each gives by default.
 *
 * Auth: whoever manages the bot, or the bot server's admin token.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: true });
    if (auth.response) return auth.response;
    const settings = await readBotSettings(id);
    if (!settings) return json(request, { error: 'Bot not found' }, 404);
    return json(request, settings);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-permissions' } });
    console.error('Error reading bot permissions:', error);
    return json(request, { error: 'Failed to read bot permissions' }, 500);
  }
}

/**
 * PUT /api/bots/:id/permissions
 * Body: any of { privateBot: boolean, refusalReply: string | null, dailyReplyCap: 1..10000 | null }.
 * null is no limit. Only what is sent changes.
 * Response: the same as GET.
 *
 * Auth: whoever manages the bot.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;

    const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);

    await saveBotSettings(id, parsed.data);
    const settings = await readBotSettings(id);
    if (!settings) return json(request, { error: 'Bot not found' }, 404);
    return json(request, settings);
  } catch (error) {
    if (error instanceof BotSettingsError) return json(request, { error: error.message }, error.status);
    Sentry.captureException(error, { tags: { area: 'bot-permissions' } });
    console.error('Error saving bot permissions:', error);
    return json(request, { error: 'Failed to save bot permissions' }, 500);
  }
}
