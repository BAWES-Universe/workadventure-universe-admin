import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { bricksOfRoom } from '@/lib/brick-home';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/brick-homes?roomUrl=
 * What the map editor's list of a room's bots shows below today's list (game #2005): the Bricks that live in this room,
 * with those placed by others marked and each with "Take out", and the viewer's own Bricks that can be added here. Only
 * for someone who can manage bots in the room; for anyone else, or an address that is no room, "Room not found".
 * Today's list of room bots (`GET /api/bots?roomId=`) is untouched and never holds a Brick.
 */
export async function GET(request: NextRequest) {
  try {
    const who = await brickOwner(request);
    if (who.response) return who.response;
    const roomUrl = new URL(request.url).searchParams.get('roomUrl')?.trim();
    if (!roomUrl) return brickJson(request, { error: 'roomUrl query parameter is required' }, 400);
    const found = await bricksOfRoom(roomUrl, who.userId);
    return found ? brickJson(request, found) : brickJson(request, { error: 'Room not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error listing the Bricks of a room:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
