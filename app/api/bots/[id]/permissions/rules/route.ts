import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { authorizeBotManager, json } from '@/lib/bot-access-api';
import { BotSettingsError, deleteBotRule, ruleSchema, saveBotRule } from '@/lib/bot-access-settings';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * PUT /api/bots/:id/permissions/rules
 * Set a role's or a person's No / Default / Yes for this bot.
 * Body: one of { roleId } | { userId } | { identifier }, and any of { chat, dm, summon, manage, change, deleteOrSend },
 * each "yes" | "no" | "default". Only the actions sent change; a row that does not exist yet is added.
 * Response: the row.
 *
 * Auth: whoever manages the bot.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;

    const parsed = ruleSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);

    return json(request, await saveBotRule(auth.place, parsed.data));
  } catch (error) {
    if (error instanceof BotSettingsError) return json(request, { error: error.message }, error.status);
    Sentry.captureException(error, { tags: { area: 'bot-permissions' } });
    console.error('Error saving bot rule:', error);
    return json(request, { error: 'Failed to save the rule' }, 500);
  }
}

/**
 * DELETE /api/bots/:id/permissions/rules?roleId=... or ?userId=...
 * Take a role's or a person's row off this bot: they follow the roles again. 404 when there is no such row.
 *
 * Auth: whoever manages the bot.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;

    const search = new URL(request.url).searchParams;
    const removed = await deleteBotRule(id, { roleId: search.get('roleId'), userId: search.get('userId') });
    if (!removed) return json(request, { error: 'There is no rule for that role or person' }, 404);
    return json(request, { success: true });
  } catch (error) {
    if (error instanceof BotSettingsError) return json(request, { error: error.message }, error.status);
    Sentry.captureException(error, { tags: { area: 'bot-permissions' } });
    console.error('Error removing bot rule:', error);
    return json(request, { error: 'Failed to remove the rule' }, 500);
  }
}
