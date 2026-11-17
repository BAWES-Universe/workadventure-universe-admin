import { NextRequest } from 'next/server';
import { asBotServer, bodyOf } from '@/lib/guest-brick-api';
import { claimGuestBrickReply } from '@/lib/guest-brick';

/**
 * POST /api/guest-brick/replies
 * May this guest get one more reply from the Brick for guests now (game #1997)? Asked by the bot server before each model
 * call for a guest's own message, never for the hello. When it can, the reply is counted at once.
 * Body: { guestId: the guest's id, turnId: one id per try, roomUrl: the room they are in }.
 * Response: { allowed: true, turnId, counted }, or { allowed: false, limit: "guest" | "universe", resetsAt } for the fixed
 * line that says it can carry on after signing in or later. No model call is made for that line.
 *
 * Its own allowance and its own pool per universe, both set in Limits (Bricks). Nothing here is counted in a guest's
 * Universe AI replies for a host's bots, and nothing is taken from a host bot's guest pool.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  return asBotServer(request, async () => claimGuestBrickReply(await bodyOf(request)));
}
