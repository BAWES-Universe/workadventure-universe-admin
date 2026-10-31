import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { readBotVoice, setBotVoiceEnabled } from '@/lib/bot-voice';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/voice
 * A bot's voice (#740): { enabled, universeAllows, paidBy: "universe-ai" | "owner" | "mixed", parts: { recognition, speech },
 * revision (the one it speaks with, or null), draft: { profile, updatedAt },
 * revisions: [{ number, profile, note, publishedById, publishedAt }] newest first, lentKeys }.
 *
 * Auth: Manage bots for this bot (403 without it).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' }, 'read');
    if (auth.response) return auth.response;
    return json(request, await readBotVoice(id));
  } catch (error) {
    return toolsFailure(request, error, 'reading the voice settings');
  }
}

const switchSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * PUT /api/bots/:id/voice { enabled }
 * Voice on or off for this bot. On needs the universe to allow voice bots and a published profile whose providers work now
 * (409 with the line that says which); off always works. Response: the same as GET.
 *
 * Auth: Manage bots for this bot.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;
    const parsed = switchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'enabled must be true or false' }, 400);
    return json(request, await setBotVoiceEnabled(id, parsed.data.enabled));
  } catch (error) {
    return toolsFailure(request, error, 'changing the voice settings');
  }
}
