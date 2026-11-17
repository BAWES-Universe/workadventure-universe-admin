import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { ArtifactError } from '@/lib/artifacts';
import { servePrivateFile } from '@/lib/artifact-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What a refusal is sent with: plain text that runs nothing, kept by nobody. */
const REFUSAL_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

/**
 * GET /af/:pass/:version/:name
 * A file of a "Just you" artifact (game #1994): the page or drawing (`index.html`, `index.svg`) and the songs, images and
 * videos beside a page, named as the page names them. Not under /api: a page is shown in a frame of the game or of Orbit,
 * which every /api answer forbids.
 *
 * Auth: the pass in the address, made for one opening by the artifact's owner (lib/artifact-pass.ts). No sign-in is read
 * and none is given to the page. The page is tied to the first browser that asks, by a cookie only this address reads.
 * Response: the file, locked as every artifact is. Anything else: one plain line.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string; number: string; name: string }> }) {
  try {
    const { token, number, name } = await context.params;
    const file = await servePrivateFile({
      token,
      number,
      name,
      cookies: request.headers.get('cookie'),
      fetchDest: request.headers.get('sec-fetch-dest'),
      range: request.headers.get('range'),
    });
    return new Response(file.body as BodyInit | null, { status: file.status, headers: file.headers });
  } catch (error) {
    if (error instanceof ArtifactError) return new Response(error.message, { status: error.status, headers: REFUSAL_HEADERS });
    // Never the content or the address: only that it broke
    Sentry.captureException(error, { tags: { area: 'artifacts', route: 'GET /af/:pass/:version/:name' } });
    console.error('Error in GET /af/:pass/:version/:name:', error instanceof Error ? error.message : 'unknown');
    return new Response('This could not be opened. Try again in a moment.', { status: 500, headers: REFUSAL_HEADERS });
  }
}
