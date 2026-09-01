import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionData, getSessionId } from '@/lib/auth-token';
import { isSuperAdmin } from '@/lib/super-admin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sessionId = getSessionId(request);
  const session = sessionId ? await getSessionData(sessionId) : null;
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const [user, universes, worlds, rooms, users, defaultUniverse, defaultWorld, defaultRoom, systemUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, uuid: true, email: true, name: true },
    }),
    prisma.universe.count(),
    prisma.world.count(),
    prisma.room.count(),
    prisma.user.count(),
    prisma.universe.findUnique({ where: { slug: 'default' }, select: { id: true } }),
    prisma.world.findFirst({ where: { slug: 'default', universe: { slug: 'default' } }, select: { id: true } }),
    prisma.room.findFirst({ where: { slug: 'default', world: { slug: 'default', universe: { slug: 'default' } } }, select: { id: true } }),
    prisma.user.findUnique({ where: { email: 'system@workadventure.local' }, select: { id: true } }),
  ]);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const response = NextResponse.json({
    version: 1,
    user: { ...user, tags: session.tags, isSuperAdmin: isSuperAdmin(user.email) },
    stats: {
      universes: Math.max(0, universes - (defaultUniverse ? 1 : 0)),
      worlds: Math.max(0, worlds - (defaultWorld ? 1 : 0)),
      rooms: Math.max(0, rooms - (defaultRoom ? 1 : 0)),
      users: Math.max(0, users - (systemUser ? 1 : 0)),
    },
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
