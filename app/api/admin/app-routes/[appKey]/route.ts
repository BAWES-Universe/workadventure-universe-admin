import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { APP_ROUTES, saveRoute } from '@/lib/app-routes';

export const runtime = 'nodejs';

const bodySchema = z.object({ route: z.enum(APP_ROUTES), expectedVersion: z.number().int().min(0) }).strict();

/**
 * PUT /api/admin/app-routes/:appKey { route: 'composio' | 'universe', expectedVersion } - where an App runs (spec section 21).
 * Moving to our own version needs it to be there and to have passed its checks (409 `not_ready` says what is missing); a save
 * made on a view that is out of date is refused (409 `stale`, with the newer state). Applies to runs that start after it. Super
 * admins only. People see no change.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ appKey: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, { status: 400 });
  try {
    const { appKey } = await params;
    const outcome = await saveRoute({ appKey, route: parsed.data.route, expectedVersion: parsed.data.expectedVersion, userId: user.id });
    switch (outcome.status) {
      case 'saved':
        return NextResponse.json({ route: outcome.state.route, version: outcome.state.version, changedAt: outcome.state.changedAt?.toISOString() ?? null });
      case 'unknown_app':
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'not_ready':
        return NextResponse.json({ error: 'Our own version of this App is not ready to run it yet', code: 'not_ready', why: outcome.why }, { status: 409 });
      case 'stale':
        return NextResponse.json({ error: 'This App was moved since you opened it', code: 'stale', route: outcome.state.route, version: outcome.state.version }, { status: 409 });
    }
  } catch (error) {
    console.error('[Apps route] Could not save:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
