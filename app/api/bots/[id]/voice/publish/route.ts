import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { publishVoiceDraft } from '@/lib/bot-voice';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const publishSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

/**
 * POST /api/bots/:id/voice/publish { note? }
 * Publishes the draft as the bot's next revision, which it speaks with from now on. The draft has to be finished, and the
 * providers in it on, with their key, doing that job and listing the model (400 for unfinished, 409 for the rest, with the
 * line that says which). Response: the same as GET /api/bots/:id/voice.
 *
 * Auth: Manage bots for this bot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;
    const body = request.headers.get('content-length') === '0' ? {} : await request.json().catch(() => null);
    const parsed = publishSchema.safeParse(body ?? {});
    if (!parsed.success) return json(request, { error: 'note must be text of up to 500 characters' }, 400);
    return json(request, await publishVoiceDraft(id, parsed.data.note || null, auth.person?.id ?? ''));
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      return json(request, { error: 'Someone else just published. Look again and try again' }, 409);
    }
    return toolsFailure(request, error, 'publishing the voice profile');
  }
}
