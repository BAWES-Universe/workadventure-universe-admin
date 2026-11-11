import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { corsHeaders } from '@/lib/cors';

/** An answer for the game, which calls from its own origin. */
export const brickJson = (request: NextRequest, body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: corsHeaders(request) });

/**
 * Who is asking about their own Bricks (game #1995): a person who is signed in. A Brick belongs to an account, so a
 * guest has none (the Brick for guests is its own thing, game #1997), and nobody asks on someone else's behalf: there is
 * no admin token here, and a super admin gets their own Bricks like anyone.
 */
export async function brickOwner(request: NextRequest): Promise<{ response: NextResponse; userId?: undefined } | { response?: undefined; userId: string }> {
  const session = await getSessionUser(request);
  if (!session) return { response: brickJson(request, { error: 'Unauthorized' }, 401) };
  const account = await prisma.user.findUnique({ where: { id: session.id }, select: { isGuest: true } });
  if (!account || account.isGuest) return { response: brickJson(request, { error: 'Sign in to have a Brick' }, 403) };
  return { userId: session.id };
}
