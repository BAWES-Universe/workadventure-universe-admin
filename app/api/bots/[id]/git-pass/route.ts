import { NextRequest } from 'next/server';
import { json, preflight, serviceRoute } from '@/lib/bot-action-api';
import { issueGitPass } from '@/lib/github/git-relay';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/git-pass - a 15-minute pass for this Brick's computer to use git as its owner through Orbit (game #2041):
 * { pass, expiresAt, remoteBase, name, email }. The computer sets `remoteBase/<owner>/<repo>.git` as its remote, the pass as the
 * password, and the owner's GitHub name and no-reply address as who commits. 404 when the Brick does not use its owner's GitHub.
 * Auth: BOT_SERVICE_TOKEN (the job runner asks for it when a job starts, and again before it runs out).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'giving a git pass', async () => {
    const { id } = await params;
    const issued = await issueGitPass(id);
    if (issued.status === 'ok') {
      const { status: _status, ...pass } = issued;
      void _status;
      return json(request, pass);
    }
    if (issued.status === 'unavailable') return json(request, { error: 'Not available' }, 503);
    return json(request, { error: 'This Brick does not use GitHub' }, 404);
  });
}
