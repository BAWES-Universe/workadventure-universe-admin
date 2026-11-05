import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { fetchVoiceSample, VoiceListRefused } from '@/lib/voice-voices';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/voice/voices/:voiceId/preview?source=universe-ai|<keyId>
 * One voice's free sample, for a voice company that keeps it behind the key (a voice from the list whose `previewUrl` is this
 * path). The audio comes from the address the company's own list named, never from one in the request; the key never leaves
 * Orbit. Answers the audio, with the same errors as the list (404 for a voice with no sample, 502 when the company didn't answer).
 *
 * Auth: Manage bots for this bot (403 without it).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; voiceId: string }> }) {
  try {
    const { id, voiceId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' }, 'read');
    if (auth.response) return auth.response;
    const source = request.nextUrl.searchParams.get('source')?.trim();
    if (!source || source.length > 100) return json(request, { error: 'source is required' }, 400);
    const sample = await fetchVoiceSample(id, source, voiceId);
    return new NextResponse(sample.bytes, { headers: { ...corsHeaders(request), 'Content-Type': sample.contentType, 'Cache-Control': 'private, max-age=86400' } });
  } catch (error) {
    if (error instanceof VoiceListRefused) return json(request, { error: error.message }, error.status);
    return toolsFailure(request, error, 'getting the voice sample');
  }
}
