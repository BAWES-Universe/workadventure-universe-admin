import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { ArtifactError } from '@/lib/artifacts';
import { openOwned } from '@/lib/artifact-service';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/artifacts/:id - the latest version of one of the caller's own artifacts, to open it from Your artifacts
 * (game #1474). Anyone else's, or one that is gone: 404.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  try {
    return respond(request, await openOwned(id, user.id));
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) return respond(request, { error: 'not_found' }, 404);
    console.error('[Artifacts] Opening yours failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
