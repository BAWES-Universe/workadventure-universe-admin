import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { corsHeaders } from '@/lib/cors';
import { listMyMemory } from '@/lib/bot-memory-person';
import { memoryJson, myMemoryAuth } from '@/lib/my-memory-api';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/my-memory
 * What this bot remembers about the signed-in person (game #2003): a list of things, each with the id Forget names, when
 * it was said (when the bot kept that) and whether it was said privately. For their own Brick's page and for the chat
 * menu of anyone else's bot ("What Melody remembers about you"). Only the person themselves: nobody else can ask, and the
 * bot's owner and managers cannot read it through here or anywhere else.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await myMemoryAuth(request, id);
    if (auth.response) return auth.response;
    return memoryJson(request, await listMyMemory(id, auth.who));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-memory' } });
    console.error('Error reading what a bot remembers:', error instanceof Error ? error.message : 'unknown error');
    return memoryJson(request, { error: 'Internal server error' }, 500);
  }
}
