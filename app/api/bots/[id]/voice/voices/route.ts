import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { listBotVoices, VoiceListRefused } from '@/lib/voice-voices';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const query = z.object({
  part: z.enum(['speech', 'talk'], { message: 'Only the speaking or talking voices can be listed' }),
  source: z.string().trim().min(1, 'source is required').max(100),
});

/**
 * GET /api/bots/:id/voice/voices?part=speech|talk&source=universe-ai|<keyId>
 * The speaking voices a bot's maker can pick from (game #1668), straight from the voice company's own free list (nothing is
 * spoken or billed). `source` is `universe-ai` (the server's default speaking provider) or the id of a voice key from
 * `lentKeys` in GET /api/bots/:id/voice: only a key the bot's maker lent to its universe, never anyone else's (404 otherwise).
 * Answers `[{ voiceId, name, description, languages, previewUrl, providerId, model }]` in the company's order: `languages` are
 * lowercase codes ("en", "ar"), `previewUrl` is a free sample (or null), and `model` is the speaking model to use with the voice.
 * Cached per provider for 10 minutes. 409 when the source can't list (Universe AI has no voice, no speaking model, a company
 * Orbit can't list); 502 when the company didn't answer or turned the key away. Part `recognition` has no voices (400).
 * `part=talk` lists the voices of the source's talking model instead (game #1910), each with `talk: true`, for a key that both
 * speaks and talks live (xAI): `part=speech` gives its speaking model first. 409 when the source has no talking model.
 *
 * Auth: Manage bots for this bot (403 without it).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' }, 'read');
    if (auth.response) return auth.response;
    const parsed = query.safeParse({ part: request.nextUrl.searchParams.get('part'), source: request.nextUrl.searchParams.get('source') });
    if (!parsed.success) return json(request, { error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
    return json(request, await listBotVoices(id, parsed.data.source, parsed.data.part));
  } catch (error) {
    if (error instanceof VoiceListRefused) return json(request, { error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    return toolsFailure(request, error, 'listing the voices');
  }
}

