import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { clearDownNotice, isIfDown } from '@/lib/ai-key-health';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { editSavedKey } from '@/lib/ai-key-edit';
import { forgetKeyModels } from '@/lib/ai-key-model-list';
import { checkReplyLimits, readReplyLimits, replyLimitsProblem } from '@/lib/bot-limit-values';
import type { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

/** The longest a key's name may be, as when it is added. */
const MAX_KEY_NAME = 60;

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * PATCH /api/me/ai-keys/:id { name?, ifDown?, address?, model?, limits? } - change a key you own (#374).
 *   - `name`: what the key is called (1 to 60 characters). Only the name changes: the key keeps its id, so its lends and
 *     the bots on it stay, and nobody is told (#633).
 *   - `ifDown` ("universe-ai" | "stop"): what the bots on this key do while it is down.
 *   - `limits` (#666): the reply limits of bots on this key, only the ones that change, e.g. { reply: 16000 }. Answers
 *     with all six as saved.
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
  const input = body as { name?: unknown; ifDown?: unknown; address?: unknown; model?: unknown; limits?: unknown };
  const changesWhere = input.address !== undefined || input.model !== undefined;
  if (input.ifDown !== undefined && !isIfDown(input.ifDown)) return respond(request, { error: 'ifDown must be "universe-ai" or "stop"' }, 400);
  if (input.ifDown === undefined && input.name === undefined && !changesWhere && input.limits === undefined) return respond(request, { error: 'ifDown must be "universe-ai" or "stop"' }, 400);
  let name: string | undefined;
  if (input.name !== undefined) {
    name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return respond(request, { error: 'Give the key a name.' }, 400);
    if (name.length > MAX_KEY_NAME) return respond(request, { error: `Keep the name under ${MAX_KEY_NAME} characters.` }, 400);
  }
  const limits = input.limits === undefined ? null : checkReplyLimits(input.limits);
  if (limits && !limits.ok) return respond(request, { error: limits.error }, 400);
  try {
    // Reply limits are checked against what is saved before anything is written, so a turned-down change saves nothing
    let nextLimits: Record<string, unknown> | null = null;
    if (limits?.ok) {
      const key = await prisma.botsAiProvider.findFirst({ where: { providerId: id, ownerId: user.id }, select: { replyLimits: true } });
      if (!key) return respond(request, { error: 'Key not found' }, 404);
      const saved = key.replyLimits && typeof key.replyLimits === 'object' && !Array.isArray(key.replyLimits) ? (key.replyLimits as Record<string, unknown>) : {};
      // Only what the owner changed is kept, so a value they never touched follows the recommended one
      nextLimits = { ...saved, ...limits.value };
      // Turned down with the reason, never cut quietly to fit
      const problem = replyLimitsProblem(readReplyLimits(nextLimits), limits.value);
      if (problem) return respond(request, { error: problem }, 400);
    }
    if (changesWhere) {
      if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
      const edited = await editSavedKey(user.id, id, input);
      if (!edited.ok) return respond(request, { error: edited.message, ...(edited.code ? { code: edited.code } : {}) }, edited.status);
    }
    if (isIfDown(input.ifDown) || name !== undefined) {
      const result = await prisma.botsAiProvider.updateMany({
        where: { providerId: id, ownerId: user.id },
        data: { ...(isIfDown(input.ifDown) ? { ifDown: input.ifDown } : {}), ...(name !== undefined ? { name } : {}) },
      });
      if (result.count === 0) return respond(request, { error: 'Key not found' }, 404);
    }
    let savedLimits = null;
    if (nextLimits) {
      await prisma.botsAiProvider.updateMany({ where: { providerId: id, ownerId: user.id }, data: { replyLimits: nextLimits as Prisma.InputJsonValue } });
      savedLimits = readReplyLimits(nextLimits);
    }
    return respond(request, { status: 'saved', ...(isIfDown(input.ifDown) ? { ifDown: input.ifDown } : {}), ...(name !== undefined ? { name } : {}), ...(savedLimits ? { limits: savedLimits } : {}) });
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
    forgetKeyModels(id);
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
