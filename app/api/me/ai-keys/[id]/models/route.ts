import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { listModelsForSavedKey } from '@/lib/ai-key-edit';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/ai-keys/:id/models { address? } - the models a key you own can use, asked of its provider with the saved
 * key (which is never shown), at its saved address or a new one you are trying (#374). Nothing is saved. Only its owner
 * can; anyone else, and a server provider, gets "not found".
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  const body: unknown = await request.json().catch(() => ({}));
  const address = typeof body === 'object' && body !== null ? (body as { address?: unknown }).address : undefined;
  if (!allowKeyAttempt(user.id)) return respond(request, { ok: false, message: 'Too many tries. Wait a minute and try again.' }, 429);
  try {
    const result = await listModelsForSavedKey(user.id, id, { address });
    if (result.ok) return respond(request, { ok: true, models: result.models });
    if (result.status === 404) return respond(request, { error: result.message }, 404);
    return respond(request, { ok: false, message: result.message });
  } catch (error) {
    console.error('[AiKeys] Load models for a saved key failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { ok: false, message: 'Something went wrong on our side. Try again.' }, 500);
  }
}
