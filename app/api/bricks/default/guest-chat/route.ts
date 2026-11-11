import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { takeCarriedGuestChats } from '@/lib/guest-brick';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bricks/default/guest-chat
 * The guest chats that came to this account when they signed in (game #1997), each given out once: { guestIds: [...] }.
 * The first device that asks gets them; every other device, tab or later ask gets { guestIds: [] }, so one device
 * attaches the chat to the person's one Brick. Empty when nobody talked to the Brick for guests, or when the chat was
 * not picked up in time. Only for the person who signed in: nobody asks for someone else.
 */
export async function POST(request: NextRequest) {
  try {
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    return brickJson(request, { guestIds: await takeCarriedGuestChats(owner.userId) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'guest-brick' } });
    console.error('Error handing over a guest chat:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
