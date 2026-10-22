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
 * DELETE /api/me/ai-keys/:id/lend/:universeId - pull one of the caller's keys from a universe. Bots of that universe on
 * the key move to Universe AI and the universe's owner is told once (#374). Always the key owner's to do, whatever
 * they can manage there now.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; universeId: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id, universeId } = await params;
  try {
    const lend = await prisma.aiKeyLend.findFirst({
      where: { providerId: id, universeId, provider: { ownerId: user.id } },
      select: { id: true },
    });
    if (!lend) return respond(request, { error: 'Not lent to that universe' }, 404);
    const moved = await moveBotsOffKey(id, { universeId, actor: { id: user.id, name: user.name }, why: 'pulled' });
    await prisma.aiKeyLend.deleteMany({ where: { id: lend.id } });
    return respond(request, { status: 'pulled', moved: moved.count });
  } catch (error) {
    console.error('[AiKeys] Pull failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
