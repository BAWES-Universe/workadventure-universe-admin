import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { lendAccess } from '@/lib/ai-key-lend';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/ai-keys/:id/lend { universeId } - lend one of the caller's keys to a universe where they have Manage
 * bots (or own it). Lending moves no bot. Lending again is fine and changes nothing. Someone else's key, and a server
 * provider, are "not found".
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const universeId = typeof body === 'object' && body !== null ? (body as { universeId?: unknown }).universeId : null;
  if (typeof universeId !== 'string' || !universeId) return respond(request, { error: 'Pick a universe first.' }, 400);

  try {
    const key = await prisma.botsAiProvider.findFirst({ where: { providerId: id, ownerId: user.id }, select: { providerId: true } });
    if (!key) return respond(request, { error: 'Key not found' }, 404);
    if (!(await lendAccess(user.id, universeId))) {
      return respond(request, { error: 'You need Manage bots in that universe to lend a key to it.' }, 403);
    }
    await prisma.aiKeyLend.upsert({
      where: { providerId_universeId: { providerId: id, universeId } },
      create: { providerId: id, universeId },
      update: {},
    });
    return respond(request, { status: 'lent' }, 200);
  } catch (error) {
    // The key was revoked, or the universe deleted, between the checks above and the save
    if ((error as { code?: unknown })?.code === 'P2003') return respond(request, { error: 'Key or universe not found' }, 404);
    console.error('[AiKeys] Lend failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
