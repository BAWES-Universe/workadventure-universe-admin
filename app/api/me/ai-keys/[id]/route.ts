import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { moveBotsOffKey } from '@/lib/ai-key-lend';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
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
