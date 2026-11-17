import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import * as Sentry from '@sentry/nextjs';
import { archiveById, openArchive, verifyDownloadToken } from '@/lib/computer-archives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/computer/archives/:id/download
 * What a computer fetches when a copy of a Brick's folder is restored onto it (cold storage, lib/computer-cold.ts): the copy, decrypted, as a tar.gz.
 * Auth: a key made for this one copy and one computer that runs out after a short while (never a login). It is read to its end and checked there:
 * a copy that was changed or cut short ends the connection with an error instead of a clean finish, so the computer never keeps half a copy.
 * Only a copy that was written whole (stored) or proved (verified) is given.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const key = verifyDownloadToken(bearer, id);
    if (!key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const archive = await archiveById(id);
    if (!archive || (archive.state !== 'stored' && archive.state !== 'verified')) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const opened = await openArchive(archive);
    const stream = opened.stream;
    stream.on('error', (error) => {
      Sentry.captureException(error, { tags: { area: 'computer', step: 'archive_download' }, extra: { archiveId: id } });
      console.error('[Computer] A copy failed its check while it was sent:', error instanceof Error ? error.message : 'unknown');
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(opened.bytes), 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer', step: 'archive_download' } });
    console.error('[Computer] A copy could not be sent:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
