import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { catalogPatchSchema, changeCatalogEntry, removeCatalogEntry } from '@/lib/app-catalog';

export const runtime = 'nodejs';

const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/** PATCH /api/admin/app-catalog/:id { name?, blurb?, icon?, enabled?, sortOrder? } - changes what a person sees, or turns an app off. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  const parsed = catalogPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
  const { id } = await params;
  try {
    const changed = await changeCatalogEntry(id, parsed.data);
    return changed ? NextResponse.json({ app: changed }) : NextResponse.json({ error: 'App not found' }, { status: 404 });
  } catch (error) {
    console.error('[AppCatalog] Could not change:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** DELETE /api/admin/app-catalog/:id - takes it off the list. Connections people already made from it are theirs and keep working. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  const { id } = await params;
  try {
    return (await removeCatalogEntry(id)) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: 'App not found' }, { status: 404 });
  } catch (error) {
    console.error('[AppCatalog] Could not remove:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
