import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { wokaLayersForMany } from '@/lib/woka-avatar';

export const runtime = 'nodejs';

/** How many matches one search shows. A super admin narrows by typing more. */
export const FIND_LIMIT = 8;

/**
 * GET /api/admin/grants/find?kind=people|universes&q=... (super admin only): the people or universes the "Give credit to…" picker
 * offers. A person is a signed-in account, never a guest and never the System account; a universe is any universe, because a super
 * admin gives credit to any universe's members, not only ones they own. Answers `{ results: [{ id, name, woka?, detail? }] }`.
 * Emails are not searched or returned: the picker shows names and Wokas.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get('kind');
  const q = (searchParams.get('q') ?? '').trim().slice(0, 100);
  if (kind !== 'people' && kind !== 'universes') return NextResponse.json({ error: 'kind must be people or universes' }, { status: 400 });
  try {
    if (kind === 'people') {
      const rows = await prisma.user.findMany({
        where: { AND: [NOT_SYSTEM_USER, { isGuest: false }, q ? { name: { contains: q, mode: 'insensitive' } } : {}] },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: FIND_LIMIT,
      });
      const wokas = await wokaLayersForMany(rows.map((row) => row.id)).catch(() => new Map<string, string[]>());
      return NextResponse.json({ results: rows.map((row) => ({ id: row.id, name: row.name?.trim() || 'Someone', woka: wokas.get(row.id) ?? [] })) });
    }
    const rows = await prisma.universe.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : {},
      select: { id: true, name: true, _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
      take: FIND_LIMIT,
    });
    return NextResponse.json({ results: rows.map((row) => ({ id: row.id, name: row.name, detail: `${row._count.members.toLocaleString('en')} ${row._count.members === 1 ? 'member' : 'members'}` })) });
  } catch (error) {
    console.error('[Grants] Could not search:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
