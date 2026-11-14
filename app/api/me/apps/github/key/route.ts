import { NextRequest } from 'next/server';
import { z } from 'zod';
import { NOT_FOUND } from '@/lib/app-connections';
import { connectGitHub, dropOwnKey, saveOwnKey } from '@/lib/github/connection';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

const keySchema = z.object({ key: z.string().trim().min(10).max(500) }).strict();

/**
 * POST /api/me/apps/github/key { key } - "Use my own GitHub key instead" (game #2041): a key the person made on GitHub, checked with
 * GitHub and then used instead of the sign-in, for every Brick that uses their GitHub. Answers { id, login }. 400 when GitHub does
 * not take the key. The key is never shown again.
 */
export async function POST(request: NextRequest) {
  return appsRoute(request, METHODS, 'saving a GitHub key', async (user, respond) => {
    const parsed = keySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Paste the whole key' }, 400);
    const connection = await connectGitHub(user.id);
    if (!connection) return respond({ error: NOT_FOUND }, 404);
    const saved = await saveOwnKey(connection.id, parsed.data.key);
    if (saved.status === 'refused') return respond({ error: 'GitHub did not take this key', code: 'refused' }, 400);
    if (saved.status !== 'saved') return respond({ error: 'GitHub could not be reached just now', code: 'unavailable' }, 502);
    return respond({ id: connection.id, login: saved.login });
  });
}

/** DELETE /api/me/apps/github/key - "Switch back": the pasted key is forgotten; the person signs in through the app again. */
export async function DELETE(request: NextRequest) {
  return appsRoute(request, METHODS, 'dropping a GitHub key', async (user, respond) => {
    const connection = await connectGitHub(user.id);
    if (!connection) return respond({ error: NOT_FOUND }, 404);
    await dropOwnKey(connection.id);
    return respond({ id: connection.id });
  });
}
