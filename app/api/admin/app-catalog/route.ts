import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { addCatalogEntry, catalogEntrySchema, listCatalogForAdmin } from '@/lib/app-catalog';

export const runtime = 'nodejs';

async function superAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}
const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/** GET /api/admin/app-catalog - every app on the list a person can connect with one tap (game #2001), on or off. Never its sign-in. */
export async function GET(request: NextRequest) {
  if (!(await superAdmin(request))) return refused();
  try {
    return NextResponse.json({ apps: await listCatalogForAdmin() });
  } catch (error) {
    console.error('[AppCatalog] Could not list:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/app-catalog { key, name, blurb, icon?, serverUrl, authType: oauth | none, authConfig?, headers?, enabled?, sortOrder? }
 * puts an app on the list. Only apps that sign in on their own page, or need no sign-in. 409 when the key is taken.
 */
export async function POST(request: NextRequest) {
  if (!(await superAdmin(request))) return refused();
  const parsed = catalogEntrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, { status: 400 });
  try {
    const added = await addCatalogEntry(parsed.data);
    if (added === 'taken') return NextResponse.json({ error: 'An app with this key is already on the list' }, { status: 409 });
    return NextResponse.json({ app: added }, { status: 201 });
  } catch (error) {
    console.error('[AppCatalog] Could not add:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
