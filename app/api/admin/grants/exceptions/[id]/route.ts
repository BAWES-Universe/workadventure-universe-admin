import { NextRequest, NextResponse } from 'next/server';
import { endException, issuerFor } from '@/lib/grants-admin';
import { refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/** DELETE /api/admin/grants/exceptions/:id - ends an exception (super admin): its people go back to the defaults. Credit already given stays. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await superAdminOf(request);
  if (!admin) return refuseUnauthorized();
  const { id } = await params;
  try {
    const result = await endException(id, issuerFor(admin, true));
    if (result === 'not_found') return NextResponse.json({ error: 'That exception was not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return refusal(error) ?? serverError('end the exception', error);
  }
}
