import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { refused, superAdmin } from '@/lib/budget/auth';
import { listChanges } from '@/lib/budget/history';
import { numberById } from '@/lib/budget/numbers';

export const runtime = 'nodejs';

/** GET /api/admin/budget/changes?number=<id>&take=<n> (super admins only): the change history, newest first: who, when, which number, the old value and the new one. */
export async function GET(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const id = request.nextUrl.searchParams.get('number');
  const take = Number(request.nextUrl.searchParams.get('take') ?? 200);
  if (!Number.isInteger(take) || take < 1 || take > 1000) return NextResponse.json({ error: 'take must be a whole number from 1 to 1000' }, { status: 400 });
  const def = id ? numberById(id) : undefined;
  if (id && !def) return NextResponse.json({ error: 'That number is not on this page' }, { status: 404 });
  try {
    const lines = await listChanges({ take, ...(def ? { store: def.store, key: def.key } : {}) });
    const ids = [...new Set(lines.map((line) => line.changedById).filter((value): value is string => !!value))];
    const people = ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(people.map((person) => [person.id, person.name ?? 'A super admin']));
    return NextResponse.json({
      changes: lines.map((line) => {
        const known = numberById(`${line.store}:${line.key}`);
        return { id: line.id, numberId: `${line.store}:${line.key}`, label: known?.label ?? line.key, unit: known?.unit ?? 'count', oldValue: line.oldValue, newValue: line.newValue, by: line.changedById ? (names.get(line.changedById) ?? 'A super admin') : 'Orbit', at: line.changedAt, note: line.note };
      }),
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not read the history:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
