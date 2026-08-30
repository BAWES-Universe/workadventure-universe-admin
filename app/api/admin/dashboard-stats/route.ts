import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    await requireSession(request);
    const [universes, worlds, rooms, users] = await Promise.all([
      prisma.universe.count({ where: { slug: { not: 'default' } } }),
      prisma.world.count({ where: { slug: { not: 'default' } } }),
      prisma.room.count({ where: { slug: { not: 'default' } } }),
      prisma.user.count({ where: { email: { not: 'system@workadventure.local' } } }),
    ]);
    return NextResponse.json({ universes, worlds, rooms, users });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
