import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { takeCarriedGuestChat } from '@/lib/guest-brick';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/default/guest-chat { guestId }
 * The device that was the guest picks up its chat after signing in (game #1997): it sends the guest id it held, and the
 * answer is { carried: true } once, for a chat handed to this account under that id. Any other device, tab or later ask,
 * and any id that was not handed to this account, gets { carried: false } and takes nothing, so one device attaches the
 * chat and only the device that has it can take it. Only for the person who signed in: nobody asks for someone else.
 */
export async function POST(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { guestId?: unknown }).guestId !== 'string') {
      return brickJson(request, { error: 'guestId is required' }, 400);
    }
    return brickJson(request, await takeCarriedGuestChat(owner.userId, (body as { guestId: string }).guestId));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'guest-brick' } });
    console.error('Error handing over a guest chat:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
