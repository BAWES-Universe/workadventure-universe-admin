import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';

export const runtime = 'nodejs';

/**
 * GET /api/voice/providers/:id/credentials
 * One voice provider that is on, with its key still encrypted (the bot server decrypts it with ENCRYPTION_KEY, as for the
 * text providers). A provider that is off, has no key or does not exist is not served.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const row = await prisma.voiceProvider.findUnique({ where: { id: (await params).id } });
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    if (!row.enabled) return NextResponse.json({ error: 'Provider is not enabled' }, { status: 400 });
    if (!row.apiKeyEncrypted) return NextResponse.json({ error: 'Provider has no key' }, { status: 400 });
    return NextResponse.json(
      {
        id: row.id,
        adapter: row.adapter,
        name: row.name,
        recognition: row.recognition,
        speech: row.speech,
        endpoint: row.endpoint,
        region: row.region,
        models: row.models,
        apiKeyEncrypted: row.apiKeyEncrypted,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'voice-providers' } });
    console.error('[VoiceProviders] Could not serve the credentials:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
