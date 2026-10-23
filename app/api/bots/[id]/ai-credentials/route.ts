import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { credentialsForBot } from '@/lib/bot-ai-credentials';

/**
 * GET /api/bots/:id/ai-credentials
 * How a bot talks to its AI: the provider it runs on, with its key still encrypted (the bot server decrypts it).
 *
 * Auth: service token only. Asked by bot id on purpose (#374): a bot on a personal key is served that key only while it
 * is its maker's, lent to the bot's universe, and its maker can still manage bots there; otherwise the bot is moved to
 * Universe AI and that is what is served. "universe-ai" is served as the current Default. See lib/bot-ai-credentials.ts.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const result = await credentialsForBot(id);
    if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.body);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[BotAi] Credentials failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
