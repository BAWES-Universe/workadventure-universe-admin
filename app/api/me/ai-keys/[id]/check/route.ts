import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { checkAndRecord } from '@/lib/ai-key-health';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/ai-keys/:id/check - "Check now": asks the key's provider if it answers, marks the key Working or Down
 * from the answer (a provider that is only busy changes nothing), and says which, with a plain sentence when it is down (#374). Only the key's owner can; anyone else
 * gets the same "not found" as for a key that does not exist.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  try {
    const key = await prisma.botsAiProvider.findFirst({
      where: { providerId: id, ownerId: user.id },
      select: { providerId: true, name: true, ownerId: true, endpoint: true, apiKeyEncrypted: true, settings: true, downSince: true, ifDown: true, healthCheckedAt: true },
    });
    if (!key) return respond(request, { error: 'Key not found' }, 404);
    if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const result = await checkAndRecord(key);
    if (!result.ok && 'busy' in result) return respond(request, { status: 'busy', message: `${result.message} ${key.name} stays as it is.` });
    return respond(request, result.ok ? { status: 'working' } : { status: 'down', message: result.message });
  } catch (error) {
    console.error('[AiKeys] Check failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
