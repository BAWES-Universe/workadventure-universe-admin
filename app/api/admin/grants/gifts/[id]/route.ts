import { NextRequest, NextResponse } from 'next/server';
import { endGift, issuerFor, markGiftBilled } from '@/lib/grants-admin';
import { readBody, refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/**
 * PATCH /api/admin/grants/gifts/:id { action: end | billed } (super admin): "End it now" stops a gift from reaching anyone new (what was given and
 * what was used stay as they are); "Mark as billed" says credit that was to be billed was. A gift is never owed, so it cannot be marked.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await superAdminOf(request);
  if (!admin) return refuseUnauthorized();
  const { id } = await params;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  try {
    if (body.action === 'end') {
      const result = await endGift(id, issuerFor(admin, true));
      if (result === 'not_found') return NextResponse.json({ error: 'That gift was not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'billed') {
      const result = await markGiftBilled(id);
      if (result === 'not_found') return NextResponse.json({ error: 'That gift was not found' }, { status: 404 });
      if (result === 'nothing_yet') return NextResponse.json({ error: 'Nothing has been given yet, so there is nothing to mark billed' }, { status: 400 });
      if (result === 'not_billable') return NextResponse.json({ error: 'A gift is never owed, so it cannot be marked billed' }, { status: 400 });
      return NextResponse.json({ ok: true, alreadyBilled: result === 'already_billed' });
    }
    return NextResponse.json({ error: 'action must be end or billed' }, { status: 400 });
  } catch (error) {
    return refusal(error) ?? serverError('change the gift', error);
  }
}
