import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { VoiceKeyRefused, pullVoiceKey } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * DELETE /api/me/voice-keys/:id/lend/:universeId - pulls one of the caller's voice keys from a universe. Always the key
 * owner's to do, whatever they can manage there now. Bots there whose voice named the key carry on in text.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; universeId: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const { id, universeId } = await params;
    await pullVoiceKey(user.id, id, universeId);
    return respond(request, { status: 'pulled' });
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Pull failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
