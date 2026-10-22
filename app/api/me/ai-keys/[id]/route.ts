import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { clearDownNotice, isIfDown } from '@/lib/ai-key-health';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { editSavedKey } from '@/lib/ai-key-edit';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * PATCH /api/me/ai-keys/:id { ifDown?, address?, model? } - change a key you own (#374).
 *   - `ifDown` ("universe-ai" | "stop"): what the bots on this key do while it is down.
 *   - `address` / `model`: where an own-computer key points, or which model it uses. The new address and model are
 *     checked first (model list, then one tiny chat reply), and nothing is saved unless they answer. The key keeps its
 *     id, so it stays lent and its bots stay on it. A key that was Down and answers is Working again.
 * Only its owner can; anyone else, and a server provider, gets "not found".
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'Expected an object' }, 400);
  const input = body as { ifDown?: unknown; address?: unknown; model?: unknown };
  const changesWhere = input.address !== undefined || input.model !== undefined;
  if (input.ifDown !== undefined && !isIfDown(input.ifDown)) return respond(request, { error: 'ifDown must be "universe-ai" or "stop"' }, 400);
  if (input.ifDown === undefined && !changesWhere) return respond(request, { error: 'ifDown must be "universe-ai" or "stop"' }, 400);
  try {
    if (changesWhere) {
      if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
      const edited = await editSavedKey(user.id, id, input);
      if (!edited.ok) return respond(request, { error: edited.message, ...(edited.code ? { code: edited.code } : {}) }, edited.status);
    }
    if (isIfDown(input.ifDown)) {
      const result = await prisma.botsAiProvider.updateMany({ where: { providerId: id, ownerId: user.id }, data: { ifDown: input.ifDown } });
      if (result.count === 0) return respond(request, { error: 'Key not found' }, 404);
    }
    return respond(request, { status: 'saved', ...(isIfDown(input.ifDown) ? { ifDown: input.ifDown } : {}) });
  } catch (error) {
    console.error('[AiKeys] Save failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/me/ai-keys/:id - revoke one of the caller's own keys. Only its owner can; anyone else, and a server
 * provider, gets the same "not found" so ids can't be probed. Bots running on it move to Universe AI first and each
 * universe's owner is told (#374); adding the same key again later does not move them back.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  try {
    const key = await prisma.botsAiProvider.findFirst({ where: { providerId: id, ownerId: user.id }, select: { providerId: true } });
    if (!key) return respond(request, { error: 'Key not found' }, 404);
    const moved = await moveBotsOffKey(id, { actor: { id: user.id, name: user.name }, why: 'revoked' });
    await prisma.botsAiProvider.deleteMany({ where: { providerId: id, ownerId: user.id } });
    try {
      await clearDownNotice(user.id, id);
    } catch (error) {
      console.error('[AiKeys] Could not clear the notice of the revoked key:', error instanceof Error ? error.message : 'unknown');
    }
    return respond(request, { status: 'revoked', moved: moved.count });
  } catch (error) {
    console.error('[AiKeys] Revoke failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
