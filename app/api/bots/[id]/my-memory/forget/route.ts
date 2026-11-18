import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { corsHeaders } from '@/lib/cors';
import { forgetMyEverything, forgetMyItem } from '@/lib/bot-memory-person';
import { memoryJson, myMemoryAuth } from '@/lib/my-memory-api';

export const runtime = 'nodejs';

const bodySchema = z.union([z.object({ itemId: z.string().min(1).max(64) }).strict(), z.object({ everything: z.literal(true) }).strict()]);

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bots/:id/my-memory/forget
 * The signed-in person makes the bot forget one thing ({ itemId }, from their list) or everything it remembers about them
 * ({ everything: true }), game #2003. It happens at once and needs no one's say: it is theirs to remove. The thing goes
 * with what was built from it, and stays gone (lib/bot-memory-items.ts); the bot server is told to drop it from what it
 * keeps in memory. Their chats and files stay. Forgetting what is already gone is fine (200, nothing forgotten).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await myMemoryAuth(request, id);
    if (auth.response) return auth.response;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return memoryJson(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    if ('everything' in parsed.data) return memoryJson(request, { forgotten: await forgetMyEverything(id, auth.who), everything: true });
    return memoryJson(request, { forgotten: (await forgetMyItem(id, auth.who, parsed.data.itemId)) ? 1 : 0, everything: false });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-memory' } });
    console.error('Error forgetting what a bot remembers:', error instanceof Error ? error.message : 'unknown error');
    return memoryJson(request, { error: 'Internal server error' }, 500);
  }
}
