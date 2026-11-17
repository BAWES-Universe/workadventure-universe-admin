import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { markFileDelivered, readCard } from '@/lib/computer-file-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/computer/jobs/:jobId/files/:fileId - the bytes of one file a finished computer job made, for the bot server to put in the person's chat as a file
 * card (the file card). The file is the person's own result and stays for as long as Limits' days say (or until they delete it, or the Brick is deleted),
 * whether or not the chat took it; after that this answers 404. Auth: service token only. Never cached.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string; fileId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { jobId, fileId } = await params;
    const card = await readCard(jobId, fileId);
    if (!card) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    return new NextResponse(new Uint8Array(card.data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(card.data.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // The name and the type the chat card shows go with the bytes, encoded so nothing in a name can break a header
        'X-File-Name': encodeURIComponent(card.name),
        'X-File-Type': card.mime,
      },
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not read a file for the chat:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/computer/jobs/:jobId/files/:fileId - the chat took this file. It is marked, so a restart of the bot server never sends it again, and Files shows it
 * as delivered. Safe to say twice. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string; fileId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { jobId, fileId } = await params;
    return (await markFileDelivered(jobId, fileId)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'File not found' }, { status: 404 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not keep that a file was delivered:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
