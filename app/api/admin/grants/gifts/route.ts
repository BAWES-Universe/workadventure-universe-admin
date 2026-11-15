import { NextRequest, NextResponse } from 'next/server';
import { createGiftFor, issuerFor } from '@/lib/grants-admin';
import { readBody, readRequest, refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/**
 * POST /api/admin/grants/gifts { grantKey, audience, scope, amountMicros, shared, endsAt, settlement, note?, joinerCap? } - gives credit (super admin): a
 * one-time extra with an end date, "each" or "shared in total". `grantKey` makes it once: the screen makes one when it opens. Credit to be
 * billed says what was agreed; nothing is charged here.
 */
export async function POST(request: NextRequest) {
  const admin = await superAdminOf(request);
  if (!admin) return refuseUnauthorized();
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (typeof body.grantKey !== 'string' || !body.grantKey || body.grantKey.length > 200) return NextResponse.json({ error: 'grantKey is required' }, { status: 400 });
  if (body.settlement !== 'gift' && body.settlement !== 'to_bill') return NextResponse.json({ error: 'settlement must be gift or to_bill' }, { status: 400 });
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return NextResponse.json({ error: 'note must be text' }, { status: 400 });
  const checked = readRequest('gift', body);
  if (!checked.ok || checked.value.what !== 'gift') return NextResponse.json({ error: checked.ok ? 'Invalid request' : checked.error }, { status: 400 });
  try {
    const program = await createGiftFor({ ...checked.value, settlement: body.settlement, note: (body.note as string | null | undefined) ?? null, grantKey: body.grantKey }, issuerFor(admin, true));
    return NextResponse.json({ ok: true, id: program.programId }, { status: 201 });
  } catch (error) {
    return refusal(error) ?? serverError('give the credit', error);
  }
}
