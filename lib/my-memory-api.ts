import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { corsHeaders } from '@/lib/cors';
import { ownsBrick } from '@/lib/brick';
import { rememberingOf, type Remembering } from '@/lib/bot-memory-person';

/** An answer for the game, which calls from its own origin. */
export const memoryJson = (request: NextRequest, body: unknown, status = 200) => NextResponse.json(body, { status, headers: corsHeaders(request) });

/**
 * Who is asking what a bot remembers about them (game #2003): a person who is signed in, about themselves. There is no
 * admin token here and no id in the request: a bot's owner, its managers and a super admin read their own list like
 * anyone, and never another person's. A Brick that is not theirs is not there at all, as everywhere else.
 */
export async function myMemoryAuth(request: NextRequest, botId: string): Promise<{ response: NextResponse; who?: undefined } | { response?: undefined; who: Remembering }> {
  const session = await getSessionUser(request);
  if (!session) return { response: memoryJson(request, { error: 'Unauthorized' }, 401) };
  const who = await rememberingOf(session.id);
  if (!who) return { response: memoryJson(request, { error: 'Sign in to see what a bot remembers about you' }, 403) };
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  // A room bot that is gone keeps no list to show; a Brick answers only to its owner
  if (!bot || (bot.roomId === null && !ownsBrick(bot, session.id))) return { response: memoryJson(request, { error: 'Bot not found' }, 404) };
  return { who };
}
