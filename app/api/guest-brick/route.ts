import { NextRequest } from 'next/server';
import { asBotServer } from '@/lib/guest-brick-api';
import { guestBrickFor } from '@/lib/guest-brick';

/**
 * GET /api/guest-brick?roomUrl=...
 * The Brick for guests (game #1997), for the room a guest is in: what it is and what steers it (with the place added),
 * the place it is in, and how it talks to its AI. It is Universe's own, the same in every universe, and it has no bot
 * row: nothing is created for a guest, and there is no switch for a host.
 *
 * It runs on Universe AI. The credentials are Universe AI's and are never a host's key or a host bot's.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  return asBotServer(request, () => guestBrickFor(new URL(request.url).searchParams.get('roomUrl')));
}
