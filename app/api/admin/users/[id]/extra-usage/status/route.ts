import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/admin/users/:id/extra-usage/status?grantKey=... - whether extra usage was saved for this person under the key the sheet sent. A read only:
 * nothing is created, so an admin who got no answer to a give can find out what became of it without giving it again.
 * Response: { saved: false } or { saved: true, startsAt, endsAt }. Super admins only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getSessionUser(request);
  if (!viewer || !isSuperAdmin(viewer.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const { id } = await params;
  const sent = request.nextUrl.searchParams.get('grantKey');
  // The grant is saved under the person's id and the key the sheet sent (see the POST route), so that is what is looked up; the 255
  // limit is on the stored key, the same one that route applies
  const key = sent ? `${id}:${sent}` : null;
  if (!sent || !key || key.length > 255) return NextResponse.json({ error: 'grantKey is required (up to 255 characters)' }, { status: 400 });
  try {
    const grant = await prisma.meterGrant.findUnique({ where: { grantKey: key }, select: { personId: true, startsAt: true, endsAt: true } });
    // A key somebody else's grant was saved under says nothing about this person
    if (!grant || grant.personId !== id) return NextResponse.json({ saved: false }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ saved: true, startsAt: grant.startsAt.toISOString(), endsAt: grant.endsAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[ExtraUsage] Could not check a give:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
