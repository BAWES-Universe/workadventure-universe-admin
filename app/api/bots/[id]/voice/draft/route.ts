import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { saveVoiceDraft, voiceDraftSchema } from '@/lib/bot-voice';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * PUT /api/bots/:id/voice/draft { recognition?: { providerId, model }, speech?: { providerId, model, voiceId, voiceName? },
 * expression?: "restrained" | "natural" | "expressive", language?: { mode: "follow" } | { mode: "fixed", code } }
 * Saves the draft voice profile in place of the one there. Any part may be left out; publishing is what needs all of it.
 * Response: the same as GET /api/bots/:id/voice.
 *
 * Auth: Manage bots for this bot.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;
    const parsed = voiceDraftSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return json(request, { error: issue ? `${issue.path.join('.') || 'profile'}: ${issue.message}` : 'Invalid request data' }, 400);
    }
    return json(request, await saveVoiceDraft(id, parsed.data, auth.person?.id ?? ''));
  } catch (error) {
    return toolsFailure(request, error, 'saving the voice draft');
  }
}
