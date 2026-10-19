import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { isIfDown } from '@/lib/ai-key-health';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * PATCH /api/me/ai-keys/:id { ifDown: "universe-ai" | "stop" } - what the bots on this key do while it is down (#374).
 * Only its owner can; anyone else, and a server provider, gets "not found". Nothing else about a key can be changed.
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
  const ifDown = typeof body === 'object' && body !== null ? (body as { ifDown?: unknown }).ifDown : undefined;
  if (!isIfDown(ifDown)) return respond(request, { error: 'ifDown must be "universe-ai" or "stop"' }, 400);
  try {
    const result = await prisma.botsAiProvider.updateMany({ where: { providerId: id, ownerId: user.id }, data: { ifDown } });
    if (result.count === 0) return respond(request, { error: 'Key not found' }, 404);
    return respond(request, { status: 'saved', ifDown });
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
    return respond(request, { status: 'revoked', moved: moved.count });
  } catch (error) {
    console.error('[AiKeys] Revoke failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
