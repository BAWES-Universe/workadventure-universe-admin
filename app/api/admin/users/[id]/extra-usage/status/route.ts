import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/admin/users/:id/extra-usage/status?grantKey=... - whether extra usage was saved for this person under that key, and the last word on it.
 * Nothing is ever given here, so an admin who got no answer to a give can find out what became of it without giving it again.
 * Response: { saved: false } or { saved: true, startsAt, endsAt }. Super admins only.
 *
 * The key is looked up as the give stores it (`<person>:<key>`), under the same lock the give holds from before it looks until it is done, so a try still
 * running is waited for and the answer is what it came to. "Not saved" is then final: it is written down (in the same step, under that lock), and a try
 * under that key that only now reaches the server is refused, so the admin who gives again under a new key never ends up with two.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getSessionUser(request);
  if (!viewer || !isSuperAdmin(viewer.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const { id } = await params;
  const given = request.nextUrl.searchParams.get('grantKey');
  if (!given) return NextResponse.json({ error: 'grantKey is required (up to 255 characters)' }, { status: 400 });
  // The key the give stores, with the same length rule: never cut short
  const key = `${id}:${given}`;
  if (key.length > 255) return NextResponse.json({ error: 'grantKey is required (up to 255 characters)' }, { status: 400 });
  try {
    const grant = await prisma.$transaction(
      async (tx) => {
        // Not waited for longer than a give normally takes: a try that holds the key that long makes this answer "could not check", never "not saved"
        await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grant:${key}`}))`;
        const found = await tx.meterGrant.findUnique({ where: { grantKey: key }, select: { personId: true, startsAt: true, endsAt: true } });
        if (found?.personId === id) return found;
        // The last word on that key: nothing was saved, and nothing will be (only for this person's key: it carries the person's id)
        await tx.meterGrantClosedKey.upsert({ where: { grantKey: key }, create: { grantKey: key }, update: {} });
        return null;
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    if (!grant) return NextResponse.json({ saved: false }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ saved: true, startsAt: grant.startsAt.toISOString(), endsAt: grant.endsAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[ExtraUsage] Could not check a give:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
