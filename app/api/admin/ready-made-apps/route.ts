import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { adapterIsOn } from '@/lib/app-adapter';
import { readReadyMadeApps, readyMadeSettingsSchema, saveReadyMadeApps } from '@/lib/app-adapter/settings';

export const runtime = 'nodejs';

async function superAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}
const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
const off = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

/** GET /api/admin/ready-made-apps - the ready-made apps and the adapter's sign-in setup id for each. 404 while the adapter is off. */
export async function GET(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  if (!adapterIsOn()) return off();
  return NextResponse.json({ apps: await readReadyMadeApps() });
}

/** PUT /api/admin/ready-made-apps { apps: { [key]: { name, authConfigId, enabled? } | null } } - sets or removes entries. 404 while the adapter is off. */
export async function PUT(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  if (!adapterIsOn()) return off();
  const parsed = readyMadeSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, { status: 400 });
  try {
    return NextResponse.json({ apps: await saveReadyMadeApps(parsed.data, user.id) });
  } catch (error) {
    console.error('[ReadyMade] Could not save:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
