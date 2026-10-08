import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from './auth';
import { FriendsError } from './friends';

/**
 * Wraps a friends service route. These are called by the game's pusher with ADMIN_API_TOKEN, on behalf of
 * the signed-in player it names in `userUuid`; never from a browser.
 */
export function friendsRoute(name: string, handler: (request: NextRequest) => Promise<unknown>) {
  return async (request: NextRequest) => {
    try {
      requireAuth(request);
      const body = await handler(request);
      return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (error instanceof FriendsError) {
        return NextResponse.json({ error: error.code }, { status: error.status });
      }
      console.error(`Error in ${name}:`, error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

/** The JSON object body, or a 400. */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new FriendsError('invalid_json', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FriendsError('expected_object', 400);
  return body as Record<string, unknown>;
}

export function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
