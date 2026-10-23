import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { allowKeyAttempt, loadModels } from '@/lib/ai-key-models';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/ai-keys/models { kind, address?, apiKey? } - "Load models": asks the provider for its models with what
 * was typed, nothing saved. It also tells the person whether the key or server answers. Answers `{ ok, models }` or
 * `{ ok: false, message }` with a plain sentence for the person (a refused address is a normal answer, not an error).
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'Expected an object' }, 400);
  if (!allowKeyAttempt(user.id)) return respond(request, { ok: false, message: 'Too many tries. Wait a minute and try again.' }, 429);
  const input = body as { kind?: unknown; address?: unknown; apiKey?: unknown };
  try {
    return respond(request, await loadModels(input));
  } catch (error) {
    console.error('[AiKeys] Load models failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { ok: false, message: 'Something went wrong on our side. Try again.' }, 500);
  }
}
