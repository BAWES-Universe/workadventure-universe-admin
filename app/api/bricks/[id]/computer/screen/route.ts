import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { screenTicket } from '@/lib/computer-screen';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/screen   { mode?: "watch" | "input" }
 * A ticket for the screen of the owner's own computer, to be opened on the bot server's screen address within 60 seconds. Watch is the
 * default; input is only for the person who has taken over. It only looks and never wakes a machine: a computer that rests answers
 * `resting`, and input without a take over answers `not_taken_over`.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
    if (body?.mode !== undefined && body.mode !== 'watch' && body.mode !== 'input') return brickJson(request, { error: 'mode is watch or input' }, 400);
    const ticket = await screenTicket(id, ownerId, body?.mode === 'input' ? 'input' : 'watch');
    if (ticket.ok) return brickJson(request, { ticket: ticket.ticket, mode: ticket.mode, expiresAt: ticket.expiresAt });
    if (ticket.reason === 'not_found') return notFound(request);
    if (ticket.reason === 'not_taken_over') return brickJson(request, { error: 'The screen is only yours to use after you take over', notTakenOver: true }, 409);
    return brickJson(request, { error: 'Its computer is resting', resting: true }, 409);
  });
