import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { rollBackVoice } from '@/lib/bot-voice';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const rollbackSchema = z.object({ number: z.number().int().min(1) }).strict();

/**
 * POST /api/bots/:id/voice/rollback { number }
 * The bot speaks with an earlier revision again (the draft is left as it is). 404 for a revision that doesn't exist, 409 when
 * the providers it names don't work as it says now. Response: the same as GET /api/bots/:id/voice.
 *
 * Auth: Manage bots for this bot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;
    const parsed = rollbackSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'number must be a whole number from 1' }, 400);
    return json(request, await rollBackVoice(id, parsed.data.number));
  } catch (error) {
    return toolsFailure(request, error, 'going back to an earlier voice profile');
  }
}
